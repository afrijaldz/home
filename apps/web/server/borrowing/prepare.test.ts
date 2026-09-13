import { describe, expect, test } from "bun:test";
import { DEFAULT_BORROW_MARKET, BORROW_HEALTH_FLOOR_WAD } from "@/shared/borrowing/config";
import type { BorrowMarketSnapshot } from "@/shared/borrowing/contract";
import type { BorrowActionIntent } from "@/shared/borrowing/types";
import { ORACLE_PRICE_SCALE } from "./math";
import { BorrowPreparationError, prepareBorrowAction } from "./prepare";
import type { BorrowRpcReader } from "./rpc";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const BLOCK_HASH = `0x${"ab".repeat(32)}` as const;
const market = DEFAULT_BORROW_MARKET;

function snapshot(overrides: Partial<BorrowMarketSnapshot["position"]> = {}, wallet: Partial<BorrowMarketSnapshot["wallet"]> = {}): BorrowMarketSnapshot {
  const oraclePrice = BigInt("80000") * ORACLE_PRICE_SCALE * BigInt("1000000") / BigInt("100000000");
  return {
    version: "1", chainId: 8453, walletAddress: OWNER,
    market: { id: market.marketId, morpho: market.morpho, loanToken: market.loanToken, collateralToken: market.collateralToken, oracle: market.oracle, irm: market.irm, lltvWad: market.lltvWad.toString(), rank: market.rank },
    eligibility: { mode: "enabled", newRisk: true, reason: null },
    source: { provider: "Base JSON-RPC", blockNumber: "100", blockHash: BLOCK_HASH, blockTimestamp: "1788897600", fetchedAt: "2026-09-13T12:00:00.000Z" },
    state: { oraclePriceRaw: oraclePrice.toString(), borrowRatePerSecondWad: "0", borrowAprWad: "0", totalSupplyAssetsRaw: "1000000000000", totalBorrowAssetsRaw: "500000000000", totalBorrowSharesRaw: "500000000000", liquidityAssetsRaw: "500000000000", lastUpdateTimestamp: "1788897500" },
    wallet: { collateralBalanceRaw: "10000000", loanBalanceRaw: "1000000000", collateralAllowanceRaw: "0", loanAllowanceRaw: "0", ...wallet },
    position: { collateralRaw: "1000000", borrowSharesRaw: "100000000", debtAssetsRaw: "100000000", rawBorrowCapacityAssetsRaw: "588000000", borrowCapacityAssetsRaw: "450000000", rawWithdrawableCollateralRaw: "800000", withdrawableCollateralRaw: "750000", healthFactorWad: "6880000000000000000", liquidationPriceRaw: "116279069767441860465116279069767441861", ...overrides },
  };
}
function fixture() {
  const batches: Array<readonly { to: string; data: string; approval?: unknown }[]> = [];
  const rpc: BorrowRpcReader = {
    readSnapshot: async () => snapshot(),
    simulateBatch: async (calls) => { batches.push(calls); },
  };
  return { rpc, batches };
}
async function prepare(request: BorrowActionIntent, next = snapshot()) {
  const f = fixture();
  const result = await prepareBorrowAction({ request, market, snapshot: next, rpc: f.rpc, now: () => new Date("2026-09-13T12:00:00.000Z") });
  return { result, ...f };
}

describe("generic borrow action preparation", () => {
  test.each([
    ["supply-collateral", { marketId: market.marketId, operation: "supply-collateral", amountBaseUnits: "1000000" }, "supply-collateral", 2],
    ["borrow", { marketId: market.marketId, operation: "borrow", amountBaseUnits: "25000000" }, "borrow", 1],
    ["repay", { marketId: market.marketId, operation: "repay", amountBaseUnits: "10000000" }, "repay", 2],
    ["withdraw", { marketId: market.marketId, operation: "withdraw-collateral", amountBaseUnits: "1000" }, "withdraw-collateral", 1],
  ] as const)("builds and simulates %s with server-derived authority", async (_label, request, kind, callCount) => {
    const { result, batches } = await prepare(request);
    expect(result.draft.kind).toBe(kind);
    expect(result.draft.calls).toHaveLength(callCount);
    expect(batches).toHaveLength(1);
    expect(result.draft.metadata).toMatchObject({ product: "borrow", operation: request.operation, marketId: market.marketId });
    expect(JSON.stringify(request)).not.toContain("snapshotBlockHash");
    const ownerWord = OWNER.slice(2).padStart(64, "0");
    expect(result.draft.calls.at(-1)!.data).toContain(ownerWord);
  });

  test("opens atomically with exact collateral approval, supply, then borrow", async () => {
    const { result } = await prepare({ marketId: market.marketId, operation: "supply-and-borrow", collateralAmountBaseUnits: "1000000", amountBaseUnits: "25000000" });
    expect(result.draft.kind).toBe("borrow");
    expect(result.draft.calls.map((call) => call.data.slice(0, 10))).toEqual(["0x095ea7b3", "0x238d6579", "0x50d8cd4b"]);
    expect(result.draft.amounts.map(({ direction }) => direction)).toEqual(["spend", "receive"]);
  });

  test("closes atomically with a finite exact approval, share repayment, and verified collateral withdrawal", async () => {
    const { result } = await prepare({ marketId: market.marketId, operation: "close-position", maximumRepayBaseUnits: "125000000" });
    expect(result.draft.kind).toBe("repay");
    expect(result.draft.calls.map((call) => call.data.slice(0, 10))).toEqual(["0x095ea7b3", "0x20b76e81", "0x8720316d"]);
    expect(result.draft.amounts).toEqual([
      expect.objectContaining({ amountBaseUnits: "100000000", estimated: true }),
      expect.objectContaining({ amountBaseUnits: "125000000", maximum: true }),
      expect.objectContaining({ amountBaseUnits: "1000000", direction: "receive" }),
    ]);
  });

  test("uses one exact approval and never emits approve(0)", async () => {
    const { result } = await prepare({ marketId: market.marketId, operation: "repay-all", maximumRepayBaseUnits: "125000000" }, snapshot({}, { loanAllowanceRaw: "500000000" }));
    expect(result.draft.calls[0].data.slice(0, 10)).toBe("0x095ea7b3");
    expect(result.draft.calls[0].data.endsWith(BigInt("125000000").toString(16).padStart(64, "0"))).toBe(true);
    expect(result.draft.calls.filter((call) => call.data.startsWith("0x095ea7b3"))).toHaveLength(1);
  });

  test("enforces the 1.25 floor for risk increases while allowing risk reduction below it", async () => {
    const boundarySnapshot = snapshot({ withdrawableCollateralRaw: "900000", healthFactorWad: BORROW_HEALTH_FLOOR_WAD.toString() });
    await expect(prepareBorrowAction({ request: { marketId: market.marketId, operation: "withdraw-collateral", amountBaseUnits: "900000" }, market, snapshot: boundarySnapshot, rpc: fixture().rpc })).rejects.toBeInstanceOf(BorrowPreparationError);
    const reducing = await prepare({ marketId: market.marketId, operation: "repay", amountBaseUnits: "1" }, boundarySnapshot);
    expect(reducing.result.draft.kind).toBe("repay");
  });

  test("rejects client authority and snapshot fields through the intent parser", async () => {
    const { parseBorrowActionIntent } = await import("@/shared/borrowing/types");
    expect(parseBorrowActionIntent({ marketId: market.marketId, operation: "borrow", amountBaseUnits: "1", owner: OWNER })).toBeNull();
    expect(parseBorrowActionIntent({ marketId: market.marketId, operation: "borrow", amountBaseUnits: "1", snapshotBlockHash: BLOCK_HASH })).toBeNull();
  });
});
