import "@/client/account/dom-test-harness";

import { getHomeQueryClient } from "@/client/query/query-client";
import { afterEach, describe, expect, test } from "bun:test";
import type { VerifiedAccountSession } from "@/shared/account/session-types";
import {
  BORROW_COLLATERAL_TOKEN,
  BORROW_IRM_ADDRESS,
  BORROW_LLTV_WAD,
  BORROW_LOAN_TOKEN,
  BORROW_MARKET_ID,
  BORROW_ORACLE_ADDRESS,
  MORPHO_BLUE_ADDRESS,
} from "@/shared/borrowing/config";
import type { BorrowMarketSnapshot, BorrowOverviewResponse } from "@/shared/borrowing/contract";
import type { PreparedMoneyAction } from "@/shared/money-actions/types";

const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
const { BorrowExperience } = await import("./borrowing-experience");

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const OWNER_B = "0x2222222222222222222222222222222222222222" as const;
const BLOCK_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;

function session(address: `0x${string}` = OWNER, subject = "borrow-ui-user"): VerifiedAccountSession {
  return { user: { subject }, smartAccount: { address, chainId: 8453 }, accountProvider: "cdp-embedded" };
}

function detail(overrides: Partial<BorrowMarketSnapshot> = {}): BorrowMarketSnapshot {
  return {
    version: "1",
    chainId: 8453,
    walletAddress: OWNER,
    market: { id: BORROW_MARKET_ID, morpho: MORPHO_BLUE_ADDRESS, loanToken: BORROW_LOAN_TOKEN, collateralToken: BORROW_COLLATERAL_TOKEN, oracle: BORROW_ORACLE_ADDRESS, irm: BORROW_IRM_ADDRESS, lltvWad: BORROW_LLTV_WAD.toString(), rank: 1 },
    eligibility: { mode: "enabled", newRisk: true, reason: null },
    source: { provider: "Base JSON-RPC", blockNumber: "100", blockHash: BLOCK_HASH, blockTimestamp: "1788897600", fetchedAt: "2026-09-13T12:00:00.000Z" },
    state: { oraclePriceRaw: "800000000000000000000000000000000000000", borrowRatePerSecondWad: "1000000000", borrowAprWad: "31536000000000000", totalSupplyAssetsRaw: "1000000000", totalBorrowAssetsRaw: "500000000", totalBorrowSharesRaw: "500000000", liquidityAssetsRaw: "500000000", lastUpdateTimestamp: "1788897500" },
    wallet: { collateralBalanceRaw: "100000000", loanBalanceRaw: "200000000", collateralAllowanceRaw: "0", loanAllowanceRaw: "0" },
    position: { collateralRaw: "50000000", borrowSharesRaw: "100000000", debtAssetsRaw: "100000000", rawBorrowCapacityAssetsRaw: "200000000", borrowCapacityAssetsRaw: "150000000", rawWithdrawableCollateralRaw: "10000000", withdrawableCollateralRaw: "5000000", healthFactorWad: "1600000000000000000", liquidationPriceRaw: "600000000000000000000000000000000000000" },
    ...overrides,
  };
}

function overview({ position = true, unavailable = false, owner = OWNER }: { position?: boolean; unavailable?: boolean; owner?: `0x${string}` } = {}): BorrowOverviewResponse {
  const snapshot = detail({ walletAddress: owner });
  return {
    version: "1",
    chainId: 8453,
    owner: { address: owner, accountProvider: "cdp-embedded" },
    discovery: { status: unavailable ? "partial" : "complete", candidateCount: 1, verifiedCount: unavailable ? 0 : 1, reason: unavailable ? "Current verified chain state is unavailable. Missing values are unavailable, not zero." : null, fetchedAt: "2026-09-13T12:00:00.000Z" },
    opportunities: [{
      market: snapshot.market,
      availability: unavailable
        ? { status: "unavailable", mode: "enabled", reason: "Current verified chain state is unavailable for this market.", source: null }
        : { status: "available", mode: "enabled", reason: null, source: snapshot.source },
    }],
    positions: position && !unavailable ? [{ market: snapshot.market, source: snapshot.source, collateralRaw: snapshot.position.collateralRaw, borrowSharesRaw: snapshot.position.borrowSharesRaw, debtAssetsRaw: snapshot.position.debtAssetsRaw, healthFactorWad: snapshot.position.healthFactorWad }] : [],
  };
}

function prepared(owner = OWNER): PreparedMoneyAction {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    owner: { subject: "borrow-ui-user", address: owner, chainId: 8453, accountProvider: "cdp-embedded" },
    kind: "borrow",
    title: "Borrow USDC",
    calls: [{ to: MORPHO_BLUE_ADDRESS, data: "0x1234", value: "0" }],
    amounts: [{ assetId: BORROW_LOAN_TOKEN.id, symbol: "USDC", decimals: 6, amountBaseUnits: "1000000", direction: "receive" }],
    warnings: [],
    metadata: { product: "borrow", operation: "borrow", marketId: BORROW_MARKET_ID, loanAsset: { id: BORROW_LOAN_TOKEN.id, symbol: "USDC" }, collateralAsset: { id: BORROW_COLLATERAL_TOKEN.id, symbol: "cbBTC" }, projectedHealthFactorWad: "1500000000000000000", projectedLiquidationPriceRaw: "610000000000000000000000000000000000000", source: { blockNumber: "100", blockHash: BLOCK_HASH, blockTimestamp: "1788897600" } },
    createdAt: "2026-09-13T12:00:00.000Z",
    expiresAt: "2030-09-13T12:02:00.000Z",
  };
}

afterEach(() => {
  cleanup();
  getHomeQueryClient().clear();
});

describe("BorrowExperience", () => {
  test("renders a signed-out overview without nested main or invented wallet values", () => {
    render(<BorrowExperience session={null} />);
    const body = within(document.body);
    expect(body.getByRole("heading", { level: 1, name: "Borrow" })).toBeTruthy();
    expect(body.getByRole("status").textContent).toContain("Sign in to view Borrow");
    expect(body.queryByRole("main")).toBeNull();
    expect(document.body.textContent).not.toContain("$0.00");
  });

  test("shows active positions before opportunities and opens market detail", async () => {
    const selected: string[] = [];
    render(<BorrowExperience session={session()} fetchAccountResource={async (path) => path === "/api/borrow" ? overview() : detail()} onSelectMarket={(market) => { if (market) selected.push(market); }} />);
    const body = within(document.body);
    expect(await body.findByText("Active positions")).toBeTruthy();
    expect(body.getByText("USDC / cbBTC")).toBeTruthy();
    expect(body.getByText(/Healthy buffer/)).toBeTruthy();
    fireEvent.click(body.getByRole("button", { name: /USDC \/ cbBTC/ }));
    expect(selected).toEqual([BORROW_MARKET_ID]);
  });

  test("renders decision-critical detail and sends exact borrow intent through MoneyModal", async () => {
    const requests: Array<{ kind: string; params: unknown }> = [];
    render(
      <BorrowExperience
        session={session()}
        selectedMarketId={BORROW_MARKET_ID}
        fetchAccountResource={async () => detail()}
        prepareMoneyAction={async (kind, params) => { requests.push({ kind, params }); return prepared(); }}
        executeMoneyAction={async (action) => ({ id: action.id, status: "submitted" })}
      />,
    );
    const body = within(document.body);
    expect(await body.findByRole("heading", { name: "Borrow USDC against cbBTC" })).toBeTruthy();
    expect(body.getByText("Available to borrow")).toBeTruthy();
    expect(body.getAllByText(/Protocol limit/)).toHaveLength(2);
    expect(body.queryByText(/Oracle address|IRM|Morpho contract/i)).toBeNull();

    fireEvent.click(body.getByRole("button", { name: "Borrow" }));
    expect(await body.findByRole("dialog", { name: "Borrow" })).toBeTruthy();
    fireEvent.click(body.getByRole("button", { name: "1" }));
    fireEvent.click(body.getByRole("button", { name: "Continue" }));
    expect(await body.findByText("Projected health")).toBeTruthy();
    expect(requests).toEqual([{ kind: "borrow", params: { marketId: BORROW_MARKET_ID, operation: "borrow", amountBaseUnits: "1000000" } }]);
  });

  test("shows unavailable data as unavailable rather than zero", async () => {
    render(<BorrowExperience session={session()} fetchAccountResource={async () => { throw new Error("RPC unavailable"); }} />);
    const body = within(document.body);
    expect((await body.findByRole("alert")).textContent).toContain("No zero values are shown");
    expect(document.body.textContent).not.toContain("$0.00");
  });

  test("shows reducing-only and urgent risk recovery copy", async () => {
    const snapshot = detail({
      eligibility: { mode: "reducing-only", newRisk: false, reason: "New borrowing is paused." },
      position: { ...detail().position, healthFactorWad: "1200000000000000000" },
    });
    render(<BorrowExperience session={session()} selectedMarketId={BORROW_MARKET_ID} fetchAccountResource={async () => snapshot} />);
    const body = within(document.body);
    expect(await body.findByText("Reducing only")).toBeTruthy();
    expect(body.getByText("Urgent — reduce risk")).toBeTruthy();
    expect(body.getByText(/Below Home’s new-risk floor/)).toBeTruthy();
    expect(body.getByRole("button", { name: "Borrow" }).hasAttribute("disabled")).toBe(true);
  });

  test("clears prior-owner detail immediately when the owner changes", async () => {
    let resolveB!: (value: unknown) => void;
    const pendingB = new Promise((resolve) => { resolveB = resolve; });
    const view = render(<BorrowExperience session={session()} selectedMarketId={BORROW_MARKET_ID} fetchAccountResource={async () => detail()} />);
    expect(await within(document.body).findByText("Available to borrow")).toBeTruthy();

    view.rerender(<BorrowExperience session={session(OWNER_B, "borrow-ui-user-b")} selectedMarketId={BORROW_MARKET_ID} fetchAccountResource={() => pendingB} />);
    expect(within(document.body).queryByText("Available to borrow")).toBeNull();
    expect(within(document.body).getByText("Loading Borrow market")).toBeTruthy();
    resolveB(detail({ walletAddress: OWNER_B }));
    await waitFor(() => expect(within(document.body).getByText("Available to borrow")).toBeTruthy());
  });
});
