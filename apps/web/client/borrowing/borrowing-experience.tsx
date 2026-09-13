"use client";

import { useState, type ReactNode } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { useAccountWallet, type AccountWalletClient } from "@/client/account/cdp-client";
import { dataOwnerKey as ownerDataKey } from "@/client/account/owner-keys";
import {
  MoneyAmountDisplay,
  MoneyConfirmSummary,
  MoneyModal,
  MoneyModalBody,
  MoneyModalFooter,
  MoneyModalHeader,
  MoneyNumpad,
  decimalFromBaseUnits,
  isPositiveDecimalAmount,
  useMoneyAssetPricing,
  type MoneyAmountChangeSource,
} from "@/client/money-modal";
import {
  browserHomeQueryClient,
  ownerQueryKey,
  ownerQueryMeta,
  useHomeQuery,
  useHomeQueryClient,
} from "@/client/query/query-client";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyTicker } from "@/components/money-ticker";
import type { RegionId } from "@/config/regions";
import type { VerifiedAccountSession } from "@/shared/account/session-types";
import { getBorrowMarketRef, type BorrowMarketId } from "@/shared/borrowing/config";
import {
  parseBorrowOverview,
  parseSnapshot,
  type BorrowMarketIdentity,
  type BorrowMarketSnapshot,
  type BorrowOverviewOpportunity,
  type BorrowOverviewPosition,
  type BorrowOverviewResponse,
} from "@/shared/borrowing/contract";
import type { BorrowOperation } from "@/shared/borrowing/types";
import {
  formatExactPresentationTokenAmount,
  formatHealthFactor,
  formatOracleUsd,
  formatPresentationTokenAmount,
  formatWadPercent,
} from "@/shared/formatting";
import type { PreparedMoneyAction } from "@/shared/money-actions/types";
import {
  borrowRiskCopy,
  borrowRiskDescription,
  borrowRiskState,
  buildBorrowPreparedIntent,
} from "./borrow-ui";

type FetchAccountResource = AccountWalletClient["fetchAccountResource"];
type PrepareMoneyAction = AccountWalletClient["prepareMoneyAction"];
type ExecuteMoneyAction = AccountWalletClient["executeMoneyAction"];

type BorrowExperienceProps = {
  session: VerifiedAccountSession | null;
  fetchAccountResource?: FetchAccountResource;
  prepareMoneyAction?: PrepareMoneyAction;
  executeMoneyAction?: ExecuteMoneyAction;
  selectedMarketId?: BorrowMarketId | null;
  onSelectMarket?: (marketId: BorrowMarketId | null) => void;
  regionId?: RegionId;
};

type BorrowDialogState = {
  operation: BorrowOperation;
  snapshot: BorrowMarketSnapshot;
} | null;

const operationLabels: Record<BorrowOperation, string> = {
  "supply-collateral": "Add collateral",
  borrow: "Borrow",
  "supply-and-borrow": "Supply and borrow",
  repay: "Repay",
  "repay-all": "Repay all",
  "withdraw-collateral": "Withdraw collateral",
  "close-position": "Close position",
};

export function AuthenticatedBorrowExperience({
  selectedMarketId = null,
  onSelectMarket,
  regionId = "GLOBAL",
}: {
  selectedMarketId?: BorrowMarketId | null;
  onSelectMarket?: (marketId: BorrowMarketId | null) => void;
  regionId?: RegionId;
}) {
  const account = useAccountWallet();
  return (
    <BorrowExperience
      session={account.status === "verified" ? account.session : null}
      fetchAccountResource={account.fetchAccountResource}
      prepareMoneyAction={account.prepareMoneyAction}
      executeMoneyAction={account.executeMoneyAction}
      selectedMarketId={selectedMarketId}
      onSelectMarket={onSelectMarket}
      regionId={regionId}
    />
  );
}

export function AuthenticatedBorrowTeaser({ onOpen, regionId = "GLOBAL" }: { onOpen: () => void; regionId?: RegionId }) {
  const account = useAccountWallet();
  const session = account.status === "verified" ? account.session : null;
  const overview = useBorrowOverview(session, account.fetchAccountResource);
  const active = overview.data?.positions[0] ?? null;
  const leading = overview.data?.opportunities
    .slice()
    .sort((a, b) => a.market.rank - b.market.rank)[0] ?? null;
  const title = active
    ? `${active.market.collateralToken.symbol} position`
    : leading?.market.collateralToken.symbol === "cbBTC"
      ? "Borrow against Bitcoin"
      : "Explore Borrow";
  const description = active
    ? `${formatToken(active.debtAssetsRaw, active.market.loanToken, regionId)} debt · ${borrowRiskCopy(borrowRiskState(active.healthFactorWad))}`
    : leading?.availability.status === "unavailable"
      ? "Explore verified borrowing markets"
      : leading
        ? `Borrow ${leading.market.loanToken.symbol} against ${leading.market.collateralToken.symbol}`
        : "Explore verified borrowing markets";

  return (
    <ItemGroup className="gap-0">
      <Item
        size="sm"
        className="cursor-pointer border-0 text-left hover:bg-muted"
        render={<Button variant="ghost" type="button" />}
        onClick={onOpen}
        aria-label="Borrow"
      >
        <ItemContent>
          <ItemTitle>{overview.isPending ? "Borrow" : title}</ItemTitle>
          <ItemDescription>{overview.isPending ? "Loading borrowing opportunities…" : description}</ItemDescription>
        </ItemContent>
        <ItemActions><ArrowRight className="size-4" aria-hidden="true" /></ItemActions>
      </Item>
    </ItemGroup>
  );
}

export function BorrowExperience(props: BorrowExperienceProps) {
  const sessionKey = props.session?.smartAccount ? ownerDataKey(props.session) : "signed-out";
  return <BorrowExperienceInner key={sessionKey} {...props} />;
}

function BorrowExperienceInner({
  session,
  fetchAccountResource,
  prepareMoneyAction,
  executeMoneyAction,
  selectedMarketId = null,
  onSelectMarket,
  regionId = "GLOBAL",
}: BorrowExperienceProps) {
  const overview = useBorrowOverview(session, fetchAccountResource);
  const configuredSelection = selectedMarketId && getBorrowMarketRef(selectedMarketId)
    ? selectedMarketId
    : null;

  if (configuredSelection) {
    return (
      <BorrowMarketDetail
        session={session}
        fetchAccountResource={fetchAccountResource}
        prepareMoneyAction={prepareMoneyAction}
        executeMoneyAction={executeMoneyAction}
        marketId={configuredSelection}
        onBack={() => onSelectMarket?.(null)}
        regionId={regionId}
      />
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="borrow-overview-title">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight" id="borrow-overview-title">Borrow</h1>
        <p className="text-sm text-muted-foreground">Borrow from verified isolated markets on Base.</p>
      </div>

      {!session?.smartAccount ? <BorrowNotice title="Sign in to view Borrow" /> : null}
      {session?.smartAccount && overview.isPending ? <BorrowOverviewLoading /> : null}
      {session?.smartAccount && overview.isError && !overview.data ? (
        <BorrowNotice
          tone="error"
          role="alert"
          title="Borrow is unavailable"
          action={<Button variant="secondary" onClick={() => void overview.refetch()}>Retry</Button>}
        >Current market and position values could not be verified. No zero values are shown.</BorrowNotice>
      ) : null}

      {overview.data && session ? (
        <>
          {overview.isFetching ? (
            <BorrowNotice title="Refreshing Borrow data">Showing the last verified values while current state loads.</BorrowNotice>
          ) : null}
          {overview.data.discovery.status === "partial" ? (
            <BorrowNotice tone="error" role="alert" title="Some Borrow data is unavailable">
              {overview.data.discovery.reason ?? "Position discovery may be incomplete. Missing values are not zero."}
            </BorrowNotice>
          ) : null}
          <BorrowPositions
            positions={overview.data.positions}
            regionId={regionId}
            onSelectMarket={onSelectMarket}
          />
          <BorrowOpportunities
            opportunities={overview.data.opportunities}
            activeMarketIds={new Set(overview.data.positions.map((position) => position.market.id))}
            session={session}
            fetchAccountResource={fetchAccountResource}
            regionId={regionId}
            onSelectMarket={onSelectMarket}
          />
        </>
      ) : null}
    </section>
  );
}

function BorrowPositions({
  positions,
  regionId,
  onSelectMarket,
}: {
  positions: BorrowOverviewPosition[];
  regionId: RegionId;
  onSelectMarket?: (marketId: BorrowMarketId | null) => void;
}) {
  const ordered = positions.slice().sort((a, b) => a.market.rank - b.market.rank);
  return (
    <section aria-labelledby="borrow-positions-title">
      <Card>
        <CardHeader><CardTitle id="borrow-positions-title">Active positions</CardTitle></CardHeader>
        <CardContent className="px-2">
          {ordered.length === 0 ? (
            <Empty><EmptyHeader><EmptyTitle>No active Borrow positions</EmptyTitle></EmptyHeader></Empty>
          ) : (
            <ItemGroup className="gap-0">
              {ordered.map((position, index) => (
                <BorrowPositionRow
                  key={position.market.id}
                  position={position}
                  regionId={regionId}
                  onOpen={() => onSelectMarket?.(position.market.id)}
                  separated={index > 0}
                />
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function BorrowPositionRow({
  position,
  regionId,
  onOpen,
  separated,
}: {
  position: BorrowOverviewPosition;
  regionId: RegionId;
  onOpen: () => void;
  separated: boolean;
}) {
  const risk = borrowRiskState(position.healthFactorWad);
  return (
    <>
      {separated ? <ItemSeparator /> : null}
      <Item
        size="sm"
        className="cursor-pointer border-0 text-left hover:bg-muted"
        render={<Button variant="ghost" type="button" />}
        onClick={onOpen}
      >
        <ItemContent>
          <ItemTitle>{marketPair(position.market)}</ItemTitle>
          <ItemDescription>
            {formatToken(position.collateralRaw, position.market.collateralToken, regionId)} collateral · {formatToken(position.debtAssetsRaw, position.market.loanToken, regionId)} debt
          </ItemDescription>
        </ItemContent>
        <ItemActions className="ml-auto flex-col items-end gap-1">
          <Badge variant={risk === "urgent" || risk === "liquidatable" ? "destructive" : "secondary"}>{borrowRiskCopy(risk)}</Badge>
          <span className="text-xs text-muted-foreground">{formatHealthFactor(position.healthFactorWad, regionId)}</span>
        </ItemActions>
      </Item>
    </>
  );
}

function BorrowOpportunities({
  opportunities,
  activeMarketIds,
  session,
  fetchAccountResource,
  regionId,
  onSelectMarket,
}: {
  opportunities: BorrowOverviewOpportunity[];
  activeMarketIds: Set<BorrowMarketId>;
  session: VerifiedAccountSession;
  fetchAccountResource?: FetchAccountResource;
  regionId: RegionId;
  onSelectMarket?: (marketId: BorrowMarketId | null) => void;
}) {
  const ordered = opportunities
    .filter((entry) => !activeMarketIds.has(entry.market.id))
    .sort((a, b) => a.market.rank - b.market.rank);
  return (
    <section aria-labelledby="borrow-opportunities-title">
      <Card>
        <CardHeader><CardTitle id="borrow-opportunities-title">Borrow opportunities</CardTitle></CardHeader>
        <CardContent className="px-2">
          {ordered.length === 0 ? (
            <Empty><EmptyHeader><EmptyTitle>No other enabled markets</EmptyTitle></EmptyHeader></Empty>
          ) : (
            <ItemGroup className="gap-0">
              {ordered.map((opportunity, index) => (
                <BorrowOpportunityRow
                  key={opportunity.market.id}
                  opportunity={opportunity}
                  session={session}
                  fetchAccountResource={fetchAccountResource}
                  regionId={regionId}
                  onOpen={() => onSelectMarket?.(opportunity.market.id)}
                  separated={index > 0}
                />
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function BorrowOpportunityRow({
  opportunity,
  session,
  fetchAccountResource,
  regionId,
  onOpen,
  separated,
}: {
  opportunity: BorrowOverviewOpportunity;
  session: VerifiedAccountSession;
  fetchAccountResource?: FetchAccountResource;
  regionId: RegionId;
  onOpen: () => void;
  separated: boolean;
}) {
  const detail = useBorrowDetail(session, opportunity.market.id, fetchAccountResource, opportunity.availability.status === "available");
  const walletCollateral = detail.data
    ? formatToken(detail.data.wallet.collateralBalanceRaw, detail.data.market.collateralToken, regionId)
    : null;
  return (
    <>
      {separated ? <ItemSeparator /> : null}
      <Item
        size="sm"
        className="cursor-pointer border-0 text-left hover:bg-muted"
        render={<Button variant="ghost" type="button" disabled={opportunity.availability.status === "unavailable"} />}
        onClick={onOpen}
      >
        <ItemContent>
          <ItemTitle>Borrow {opportunity.market.loanToken.symbol} against {opportunity.market.collateralToken.symbol}</ItemTitle>
          <ItemDescription>
            {opportunity.availability.status === "unavailable"
              ? opportunity.availability.reason
              : walletCollateral
                ? `${walletCollateral} in wallet`
                : detail.isPending
                  ? "Checking wallet collateral…"
                  : "Open market details"}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Badge variant={opportunity.availability.status === "unavailable" ? "outline" : opportunity.availability.mode === "reducing-only" ? "destructive" : "secondary"}>
            {opportunity.availability.status === "unavailable" ? "Unavailable" : opportunity.availability.mode === "reducing-only" ? "Reducing only" : "Enabled"}
          </Badge>
        </ItemActions>
      </Item>
    </>
  );
}

function BorrowMarketDetail({
  session,
  fetchAccountResource,
  prepareMoneyAction,
  executeMoneyAction,
  marketId,
  onBack,
  regionId,
}: {
  session: VerifiedAccountSession | null;
  fetchAccountResource?: FetchAccountResource;
  prepareMoneyAction?: PrepareMoneyAction;
  executeMoneyAction?: ExecuteMoneyAction;
  marketId: BorrowMarketId;
  onBack: () => void;
  regionId: RegionId;
}) {
  const detail = useBorrowDetail(session, marketId, fetchAccountResource, true);
  const [dialog, setDialog] = useState<BorrowDialogState>(null);
  const snapshot = detail.data ?? null;

  return (
    <section className="space-y-4" aria-labelledby="borrow-market-title">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Button className="-ml-3" size="sm" variant="ghost" onClick={onBack}>All markets</Button>
          <h1 className="text-2xl font-semibold tracking-tight" id="borrow-market-title">
            {snapshot ? `Borrow ${snapshot.market.loanToken.symbol} against ${snapshot.market.collateralToken.symbol}` : "Borrow market"}
          </h1>
        </div>
        {snapshot ? (
          <Badge variant={snapshot.eligibility.mode === "reducing-only" ? "destructive" : "secondary"}>
            {snapshot.eligibility.mode === "reducing-only" ? "Reducing only" : "Enabled"}
          </Badge>
        ) : null}
      </div>

      {!session?.smartAccount ? <BorrowNotice title="Sign in to view this market" /> : null}
      {session?.smartAccount && detail.isPending ? <BorrowDetailLoading /> : null}
      {session?.smartAccount && detail.isError && !snapshot ? (
        <BorrowNotice
          tone="error"
          role="alert"
          title="Market values are unavailable"
          action={<Button variant="secondary" onClick={() => void detail.refetch()}>Retry</Button>}
        >Wallet balances, position values, and limits could not be verified. They are not zero.</BorrowNotice>
      ) : null}
      {snapshot && detail.isFetching ? (
        <BorrowNotice title="Refreshing market data">Showing the last verified values while current state loads.</BorrowNotice>
      ) : null}
      {snapshot ? (
        <>
          {snapshot.eligibility.mode === "reducing-only" || !snapshot.eligibility.newRisk ? (
            <BorrowNotice tone="error" role="alert" title="New risk is unavailable">
              {snapshot.eligibility.reason ?? "You can add collateral or repay, but cannot borrow more or withdraw collateral with debt."}
            </BorrowNotice>
          ) : null}
          <BorrowMarketFacts snapshot={snapshot} regionId={regionId} />
          <BorrowActions snapshot={snapshot} onOpen={(operation) => setDialog({ operation, snapshot })} />
        </>
      ) : null}

      {dialog && session?.smartAccount && prepareMoneyAction && executeMoneyAction ? (
        <BorrowMoneyDialog
          key={`${dialog.snapshot.market.id}:${dialog.operation}`}
          session={session}
          snapshot={dialog.snapshot}
          operation={dialog.operation}
          prepareMoneyAction={prepareMoneyAction}
          executeMoneyAction={executeMoneyAction}
          regionId={regionId}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}

function BorrowMarketFacts({ snapshot, regionId }: { snapshot: BorrowMarketSnapshot; regionId: RegionId }) {
  const risk = borrowRiskState(snapshot.position.healthFactorWad);
  return (
    <Card aria-labelledby="borrow-market-facts-title">
      <CardHeader>
        <CardTitle id="borrow-market-facts-title">Market and position</CardTitle>
        <CardAction><Badge variant={risk === "urgent" || risk === "liquidatable" ? "destructive" : "outline"}>{borrowRiskCopy(risk)}</Badge></CardAction>
      </CardHeader>
      <CardContent className="px-2">
        <ItemGroup className="gap-0">
          <Metric label={`${snapshot.market.collateralToken.symbol} wallet`} value={formatToken(snapshot.wallet.collateralBalanceRaw, snapshot.market.collateralToken, regionId)} />
          <Metric label="Isolated collateral" value={formatToken(snapshot.position.collateralRaw, snapshot.market.collateralToken, regionId)} separated />
          <Metric label="Current debt" value={formatToken(snapshot.position.debtAssetsRaw, snapshot.market.loanToken, regionId)} separated />
          <Metric label="Variable borrow rate" value={formatWadPercent(snapshot.state.borrowAprWad, regionId)} note="Current annualized rate; not fixed" separated />
          <Metric label="Available liquidity" value={formatToken(snapshot.state.liquidityAssetsRaw, snapshot.market.loanToken, regionId)} separated />
          <Metric label="LLTV" value={formatWadPercent(snapshot.market.lltvWad, regionId)} note="Liquidation threshold, not a target" separated />
          <Metric label="Health" value={formatHealthFactor(snapshot.position.healthFactorWad, regionId)} note={borrowRiskDescription(snapshot.position.healthFactorWad)} separated />
          <Metric label="Liquidation price" value={snapshot.position.liquidationPriceRaw ? `${formatOracleUsd(snapshot.position.liquidationPriceRaw, regionId)} / ${snapshot.market.collateralToken.symbol}` : "No debt"} separated />
          <Metric label="Available to borrow" value={formatToken(snapshot.position.borrowCapacityAssetsRaw, snapshot.market.loanToken, regionId)} note={`Protocol limit ${formatToken(snapshot.position.rawBorrowCapacityAssetsRaw, snapshot.market.loanToken, regionId)}; Home applies its health floor`} separated />
          <Metric label="Available to withdraw" value={formatToken(snapshot.position.withdrawableCollateralRaw, snapshot.market.collateralToken, regionId)} note={`Protocol limit ${formatToken(snapshot.position.rawWithdrawableCollateralRaw, snapshot.market.collateralToken, regionId)}; Home applies its health floor`} separated />
        </ItemGroup>
      </CardContent>
    </Card>
  );
}

function BorrowActions({ snapshot, onOpen }: { snapshot: BorrowMarketSnapshot; onOpen: (operation: BorrowOperation) => void }) {
  const hasDebt = BigInt(snapshot.position.debtAssetsRaw) > BigInt(0);
  const hasCollateral = BigInt(snapshot.position.collateralRaw) > BigInt(0);
  const hasWalletCollateral = BigInt(snapshot.wallet.collateralBalanceRaw) > BigInt(0);
  const hasWalletLoan = BigInt(snapshot.wallet.loanBalanceRaw) > BigInt(0);
  const risk = borrowRiskState(snapshot.position.healthFactorWad);
  const canNewRisk = snapshot.eligibility.newRisk && snapshot.eligibility.mode === "enabled" &&
    risk !== "urgent" && risk !== "liquidatable";
  const opensPosition = !hasCollateral;
  const actions: Array<{ operation: BorrowOperation; disabled: boolean }> = [
    {
      operation: opensPosition ? "supply-and-borrow" : "borrow",
      disabled: !canNewRisk || BigInt(snapshot.state.liquidityAssetsRaw) === BigInt(0) ||
        (opensPosition ? !hasWalletCollateral : BigInt(snapshot.position.borrowCapacityAssetsRaw) === BigInt(0)),
    },
    { operation: "supply-collateral", disabled: !hasWalletCollateral },
    { operation: "repay", disabled: !hasDebt || !hasWalletLoan },
    { operation: "repay-all", disabled: !hasDebt || !hasWalletLoan },
    { operation: "withdraw-collateral", disabled: !hasCollateral || (hasDebt && !canNewRisk) || BigInt(snapshot.position.withdrawableCollateralRaw) === BigInt(0) },
    { operation: "close-position", disabled: !hasCollateral && !hasDebt || (hasDebt && !hasWalletLoan) },
  ];
  return (
    <Card aria-labelledby="borrow-actions-title">
      <CardHeader><CardTitle id="borrow-actions-title">Actions</CardTitle></CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {actions.map(({ operation, disabled }) => (
          <Button key={operation} variant={operation === "borrow" || operation === "supply-and-borrow" ? "default" : "secondary"} disabled={disabled} onClick={() => onOpen(operation)}>
            {operationLabels[operation]}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

function BorrowMoneyDialog({
  session,
  snapshot,
  operation,
  prepareMoneyAction,
  executeMoneyAction,
  regionId,
  onClose,
}: {
  session: VerifiedAccountSession;
  snapshot: BorrowMarketSnapshot;
  operation: BorrowOperation;
  prepareMoneyAction: PrepareMoneyAction;
  executeMoneyAction: ExecuteMoneyAction;
  regionId: RegionId;
  onClose: () => void;
}) {
  const queryClient = useHomeQueryClient(browserHomeQueryClient());
  const dataOwnerKey = ownerDataKey(session);
  const closesWithoutDebt = operation === "close-position" && BigInt(snapshot.position.debtAssetsRaw) === BigInt(0);
  const maximumOperation = operation === "repay-all" || (operation === "close-position" && !closesWithoutDebt);
  const primaryAsset = operation === "supply-collateral" || operation === "withdraw-collateral" || closesWithoutDebt
    ? snapshot.market.collateralToken
    : snapshot.market.loanToken;
  const initialAmount = maximumOperation
    ? decimalFromBaseUnits(snapshot.wallet.loanBalanceRaw, snapshot.market.loanToken.decimals) ?? ""
    : "";
  const primaryPricing = useMoneyAssetPricing(primaryAsset.symbol);
  const collateralPricing = useMoneyAssetPricing(snapshot.market.collateralToken.symbol);
  const [amount, setAmount] = useState(initialAmount);
  const [amountChangeSource, setAmountChangeSource] = useState<MoneyAmountChangeSource>("programmatic");
  const [collateralAmount, setCollateralAmount] = useState("");
  const [collateralChangeSource, setCollateralChangeSource] = useState<MoneyAmountChangeSource>("programmatic");
  const [preparedAction, setPreparedAction] = useState<PreparedMoneyAction | null>(null);
  const [step, setStep] = useState<"amount" | "collateral" | "confirm" | "pending" | "error" | "failed">("amount");
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const title = step === "amount"
    ? operationLabels[operation]
    : step === "collateral"
      ? "Add collateral"
      : "Confirm";
  const requiresPrimaryAmount = !closesWithoutDebt;

  function closeIfAllowed() {
    if (step === "pending") return false;
    onClose();
    return true;
  }

  function goBack() {
    setPreparedAction(null);
    setAttempted(false);
    setError(null);
    setStep("amount");
  }

  async function prepare() {
    try {
      const amountBaseUnits = requiresPrimaryAmount
        ? parseClientTokenAmount(amount, primaryAsset.decimals)
        : undefined;
      const collateralAmountBaseUnits = operation === "supply-and-borrow"
        ? parseClientTokenAmount(collateralAmount, snapshot.market.collateralToken.decimals)
        : undefined;
      const intent = buildBorrowPreparedIntent({ snapshot, operation, amountBaseUnits, collateralAmountBaseUnits });
      setError(null);
      setStep("pending");
      const action = await prepareMoneyAction(intent.kind, intent.params);
      if (!preparedActionMatches(action, session, snapshot.market.id, intent.kind, intent.operation)) {
        throw new Error("The prepared action did not match this verified account and Borrow market.");
      }
      setPreparedAction(action);
      setStep("confirm");
    } catch (caught) {
      setPreparedAction(null);
      setError(readableResourceError(caught));
      setStep("amount");
    }
  }

  async function confirm() {
    if (!preparedAction || step === "pending") return;
    setError(null);
    setStep("pending");
    try {
      const result = await executeMoneyAction(preparedAction);
      setAttempted(true);
      if (result.status === "rejected" || result.status === "failed") {
        setError(result.status === "rejected" ? "The wallet request was rejected." : "The verified onchain receipt reported failure.");
        setStep(result.status === "failed" ? "failed" : "error");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ownerQueryKey(dataOwnerKey, "borrow") });
      onClose();
    } catch {
      setAttempted(true);
      setError("The dispatch outcome is unresolved. Retry recording this same action; a new dispatch will not be created.");
      setStep("confirm");
    }
  }

  const availableBaseUnits = operation === "supply-collateral" || operation === "supply-and-borrow"
    ? snapshot.wallet.collateralBalanceRaw
    : operation === "withdraw-collateral"
      ? snapshot.position.withdrawableCollateralRaw
      : maximumOperation || operation === "repay"
        ? snapshot.wallet.loanBalanceRaw
        : snapshot.position.borrowCapacityAssetsRaw;

  return (
    <MoneyModal open labelledBy="borrow-action-title" describedBy={step === "pending" ? "borrow-action-pending" : undefined} onCancel={closeIfAllowed} onClose={onClose}>
      <MoneyModalHeader title={title} titleId="borrow-action-title" onBack={step === "amount" || step === "pending" ? undefined : goBack} onClose={closeIfAllowed} closeDisabled={step === "pending"} closeLabel="Close Borrow action" />
      <MoneyModalBody className="gap-4 pt-4">
        {step === "amount" ? (
          <>
            {closesWithoutDebt ? (
              <MoneyConfirmSummary
                amount={formatToken(snapshot.position.collateralRaw, snapshot.market.collateralToken, regionId)}
                lead="Withdraw all collateral"
                rows={[{ label: "Market", value: marketPair(snapshot.market) }, { label: "Debt", value: "No debt" }]}
              />
            ) : (
              <>
                <MoneyAmountDisplay
                  amount={amount}
                  amountChangeSource={amountChangeSource}
                  onAmountChange={(value, source) => { setAmount(value); setAmountChangeSource(source); }}
                  availableLabel={maximumOperation ? "wallet maximum" : operation === "repay" ? "wallet balance" : "available"}
                  availableAmount={decimalFromBaseUnits(availableBaseUnits, primaryAsset.decimals)}
                  assetId={primaryAsset.id}
                  assetLabel={primaryAsset.symbol}
                  assetLocked
                  chipSet="max"
                  pricing={primaryPricing}
                  nativeSymbol={primaryAsset.symbol}
                />
                {maximumOperation ? (
                  <BorrowNotice title="Maximum repayment">
                    Current debt is {formatToken(snapshot.position.debtAssetsRaw, snapshot.market.loanToken, regionId)}. The actual repayment is determined by current borrow shares and cannot exceed the amount you review.
                  </BorrowNotice>
                ) : null}
                <MoneyNumpad value={amount} maxDecimals={primaryAsset.decimals} onChange={(value, source) => { setAmount(value); setAmountChangeSource(source); }} />
              </>
            )}
          </>
        ) : null}

        {step === "collateral" ? (
          <>
            <MoneyAmountDisplay
              amount={collateralAmount}
              amountChangeSource={collateralChangeSource}
              onAmountChange={(value, source) => { setCollateralAmount(value); setCollateralChangeSource(source); }}
              availableLabel="wallet collateral"
              availableAmount={decimalFromBaseUnits(snapshot.wallet.collateralBalanceRaw, snapshot.market.collateralToken.decimals)}
              assetId={snapshot.market.collateralToken.id}
              assetLabel={snapshot.market.collateralToken.symbol}
              assetLocked
              chipSet="max"
              pricing={collateralPricing}
              nativeSymbol={snapshot.market.collateralToken.symbol}
            />
            <MoneyNumpad value={collateralAmount} maxDecimals={snapshot.market.collateralToken.decimals} onChange={(value, source) => { setCollateralAmount(value); setCollateralChangeSource(source); }} />
          </>
        ) : null}

        {preparedAction && step !== "amount" && step !== "collateral" ? (
          <BorrowPreparedReview action={preparedAction} snapshot={snapshot} regionId={regionId} />
        ) : null}
        {step === "pending" ? <BorrowNotice title={<span className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />Waiting for your wallet…</span>} /> : null}
        {error ? <BorrowNotice tone="error" role="alert" title="Borrow action unavailable">{error}</BorrowNotice> : null}
      </MoneyModalBody>
      {step === "amount" ? (
        <MoneyModalFooter
          primaryLabel="Continue"
          primaryDisabled={requiresPrimaryAmount && !isPositiveDecimalAmount(amount)}
          onPrimary={() => operation === "supply-and-borrow" ? setStep("collateral") : void prepare()}
        />
      ) : null}
      {step === "collateral" ? (
        <MoneyModalFooter
          primaryLabel="Review"
          primaryDisabled={!isPositiveDecimalAmount(collateralAmount)}
          onPrimary={() => void prepare()}
        />
      ) : null}
      {step === "confirm" ? <MoneyModalFooter primaryLabel={attempted ? "Retry" : "Confirm action"} onPrimary={() => void confirm()} secondaryLabel="Back" onSecondary={goBack} /> : null}
      {step === "error" || step === "failed" ? <MoneyModalFooter primaryLabel="Back" onPrimary={goBack} secondaryLabel="Close" onSecondary={closeIfAllowed} /> : null}
    </MoneyModal>
  );
}

function BorrowPreparedReview({ action, snapshot, regionId }: { action: PreparedMoneyAction; snapshot: BorrowMarketSnapshot; regionId: RegionId }) {
  const metadata = action.metadata?.product === "borrow" ? action.metadata : null;
  const primary = action.amounts[0];
  const amount = primary
    ? `${primary.maximum ? "Up to " : ""}${formatExactPresentationTokenAmount(primary.amountBaseUnits, primary.decimals, primary.symbol)}`
    : action.title;
  const movementRows = action.amounts.map((entry) => ({
    label: `${entry.maximum ? "Maximum repayment" : entry.direction === "spend" ? "You spend" : "You receive"} (${entry.symbol})`,
    value: `${entry.estimated ? "Estimated " : ""}${formatExactPresentationTokenAmount(entry.amountBaseUnits, entry.decimals, entry.symbol)}`,
  }));
  return (
    <MoneyConfirmSummary
      amount={amount}
      lead={action.title}
      rows={[
        { label: "Market", value: marketPair(snapshot.market) },
        ...movementRows,
        { label: "Variable rate", value: formatWadPercent(snapshot.state.borrowAprWad, regionId) },
        { label: "LLTV", value: formatWadPercent(snapshot.market.lltvWad, regionId) },
        { label: "Projected health", value: formatHealthFactor(metadata?.projectedHealthFactorWad ?? snapshot.position.healthFactorWad, regionId) },
        { label: "Liquidation price", value: metadata?.projectedLiquidationPriceRaw ? `${formatOracleUsd(metadata.projectedLiquidationPriceRaw, regionId)} / ${snapshot.market.collateralToken.symbol}` : "No debt" },
      ]}
    />
  );
}

function Metric({ label, value, note, separated = false }: { label: string; value: string; note?: string; separated?: boolean }) {
  return (
    <>
      {separated ? <ItemSeparator /> : null}
      <Item variant="muted" size="sm" render={<li />}>
        <ItemContent><ItemTitle>{label}</ItemTitle>{note ? <ItemDescription>{note}</ItemDescription> : null}</ItemContent>
        <ItemActions className="ml-auto max-w-1/2 justify-end text-right text-sm tabular-nums"><MoneyTicker value={value} /></ItemActions>
      </Item>
    </>
  );
}

function BorrowOverviewLoading() {
  return <Card aria-busy="true"><CardContent className="space-y-3 py-5"><Skeleton className="h-5 w-36" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><span className="sr-only">Loading Borrow overview</span></CardContent></Card>;
}

function BorrowDetailLoading() {
  return <Card aria-busy="true"><CardContent className="space-y-3 py-5">{Array.from({ length: 6 }, (_, index) => <Skeleton className="h-10 w-full" key={index} />)}<span className="sr-only">Loading Borrow market</span></CardContent></Card>;
}

function BorrowNotice({ action, children, role = "status", title, tone = "neutral" }: { action?: ReactNode; children?: ReactNode; role?: "status" | "alert"; title?: ReactNode; tone?: "neutral" | "error" }) {
  return (
    <Alert role={role} variant={tone === "error" ? "destructive" : "default"}>
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {children ? <AlertDescription>{children}</AlertDescription> : null}
      {action ? <AlertAction>{action}</AlertAction> : null}
    </Alert>
  );
}

function useBorrowOverview(session: VerifiedAccountSession | null, fetchAccountResource?: FetchAccountResource) {
  const owner = session?.smartAccount?.address ?? null;
  const key = session?.smartAccount ? ownerDataKey(session) : null;
  return useHomeQuery({
    queryKey: key ? ownerQueryKey(key, "borrow", "overview") : ["unauthenticated", "borrow-overview-disabled"],
    enabled: Boolean(key && owner && fetchAccountResource),
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: true,
    meta: key ? ownerQueryMeta(key, "owner") : undefined,
    queryFn: ({ signal }) => {
      if (!fetchAccountResource) throw new Error("Borrow is unavailable.");
      return fetchAccountResource("/api/borrow", { signal });
    },
    select: (value): BorrowOverviewResponse => {
      if (!owner) throw new Error("Borrow is unavailable.");
      const parsed = parseBorrowOverview(value, owner);
      if (!parsed) throw new Error("Borrow overview response is invalid.");
      return parsed;
    },
  });
}

function useBorrowDetail(session: VerifiedAccountSession | null, marketId: BorrowMarketId, fetchAccountResource: FetchAccountResource | undefined, enabled: boolean) {
  const owner = session?.smartAccount?.address ?? null;
  const key = session?.smartAccount ? ownerDataKey(session) : null;
  return useHomeQuery({
    queryKey: key ? ownerQueryKey(key, "borrow", "detail", marketId) : ["unauthenticated", "borrow-detail-disabled", marketId],
    enabled: Boolean(enabled && key && owner && fetchAccountResource),
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: true,
    meta: key ? ownerQueryMeta(key, "owner") : undefined,
    queryFn: ({ signal }) => {
      if (!fetchAccountResource) throw new Error("Borrow is unavailable.");
      return fetchAccountResource(`/api/borrow/markets/${marketId}`, { signal });
    },
    select: (value): BorrowMarketSnapshot => {
      if (!owner) throw new Error("Borrow is unavailable.");
      const parsed = parseSnapshot(value, owner);
      if (!parsed) throw new Error("Borrow market response is invalid.");
      return parsed;
    },
  });
}

function marketPair(market: BorrowMarketIdentity): string {
  return `${market.loanToken.symbol} / ${market.collateralToken.symbol}`;
}

function formatToken(raw: string, asset: BorrowMarketIdentity["loanToken"], regionId: RegionId): string {
  return formatPresentationTokenAmount(raw, asset.decimals, asset.symbol, {
    ...(asset.symbol === "USDC" ? { cashCurrency: "USD" as const } : {}),
    regionId,
    useNoBreakSpace: true,
  });
}

function parseClientTokenAmount(value: string, decimals: number): string {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) throw new Error("Enter a positive decimal amount.");
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) throw new Error(`This asset supports at most ${decimals} decimal places.`);
  const amount = BigInt(whole) * (BigInt(10) ** BigInt(decimals)) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (amount <= BigInt(0)) throw new Error("Amount must be greater than zero.");
  return amount.toString(10);
}

function preparedActionMatches(action: PreparedMoneyAction, session: VerifiedAccountSession, marketId: BorrowMarketId, kind: PreparedMoneyAction["kind"], operation: BorrowOperation): boolean {
  return Boolean(session.smartAccount && action.kind === kind && action.owner.subject === session.user.subject &&
    action.owner.accountProvider === session.accountProvider &&
    action.owner.address.toLowerCase() === session.smartAccount.address.toLowerCase() &&
    action.metadata?.product === "borrow" && action.metadata.operation === operation &&
    action.metadata.marketId.toLowerCase() === marketId.toLowerCase());
}

function readableResourceError(error: unknown): string {
  if (error instanceof Error && error.message && error.message !== "Authenticated resource is unavailable.") return error.message;
  return "The current limit or Base simulation could not be verified. Refresh and try again. No transaction was submitted.";
}
