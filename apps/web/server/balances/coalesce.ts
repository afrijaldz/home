import "server-only";

import type { PortfolioAddress } from "@/config/portfolio-assets";
import type { RegionId } from "@/config/regions";
import {
  BALANCES_CHAIN_ID,
  type BalancesSnapshot,
  type Holding,
} from "@/shared/balances/types";
import { enumerateBalances as defaultEnumerateBalances } from "./enumerate";
import { priceBalances as defaultPriceBalances } from "./price";
import { readBalances as defaultReadBalances } from "./read";
import { resolveBalances as defaultResolveBalances } from "./resolve";
import { assembleBalancesSnapshot } from "./snapshot";
import { emitServerEvent } from "@/server/observability/log";
import {
  getBalanceSnapshotStore,
  type BalanceSnapshotRow,
  type BalanceSnapshotStore,
} from "./snapshot-store";
import type {
  BalancesEnumeration,
  BalancesRead,
  BalancesUniverse,
} from "./types";
import { getBalancesUniverse } from "./universe";

export const BALANCES_BACKSTOP_MS = 120_000;

type Dependencies = {
  store?: BalanceSnapshotStore;
  readUniverse?: () => Promise<BalancesUniverse>;
  enumerateBalances?: (
    owner: PortfolioAddress,
    signal?: AbortSignal,
  ) => Promise<BalancesEnumeration>;
  readBalances?: (
    universe: BalancesUniverse,
    owner: PortfolioAddress,
    signal?: AbortSignal,
  ) => Promise<BalancesRead>;
  resolveBalances?: (
    read: BalancesRead,
    enumeration: BalancesEnumeration,
  ) => Promise<BalancesRead>;
  priceBalances?: (read: BalancesRead, region: RegionId) => Promise<Holding[]>;
  now?: () => Date;
  backstopMs?: number;
};

type ObservedResult = { read: BalancesRead; stale: boolean };

/** Persistent observation selection with per-instance, per-owner in-flight dedupe. */
export function createBalancesService(dependencies: Dependencies = {}) {
  const store = dependencies.store ?? getBalanceSnapshotStore();
  const readUniverse = dependencies.readUniverse ?? getBalancesUniverse;
  const enumerateBalances = dependencies.enumerateBalances ?? defaultEnumerateBalances;
  const readBalances = dependencies.readBalances ?? defaultReadBalances;
  const resolveBalances = dependencies.resolveBalances ?? defaultResolveBalances;
  const priceBalances = dependencies.priceBalances ?? defaultPriceBalances;
  const now = dependencies.now ?? (() => new Date());
  const backstopMs = dependencies.backstopMs ?? BALANCES_BACKSTOP_MS;
  const inFlight = new Map<string, Promise<ObservedResult>>();

  async function getObserved(owner: PortfolioAddress): Promise<ObservedResult> {
    const address = owner.toLowerCase() as PortfolioAddress;
    const existing = inFlight.get(address);
    if (existing) return existing;
    const pending = selectObservation(address).finally(() => {
      if (inFlight.get(address) === pending) inFlight.delete(address);
    });
    inFlight.set(address, pending);
    return pending;
  }

  async function selectObservation(owner: PortfolioAddress): Promise<ObservedResult> {
    let row: BalanceSnapshotRow | null = null;
    try {
      row = await store.get(BALANCES_CHAIN_ID, owner);
    } catch {
      observeStoreFailure("BALANCE_STORE_READ_FAILED");
    }
    const current = now();
    const hot = row !== null && (
      (Boolean(row.hotUntil) && Date.parse(row.hotUntil!) > current.getTime()) ||
      row.coverage.registry === "partial"
    );
    const signaled = row !== null && (
      (Boolean(row.staleAt) && Date.parse(row.staleAt!) > Date.parse(row.observedAt)) ||
      row.coverage.catalog === "unavailable"
    );
    const expired = row !== null &&
      current.getTime() - Date.parse(row.observedAt) > backstopMs;

    if (row && !hot && !signaled && !expired) {
      return { read: readFromRow(row), stale: false };
    }

    try {
      const observed = hot && row && !signaled && !expired
        ? await observeRegistryOnly(owner, row)
        : await observeFull(owner);
      try {
        const wrote = await store.putObservation(observationFromRead(owner, observed));
        if (!wrote) {
          try {
            const winner = await store.get(BALANCES_CHAIN_ID, owner);
            if (winner) return { read: readFromRow(winner), stale: false };
          } catch {
            observeStoreFailure("BALANCE_STORE_READ_FAILED");
          }
        }
      } catch {
        observeStoreFailure("BALANCE_STORE_WRITE_FAILED");
      }
      return { read: observed, stale: false };
    } catch (error) {
      if (!row) throw error;
      return { read: readFromRow(row), stale: true };
    }
  }

  async function observeFull(owner: PortfolioAddress): Promise<BalancesRead> {
    const universe = await readUniverse();
    const [registryRead, enumeration] = await Promise.all([
      readBalances(universe, owner),
      enumerateBalances(owner),
    ]);
    return resolveBalances(registryRead, enumeration);
  }

  async function observeRegistryOnly(
    owner: PortfolioAddress,
    row: BalanceSnapshotRow,
  ): Promise<BalancesRead> {
    const universe = await readUniverse();
    const registryRead = await readBalances(universe, owner);
    const withEnrichment = await resolveBalances(registryRead, {
      status: "unavailable",
      rows: [],
    });
    return {
      ...withEnrichment,
      holdings: [
        ...withEnrichment.holdings.filter((holding) => holding.source === "registry"),
        ...row.holdings.filter((holding) => holding.source !== "registry"),
      ],
      coverage: {
        registry: withEnrichment.coverage.registry,
        catalog: row.coverage.catalog,
      },
    };
  }

  return async function getBalancesSnapshot(
    owner: PortfolioAddress,
    region: RegionId,
    signal?: AbortSignal,
  ): Promise<BalancesSnapshot> {
    void signal;
    const observed = await getObserved(owner);
    const holdings = await priceBalances(observed.read, region);
    return assembleBalancesSnapshot({
      owner,
      region,
      read: observed.read,
      holdings,
      stale: observed.stale,
    });
  };
}

export const getBalancesSnapshot = createBalancesService();

function observationFromRead(
  owner: PortfolioAddress,
  read: BalancesRead,
) {
  return {
    chainId: BALANCES_CHAIN_ID,
    address: owner.toLowerCase() as `0x${string}`,
    blockNumber: read.block.number,
    blockHash: read.block.hash,
    blockTimestamp: read.block.timestamp,
    observedAt: read.observedAt,
    holdings: read.holdings,
    coverage: read.coverage,
  };
}

function observeStoreFailure(code: "BALANCE_STORE_READ_FAILED" | "BALANCE_STORE_WRITE_FAILED"): void {
  emitServerEvent("balances-store", {
    route: "/api/balances",
    code,
    outcome: "unavailable",
    durationMs: 0,
  });
}

function readFromRow(row: BalanceSnapshotRow): BalancesRead {
  return {
    block: {
      number: row.blockNumber,
      hash: row.blockHash,
      timestamp: row.blockTimestamp,
    },
    observedAt: row.observedAt,
    holdings: row.holdings,
    coverage: row.coverage,
  };
}
