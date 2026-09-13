# Borrow

Jesse-locked September 13, 2026 ([#395](https://github.com/jessepollak/home/issues/395)). This document describes the delivered Borrow backend boundary; the routed portfolio and MoneyModal UX are tracked separately.

## Launch boundary

Borrow uses an operator-controlled, compile-time `BorrowMarketRef` registry on Base. That registry—not Morpho API discovery, protocol listing state, or a permissionless catalog—controls which markets Home advertises and enables for new risk. Launch enables only the verified Morpho USDC/cbBTC isolated market. The reader, integer math, calldata builders, and action preparation are market-parameterized so another reviewed isolated market is a registry entry plus fixtures, not a second protocol integration. Home does not load a permissionless market catalog or run background alerts.

Removing or warning a market must not remove management access for an existing position. Operators retain its trusted registry tuple and change it to `reducing-only`; repay, repay-all, close, add-collateral, and zero-debt collateral withdrawal remain available when their required reads verify, while borrow-more and debt-bearing collateral withdrawal remain blocked.

Every detail read and action prepare verifies `idToMarketParams` against the trusted registry tuple at a pinned block. The server derives the owner, `onBehalf`, receiver, Morpho deployment, tokens, oracle, IRM, and LLTV. It simulates the exact ordered Coinbase smart-account batch and reconfirms the pinned block hash. The client sends only a configured market id, an operation, and decimal-integer base-unit amounts.

## Private APIs

- `GET /api/borrow` returns version `1`: configured opportunities, verified non-zero positions, owner/provider scope, and truthful complete/partial discovery. A failed market read is `unavailable`; it is never a zero balance or zero position.
- `GET /api/borrow/markets/:marketId` returns version `1`: exact market identity, pinned source block, market state, wallet state, accrued position, raw protocol limits, and Home policy-adjusted limits.
- `POST /api/actions/prepare` supports add collateral, borrow, atomic supply-and-borrow, partial repay, capped share-based repay-all, collateral withdrawal, and atomic close. Compound operations map to the existing durable `borrow` and `repay` kinds.

Confirmation stays the shared thin commit of the stored calls. It performs no Borrow-only preflight.

## Risk and approvals

Risk-increasing actions that leave debt must have projected health factor `>= 1.25`. The raw protocol limit remains visible beside the policy-adjusted limit. The shared `1.10` critical threshold is retained. Zero-debt closes and withdrawals are not subject to the floor.

Approvals are finite and exact. Home does not issue unlimited approvals and does not issue `approve(0)` before `approve(exact)`; incompatible assets are not enabled.

## Current limitations

The bounded overview verifies registry candidates only. With one launch market this is complete for the supported product boundary. Adding recovery for positions outside the retained registry requires a separately trusted candidate source and must not turn third-party discovery into transaction authority. There are no background liquidation alerts, live-provider tests, or funded-wallet CI tests.
