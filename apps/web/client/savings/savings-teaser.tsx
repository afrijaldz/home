"use client";

import { useEffect, useMemo, useState } from "react";
import { PiggyBank } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { MoneyTicker } from "@/components/money-ticker";
import { useAccountWallet } from "@/client/account/cdp-client";
import { activityOwnerKey } from "@/client/activity/use-activity";
import {
  ownerQueryKey,
  ownerQueryMeta,
  publicQueryKey,
  useHomeQuery,
} from "@/client/query/query-client";
import { deploymentHeaders } from "@/client/query/deployment-headers";
import {
  BASE_USDC_ADDRESS,
  BASE_USDC_DECIMALS,
  MORPHO_V1_CANDIDATE_ADDRESSES,
} from "@/shared/savings/config";
import {
  isUsablePositionResult,
  parsePositionResult,
} from "@/shared/savings/contracts/positions";
import { parseVaultsResult } from "@/shared/savings/contracts/vaults";
import { formatUsdStablecoinAmount } from "@/shared/formatting";
import {
  nextSavingsRateExpiryAt,
  summarizeSavingsPortfolio,
} from "./portfolio-summary";
import { savingsTeaserApyLabel } from "./savings-teaser-apy";
import { ShimmerRows } from "@/client/home/panel-shared";

const BASE_USDC_ASSET = {
  address: BASE_USDC_ADDRESS,
  symbol: "USDC",
  decimals: BASE_USDC_DECIMALS,
} as const;

export function SavingsTeaser({ onOpen }: { onOpen: () => void }) {
  const account = useAccountWallet();
  const session = account.status === "verified" ? account.session : null;
  const sessionAddress = session?.smartAccount?.address ?? null;
  const sessionKey = session?.smartAccount ? activityOwnerKey(session) : null;
  const [rateNowMs, setRateNowMs] = useState(() => Date.now());

  const metadataQuery = useHomeQuery({
    queryKey: publicQueryKey("savings-vaults"),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/savings/vaults", {
        headers: { ...deploymentHeaders(), accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error("Vault request failed");
      return response.json();
    },
    select: (value) => {
      const data = parseVaultsResult(value);
      if (!data) throw new Error("Savings vault metadata is invalid.");
      return data;
    },
  });
  const positionsQuery = useHomeQuery({
    queryKey: sessionKey
      ? ownerQueryKey(sessionKey, "savings-positions")
      : ["unauthenticated", "savings-positions-disabled"],
    enabled: Boolean(sessionKey && sessionAddress),
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
    meta: sessionKey ? ownerQueryMeta(sessionKey, "owner") : undefined,
    queryFn: ({ signal }) => account.fetchSavingsPositions(signal),
    select: (value) => {
      if (!sessionAddress) throw new Error("Savings positions are unavailable.");
      const data = parsePositionResult(value, sessionAddress);
      if (!data || !isUsablePositionResult(data)) {
        throw new Error("Savings positions are invalid.");
      }
      return data;
    },
  });

  useEffect(() => {
    const metadata = metadataQuery.data;
    if (!metadata) return;
    const expiresAt = nextSavingsRateExpiryAt(
      metadata.candidates,
      metadata.source.fetchedAt,
      rateNowMs,
    );
    if (expiresAt === null || expiresAt <= rateNowMs) return;
    const timeout = window.setTimeout(() => setRateNowMs(Date.now()), expiresAt - rateNowMs);
    return () => window.clearTimeout(timeout);
  }, [metadataQuery.data, rateNowMs]);

  const summary = useMemo(() => {
    if (!metadataQuery.data || !positionsQuery.data) return null;
    return summarizeSavingsPortfolio({
      supportedVaultAddresses: MORPHO_V1_CANDIDATE_ADDRESSES,
      requiredAsset: metadataQuery.data.asset ?? BASE_USDC_ASSET,
      candidates: metadataQuery.data.candidates,
      positions: positionsQuery.data.vaults,
      metadataFetchedAt: metadataQuery.data.source.fetchedAt,
      metadataStale: metadataQuery.data.stale,
      nowMs: rateNowMs,
    });
  }, [metadataQuery.data, positionsQuery.data, rateNowMs]);
  // A restoring/validating session is unknown, not zero: keep the shimmer until the owner is known.
  const sessionSettling = account.status === "restoring" || account.status === "validating";
  const loading = sessionSettling ||
    (!metadataQuery.data && !metadataQuery.isError) ||
    Boolean(sessionKey && !positionsQuery.data && !positionsQuery.isError);

  if (loading) return <ShimmerRows count={1} />;

  const balance = summary?.balance.status === "available" ? summary.balance : null;
  const isEmpty = balance?.totalBaseUnits === "0" || !sessionKey;
  const title = isEmpty
    ? "Nothing saved yet"
    : balance
      ? <MoneyTicker value={formatUsdStablecoinAmount(balance.totalBaseUnits)} />
      : <MoneyTicker value="—" />;
  const description = metadataQuery.data && (summary || !sessionKey)
    ? savingsTeaserApyLabel({
        summary,
        candidates: metadataQuery.data.candidates,
        metadata: metadataQuery.data,
        nowMs: rateNowMs,
      })
    : null;

  return (
    <Item
      render={<Button variant="ghost" type="button" />}
      className="min-h-16 flex-nowrap cursor-pointer items-center border-0 text-left hover:bg-muted"
      onClick={onOpen}
      aria-describedby="save-teaser-hint"
    >
      <span id="save-teaser-hint" hidden>Open Save</span>
      <ItemMedia variant="image" className="size-10 self-center translate-y-0 rounded-full bg-muted">
        <PiggyBank className="size-4 text-muted-foreground" aria-hidden="true" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="tabular-nums">{title}</ItemTitle>
        {description ? <ItemDescription>{description}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="shrink-0 text-sm font-medium text-muted-foreground" aria-hidden="true">
        Earn <span>›</span>
      </ItemActions>
    </Item>
  );
}
