import "server-only";

import { beforeEach, describe, expect, test } from "bun:test";
import type { BalanceObservation, BalanceSnapshotStore } from "./snapshot-store";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;

export function balanceSnapshotStoreContract(options: {
  name: string;
  createStore: () => BalanceSnapshotStore;
  reset: () => Promise<void> | void;
}) {
  describe(`${options.name} BalanceSnapshotStore contract`, () => {
    let store: BalanceSnapshotStore;
    beforeEach(async () => {
      await options.reset();
      store = options.createStore();
    });

    test("newer observations never lose to older blocks", async () => {
      expect(await store.putObservation(observation("10", "2026-09-13T12:00:10.000Z"))).toBeTrue();
      expect(await store.putObservation(observation("12", "2026-09-13T12:00:12.000Z"))).toBeTrue();
      expect(await store.putObservation(observation("11", "2026-09-13T12:00:30.000Z"))).toBeFalse();
      expect(await store.get(8453, ADDRESS)).toMatchObject({
        blockNumber: "12",
        observedAt: "2026-09-13T12:00:12.000Z",
      });
    });

    test("equal-block observations may replace enrichment without clearing signals", async () => {
      await store.putObservation(observation("10", "2026-09-13T12:00:10.000Z"));
      await store.markStale(8453, ADDRESS, new Date("2026-09-13T12:00:11.000Z"));
      await store.markHot(8453, ADDRESS, new Date("2026-09-13T12:01:10.000Z"));
      expect(await store.putObservation({
        ...observation("10", "2026-09-13T12:00:12.000Z"),
        coverage: { registry: "partial", catalog: "incomplete" },
      })).toBeTrue();
      expect(await store.get(8453, ADDRESS)).toMatchObject({
        staleAt: "2026-09-13T12:00:11.000Z",
        hotUntil: "2026-09-13T12:01:10.000Z",
        coverage: { registry: "partial", catalog: "incomplete" },
      });
    });

    test("signal writers touch only their column", async () => {
      await store.putObservation(observation("10", "2026-09-13T12:00:10.000Z"));
      const original = (await store.get(8453, ADDRESS))!;
      await store.markStale(8453, ADDRESS, new Date("2026-09-13T12:00:20.000Z"));
      const stale = (await store.get(8453, ADDRESS))!;
      expect(stale).toEqual({ ...original, staleAt: "2026-09-13T12:00:20.000Z" });
      await store.markHot(8453, ADDRESS, new Date("2026-09-13T12:01:20.000Z"));
      expect(await store.get(8453, ADDRESS)).toEqual({
        ...stale,
        hotUntil: "2026-09-13T12:01:20.000Z",
      });
    });

    test("signals no-op when no observation row exists", async () => {
      await store.markStale(8453, OTHER, new Date("2026-09-13T12:00:20.000Z"));
      await store.markHot(8453, OTHER, new Date("2026-09-13T12:01:20.000Z"));
      expect(await store.get(8453, OTHER)).toBeNull();
    });
  });
}

function observation(blockNumber: string, observedAt: string): BalanceObservation {
  return {
    chainId: 8453,
    address: ADDRESS,
    blockNumber,
    blockHash: `0x${blockNumber.padStart(64, "0")}`,
    blockTimestamp: blockNumber,
    observedAt,
    holdings: [],
    coverage: { registry: "complete", catalog: "complete" },
  };
}
