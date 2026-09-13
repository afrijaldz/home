import { describe, expect, test } from "bun:test";
import type { Holding } from "@/shared/balances/types";
import { createBalancesService } from "./coalesce";
import { MemoryBalanceSnapshotStore } from "./memory-snapshot-store";
import type { BalanceObservation } from "./snapshot-store";
import type { BalancesEnumeration, BalancesRead, ReadHolding } from "./types";

const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const observedAt = "2026-09-13T12:00:00.000Z";
const registry: ReadHolding = {
  key: "eip155:8453/native",
  id: "eth",
  kind: "native",
  source: "registry",
  name: "Ethereum",
  symbol: "ETH",
  decimals: 18,
  contractAddress: null,
  cashCurrency: null,
  balance: { status: "ready", baseUnits: "1" },
};
const catalog: ReadHolding = {
  key: "eip155:8453/erc20:0x1111111111111111111111111111111111111111",
  id: "catalog:0x1111111111111111111111111111111111111111",
  kind: "erc20",
  source: "catalog",
  name: "Catalog",
  symbol: "CAT",
  decimals: 18,
  contractAddress: "0x1111111111111111111111111111111111111111",
  cashCurrency: null,
  balance: { status: "ready", baseUnits: "2" },
};

function read(number = "10", at = observedAt, holdings: ReadHolding[] = [registry, catalog]): BalancesRead {
  return {
    block: { number, hash: `0x${number.padStart(64, "0")}`, timestamp: number },
    observedAt: at,
    holdings,
    coverage: { registry: "complete", catalog: "complete" },
  };
}

function observation(overrides: Partial<BalanceObservation> = {}): BalanceObservation {
  const value = read();
  return {
    chainId: 8453,
    address: owner,
    blockNumber: value.block.number,
    blockHash: value.block.hash,
    blockTimestamp: value.block.timestamp,
    observedAt: value.observedAt,
    holdings: value.holdings,
    coverage: value.coverage,
    ...overrides,
  };
}

function priced(rows: BalancesRead["holdings"]): Holding[] {
  return rows.map((holding) => ({
    key: holding.key,
    id: holding.id,
    kind: holding.kind,
    source: holding.source,
    name: holding.name,
    symbol: holding.symbol,
    decimals: holding.decimals,
    contractAddress: holding.contractAddress,
    cashCurrency: holding.cashCurrency,
    balance: holding.balance,
    value: { status: "unpriced", reason: "price-unavailable" },
  }));
}

function setup(options: {
  store?: MemoryBalanceSnapshotStore;
  now?: string;
  registryRead?: () => Promise<BalancesRead>;
  enumerate?: () => Promise<BalancesEnumeration>;
}) {
  const store = options.store ?? new MemoryBalanceSnapshotStore();
  let reads = 0;
  let enumerations = 0;
  const service = createBalancesService({
    store,
    now: () => new Date(options.now ?? "2026-09-13T12:00:30.000Z"),
    readUniverse: async () => ({ entries: [] }),
    readBalances: async () => {
      reads += 1;
      return options.registryRead?.() ?? read("11", "2026-09-13T12:00:30.000Z", [registry]);
    },
    enumerateBalances: async () => {
      enumerations += 1;
      return options.enumerate?.() ?? { status: "complete", rows: [] };
    },
    resolveBalances: async (registryRead, enumeration) => ({
      ...registryRead,
      holdings: enumeration.status === "unavailable"
        ? registryRead.holdings
        : [...registryRead.holdings, catalog],
      coverage: {
        registry: registryRead.coverage.registry,
        catalog: enumeration.status === "unavailable" ? "unavailable" : "complete",
      },
    }),
    priceBalances: async (value) => priced(value.holdings),
  });
  return { store, service, reads: () => reads, enumerations: () => enumerations };
}

describe("balance observations", () => {
  test("serves a fresh row with fetchedAt equal to observedAt", async () => {
    const fixture = setup({});
    await fixture.store.putObservation(observation());
    const snapshot = await fixture.service(owner, "US");
    expect(snapshot.fetchedAt).toBe(observedAt);
    expect(snapshot.stale).toBeUndefined();
    expect(fixture.reads()).toBe(0);
    expect(fixture.enumerations()).toBe(0);
  });

  test("hot rows re-read registry only and retain catalog rows", async () => {
    const fixture = setup({});
    await fixture.store.putObservation(observation());
    await fixture.store.markHot(8453, owner, new Date("2026-09-13T12:01:00.000Z"));
    const snapshot = await fixture.service(owner, "US");
    expect(fixture.reads()).toBe(1);
    expect(fixture.enumerations()).toBe(0);
    expect(snapshot.holdings.map((holding) => holding.source)).toEqual(["registry", "catalog"]);
    expect(snapshot.fetchedAt).toBe("2026-09-13T12:00:30.000Z");
  });

  test("a stale mark causes a full re-observe", async () => {
    const fixture = setup({});
    await fixture.store.putObservation(observation());
    await fixture.store.markStale(8453, owner, new Date("2026-09-13T12:00:20.000Z"));
    await fixture.service(owner, "US");
    expect(fixture.reads()).toBe(1);
    expect(fixture.enumerations()).toBe(1);
  });

  test("the 120 second backstop causes a full re-observe", async () => {
    const fixture = setup({ now: "2026-09-13T12:02:01.000Z" });
    await fixture.store.putObservation(observation());
    await fixture.service(owner, "US");
    expect(fixture.reads()).toBe(1);
    expect(fixture.enumerations()).toBe(1);
  });

  test("failed required re-observe serves the prior row stale with unchanged coverage", async () => {
    const fixture = setup({
      registryRead: async () => { throw new Error("rpc unavailable"); },
    });
    await fixture.store.putObservation({
      ...observation(),
      coverage: { registry: "partial", catalog: "incomplete" },
    });
    await fixture.store.markStale(8453, owner, new Date("2026-09-13T12:00:20.000Z"));
    const snapshot = await fixture.service(owner, "US");
    expect(snapshot.stale).toBeTrue();
    expect(snapshot.coverage).toEqual({ registry: "partial", catalog: "incomplete" });
    expect(snapshot.fetchedAt).toBe(observedAt);
  });

  test("failed initial observation rejects so the route can return 502", async () => {
    const fixture = setup({
      registryRead: async () => { throw new Error("rpc unavailable"); },
    });
    await expect(fixture.service(owner, "US")).rejects.toThrow("rpc unavailable");
  });

  test("dropping a row makes the next read re-observe", async () => {
    const fixture = setup({});
    await fixture.store.putObservation(observation());
    await fixture.service(owner, "US");
    fixture.store.deleteForTests(8453, owner);
    await fixture.service(owner, "US");
    expect(fixture.reads()).toBe(1);
    expect(fixture.enumerations()).toBe(1);
  });

  test("shares one in-flight observation across regions", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = setup({
      registryRead: async () => { await gate; return read("11", "2026-09-13T12:00:30.000Z", [registry]); },
    });
    const first = fixture.service(owner, "US");
    const second = fixture.service(owner, "DE");
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(fixture.reads()).toBe(1);
    expect(fixture.enumerations()).toBe(1);
  });
});
