"use client";

import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyTicker } from "@/components/money-ticker";
import type { FetchActivity } from "@/client/activity";
import { FundingActions } from "@/client/funding/funding-actions";
import { TransferActions } from "@/client/transfers";
import { previewHomeBalanceItems } from "@/client/portfolio";
import type { AssetMarkResolution } from "@/client/asset-mark/presentation";
import type { VerifiedAccountSession } from "@/shared/account/session-types";
import type { RegionId } from "@/config/regions";
import { SavingsTeaser } from "@/client/savings/savings-teaser";
import { ConnectedActivityPanel } from "./activity-panel";
import { HomeBalancesList } from "./balances-panel";
import type { HomeAssetBalancesPresentation } from "./home-types";
import { ShimmerRows } from "./panel-shared";
import { deriveSendAvailability } from "./send-availability";

function SectionHeader({
  headingId,
  title,
  onOpen,
  actionLabel = "See all",
}: {
  headingId: string;
  title: "Balances" | "Save" | "Activity";
  onOpen: () => void;
  actionLabel?: "See all" | "Earn";
}) {
  return (
    <>
      <CardTitle id={headingId} role="heading" aria-level={2}>{title}</CardTitle>
      <CardAction>
        <Button size="sm" variant="ghost" onClick={onOpen} aria-label={title}>
          {actionLabel}
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </CardAction>
    </>
  );
}

export function HomePanel({
  assetBalances,
  assetMarkResolution,
  activitySession,
  fetchActivity,
  fetchOperations,
  onOpenSave,
  onOpenBalances,
  onOpenActivity,
  initialAddMoney = false,
  returnedFromProvider = false,
  initialSendFlow = false,
  initialSendActionId = null,
  regionId,
}: {
  assetBalances?: HomeAssetBalancesPresentation;
  assetMarkResolution?: AssetMarkResolution;
  activitySession: VerifiedAccountSession | null;
  fetchActivity: FetchActivity;
  fetchOperations: (signal?: AbortSignal) => Promise<unknown>;
  onOpenSave: () => void;
  onOpenBalances: () => void;
  onOpenActivity: () => void;
  initialAddMoney?: boolean;
  returnedFromProvider?: boolean;
  initialSendFlow?: boolean;
  initialSendActionId?: string | null;
  regionId: RegionId;
}) {
  const isLoading = assetBalances?.status === "loading";
  const isRevalidating = assetBalances?.revalidating === true;
  const showSessionShimmer = !activitySession && (isLoading || isRevalidating);
  const heroLabel = isLoading
    ? "Updating…"
    : assetBalances?.status === "unavailable"
      ? "Balance unavailable"
      : "Total balance";
  const balanceItems = assetBalances?.items ?? [];
  const balanceStatusLabel =
    assetBalances?.totalStatus === "partial" ? undefined : assetBalances?.statusLabel;
  const showBalanceStatus =
    assetBalances?.status !== "loading" &&
    balanceStatusLabel !== "Updating…" &&
    Boolean(balanceStatusLabel);

  return (
    <div className="space-y-4">
      <Card
        className="py-0"
        aria-label={heroLabel}
        aria-busy={isLoading || isRevalidating || undefined}
      >
        <CardContent className="space-y-2 px-4 py-5 sm:px-5 sm:py-6">
          <p className="text-sm text-muted-foreground">Total balance</p>
          {isLoading ? (
            <Skeleton className="h-10 w-48" data-shimmer="hero" />
          ) : (
            <div className="text-4xl font-semibold tabular-nums">
              <MoneyTicker value={assetBalances?.displayTotal ?? "—"} />
            </div>
          )}
          {assetBalances?.metadataLabel || showBalanceStatus ? (
            <div className="flex w-full items-center justify-between gap-3 text-sm text-muted-foreground">
              {assetBalances?.metadataLabel ? <p>{assetBalances.metadataLabel}</p> : <span />}
              {showBalanceStatus ? (
                <p className="text-right" data-total-status={assetBalances?.totalStatus}>
                  {balanceStatusLabel}
                </p>
              ) : null}
            </div>
          ) : null}
          {isLoading || isRevalidating ? <span className="sr-only">Updating…</span> : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2" aria-label="Money actions">
        <FundingActions
          initialOpen={initialAddMoney}
          returnedFromProvider={returnedFromProvider}
          regionId={regionId}
        />
        <TransferActions
          initialOpen={initialSendFlow}
          initialActionId={initialSendActionId}
          availableAssets={deriveSendAvailability(balanceItems)}
          assetMarkResolution={assetMarkResolution}
        />
      </div>

      <section aria-labelledby="balances-heading">
        <Card>
          <CardHeader>
            <SectionHeader
              headingId="balances-heading"
              title="Balances"
              onOpen={onOpenBalances}
            />
          </CardHeader>
          <CardContent className="px-2">
            <HomeBalancesList
              items={previewHomeBalanceItems(balanceItems)}
              isLoading={isLoading}
              isUnavailable={assetBalances?.status === "unavailable"}
              assetMarkResolution={assetMarkResolution}
            />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="save-heading">
        <Card>
          <CardHeader>
            <CardTitle id="save-heading" role="heading" aria-level={2}>Save</CardTitle>
          </CardHeader>
          <CardContent className="px-2">
            <SavingsTeaser onOpen={onOpenSave} />
          </CardContent>
        </Card>
      </section>

      {showSessionShimmer ? (
        <section aria-labelledby="activity-title" aria-busy="true">
          <Card>
            <CardHeader>
              <SectionHeader headingId="activity-title" title="Activity" onOpen={onOpenActivity} />
            </CardHeader>
            <CardContent className="px-2"><ShimmerRows count={2} /></CardContent>
          </Card>
        </section>
      ) : (
        <ConnectedActivityPanel
          density="teaser"
          header={
            <SectionHeader headingId="activity-title" title="Activity" onOpen={onOpenActivity} />
          }
          activitySession={activitySession}
          fetchActivity={fetchActivity}
          fetchOperations={fetchOperations}
          regionId={regionId}
        />
      )}
    </div>
  );
}
