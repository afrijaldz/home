import { describe, expect, test } from "bun:test";
import {
  ORACLE_PRICE_SCALE,
  WAD,
  accrueBorrowAssets,
  availableBorrowAssets,
  borrowCapacityAssets,
  minimumCollateralForHealthFactor,
  policyMaximumDebtAssets,
  healthFactorWad,
  liquidationPriceRaw,
  minimumCollateralForDebt,
  parseTokenAmount,
  toAssetsUp,
  toSharesDown,
  toSharesUp,
} from "./math";

describe("Morpho borrowing integer math", () => {
  test("uses Morpho virtual shares/assets and opposing debt round directions", () => {
    const totalAssets = BigInt("1000000003");
    const totalShares = BigInt("999000000");
    const assets = BigInt("12345678");
    const sharesDown = toSharesDown(assets, totalAssets, totalShares);
    const sharesUp = toSharesUp(assets, totalAssets, totalShares);

    expect(sharesUp === sharesDown || sharesUp === sharesDown + BigInt("1")).toBe(true);
    expect(toAssetsUp(sharesUp, totalAssets, totalShares)).toBeGreaterThanOrEqual(assets);
    expect(toAssetsUp(BigInt("1"), totalAssets, totalShares)).toBeGreaterThan(BigInt("0"));
  });

  test("accrues debt with Morpho's bounded Taylor compounding and keeps exact integers", () => {
    const totalBorrowAssets = BigInt("1000000000000");
    const ratePerSecondWad = BigInt("1000000000");
    const accrued = accrueBorrowAssets(totalBorrowAssets, ratePerSecondWad, BigInt("86400"));

    expect(accrued).toBeGreaterThan(totalBorrowAssets);
    expect(accrued.toString()).toBe("1000086403732");
  });

  test.each([
    { raw: BigInt("1000000"), floor: BigInt("1250000000000000000"), expected: BigInt("800000") },
    { raw: BigInt("1"), floor: BigInt("1250000000000000000"), expected: BigInt("0") },
    { raw: BigInt("3441"), floor: BigInt("1500000000000000000"), expected: BigInt("2294") },
  ])("derives policy-adjusted capacity with downward rounding: $raw", ({ raw, floor, expected }) => {
    expect(policyMaximumDebtAssets(raw, floor)).toBe(expected);
  });

  test("rounds required collateral up for the configured health factor", () => {
    const debt = BigInt("1000000");
    const price = BigInt("800000000000000000000000000000000000000");
    const lltv = BigInt("860000000000000000");
    const raw = minimumCollateralForHealthFactor(debt, price, lltv, BigInt("1000000000000000000"));
    const policy = minimumCollateralForHealthFactor(debt, price, lltv, BigInt("1250000000000000000"));
    expect(policy).toBeGreaterThan(raw);
  });

  test("accounts for borrow-share rounding when reporting current available capacity", () => {
    const positionBorrowShares = BigInt("100000000");
    const totalBorrowAssets = BigInt("500000003");
    const totalBorrowShares = BigInt("500000000");
    const maxDebtAssets = BigInt("200000000");
    const available = availableBorrowAssets({
      positionBorrowShares,
      totalBorrowAssets,
      totalBorrowShares,
      maxDebtAssets,
      liquidityAssets: BigInt("1000000000"),
    });
    const minted = toSharesUp(available, totalBorrowAssets, totalBorrowShares);
    const postDebt = toAssetsUp(
      positionBorrowShares + minted,
      totalBorrowAssets + available,
      totalBorrowShares + minted,
    );
    const oneMoreShares = toSharesUp(available + BigInt("1"), totalBorrowAssets, totalBorrowShares);
    const oneMoreDebt = toAssetsUp(
      positionBorrowShares + oneMoreShares,
      totalBorrowAssets + available + BigInt("1"),
      totalBorrowShares + oneMoreShares,
    );

    expect(postDebt).toBeLessThanOrEqual(maxDebtAssets);
    expect(oneMoreDebt).toBeGreaterThan(maxDebtAssets);
  });

  test("rounds liquidation collateral upward and never overstates withdraw capacity", () => {
    const price = BigInt("80000") * ORACLE_PRICE_SCALE * BigInt("1000000") / BigInt("100000000");
    const lltv = BigInt("860000000000000000");
    const oneCbbtc = BigInt("100000000");
    const maxDebt = borrowCapacityAssets(oneCbbtc, price, lltv);
    const required = minimumCollateralForDebt(maxDebt, price, lltv);

    expect(maxDebt).toBe(BigInt("68800000000"));
    expect(required).toBe(oneCbbtc);
    expect(healthFactorWad(maxDebt, maxDebt)).toBe(WAD);
  });

  test("preserves Morpho's intermediate floor when inverting the health boundary", () => {
    const debt = BigInt("3442");
    const price = BigInt("800500000000000000000000000000000000000");
    const lltv = BigInt("860000000000000000");
    const requiredCollateral = minimumCollateralForDebt(debt, price, lltv);
    const boundaryPrice = liquidationPriceRaw(debt, requiredCollateral, lltv);

    expect(requiredCollateral).toBe(BigInt("6"));
    expect(borrowCapacityAssets(requiredCollateral - BigInt("1"), price, lltv)).toBe(BigInt("3441"));
    expect(borrowCapacityAssets(requiredCollateral, price, lltv)).toBeGreaterThanOrEqual(debt);
    expect(boundaryPrice).not.toBeNull();
    expect(borrowCapacityAssets(requiredCollateral, boundaryPrice!, lltv)).toBeGreaterThanOrEqual(debt);
    expect(borrowCapacityAssets(requiredCollateral, boundaryPrice! - BigInt("1"), lltv)).toBeLessThan(debt);
  });

  test("parses bounded decimal token amounts without floating point", () => {
    expect(parseTokenAmount("0.00000001", 8)).toBe(BigInt("1"));
    expect(parseTokenAmount("12.345678", 6)).toBe(BigInt("12345678"));
    expect(() => parseTokenAmount("1.0000001", 6)).toThrow("at most 6");
    expect(() => parseTokenAmount("1e3", 6)).toThrow();
  });
});
