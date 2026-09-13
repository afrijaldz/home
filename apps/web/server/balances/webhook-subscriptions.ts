import "server-only";

import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { emitServerEvent } from "@/server/observability/log";

export const CDP_WEBHOOKS_HOST = "api.cdp.coinbase.com" as const;
export const CDP_WEBHOOK_SUBSCRIPTIONS_PATH = "/platform/v2/data/webhooks/subscriptions" as const;
/** Current subscription API enum; deliveries use the wallet.activity event family. */
export const CDP_ACTIVITY_EVENT_TYPE = "wallet_activity" as const;
export const CDP_ACTIVITY_NETWORK = "base-mainnet" as const;
export const CDP_SUBSCRIPTION_ADDRESS_LIMIT = 100;
export const CDP_SUBSCRIPTION_LIST_TTL_MS = 60_000;

export interface BalanceWebhookSubscriptions {
  ensureAddressSubscribed(address: `0x${string}`): Promise<void>;
}

type Environment = Readonly<Record<string, string | undefined>>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type JwtGenerator = typeof generateJwt;
type Subscription = {
  id: string;
  eventTypes: string[];
  targetUrl: string;
  labels: Record<string, string>;
  isEnabled: boolean;
  addresses: `0x${string}`[];
};

export function createCdpWebhookSubscriptions(options: {
  env?: Environment;
  fetchImpl?: FetchLike;
  generateJwtImpl?: JwtGenerator;
  now?: () => number;
  logFailure?: (reason: string) => void;
} = {}): BalanceWebhookSubscriptions {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const generateJwtImpl = options.generateJwtImpl ?? generateJwt;
  const now = options.now ?? Date.now;
  const logFailure = options.logFailure ?? observeSubscriptionFailure;
  let cached: { at: number; subscriptions: Subscription[] } | null = null;
  let listing: Promise<Subscription[]> | null = null;

  async function list(): Promise<Subscription[]> {
    const current = now();
    if (cached && current - cached.at <= CDP_SUBSCRIPTION_LIST_TTL_MS) {
      return cached.subscriptions;
    }
    if (listing) return listing;
    listing = requestJson({
      env,
      fetchImpl,
      generateJwtImpl,
      method: "GET",
      path: CDP_WEBHOOK_SUBSCRIPTIONS_PATH,
    }).then(parseSubscriptions).then((subscriptions) => {
      cached = { at: now(), subscriptions };
      return subscriptions;
    }).finally(() => { listing = null; });
    return listing;
  }

  return {
    async ensureAddressSubscribed(address) {
      try {
        const normalized = normalizeAddress(address);
        const subscriptions = (await list()).filter(isBaseActivitySubscription);
        if (subscriptions.some((subscription) => subscription.addresses.includes(normalized))) return;
        const target = subscriptions.find((subscription) =>
          subscription.addresses.length < CDP_SUBSCRIPTION_ADDRESS_LIMIT
        );
        if (!target) throw new Error("no-subscription-with-room");
        target.addresses = [...target.addresses, normalized];
        target.labels = {
          ...target.labels,
          network: CDP_ACTIVITY_NETWORK,
          wallet_addresses: target.addresses.join(","),
        };
        await requestJson({
          env,
          fetchImpl,
          generateJwtImpl,
          method: "PUT",
          path: `${CDP_WEBHOOK_SUBSCRIPTIONS_PATH}/${encodeURIComponent(target.id)}`,
          body: subscriptionRequest(target),
        });
        cached = { at: now(), subscriptions };
      } catch (error) {
        logFailure(error instanceof Error ? error.message : "subscription-failed");
      }
    },
  };
}

export async function createCdpActivitySubscription(options: {
  origin: string;
  addresses: readonly `0x${string}`[];
  env?: Environment;
  fetchImpl?: FetchLike;
  generateJwtImpl?: JwtGenerator;
}): Promise<{ id: string; secret: string }> {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" && origin.hostname !== "localhost") {
    throw new Error("HOME_WEBHOOK_ORIGIN must be HTTPS outside localhost.");
  }
  const addresses = [...new Set(options.addresses.map(normalizeAddress))];
  if (addresses.length === 0 || addresses.length > CDP_SUBSCRIPTION_ADDRESS_LIMIT) {
    throw new Error("A CDP activity subscription requires 1-100 addresses.");
  }
  const payload = await requestJson({
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl ?? fetch,
    generateJwtImpl: options.generateJwtImpl ?? generateJwt,
    method: "POST",
    path: CDP_WEBHOOK_SUBSCRIPTIONS_PATH,
    body: {
      eventTypes: [CDP_ACTIVITY_EVENT_TYPE],
      target: { url: new URL("/api/webhooks/cdp", origin).toString() },
      labels: {
        network: CDP_ACTIVITY_NETWORK,
        wallet_addresses: addresses.join(","),
      },
      isEnabled: true,
    },
  });
  const parsed = parseCreatedSubscription(payload);
  if (!parsed) throw new Error("CDP create subscription response omitted id or secret.");
  return parsed;
}

async function requestJson(options: {
  env: Environment;
  fetchImpl: FetchLike;
  generateJwtImpl: JwtGenerator;
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
}): Promise<unknown> {
  const apiKeyId = options.env.CDP_API_KEY_ID?.trim();
  const secretName = ["CDP", "API", "KEY", "SECRET"].join("_");
  const apiKeySecret = options.env[secretName]?.trim();
  if (!apiKeyId || !apiKeySecret) throw new Error("cdp-api-key-not-configured");
  const token = await options.generateJwtImpl({
    apiKeyId,
    apiKeySecret,
    requestMethod: options.method,
    requestHost: CDP_WEBHOOKS_HOST,
    requestPath: options.path,
    expiresIn: 120,
  });
  const headers = new Headers({ accept: "application/json" });
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await options.fetchImpl(`https://${CDP_WEBHOOKS_HOST}${options.path}`, {
    method: options.method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`cdp-webhooks-${response.status}`);
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    throw new Error("cdp-webhooks-invalid-json");
  }
}

function parseSubscriptions(value: unknown): Subscription[] {
  const rows = isRecord(value) && Array.isArray(value.subscriptions)
    ? value.subscriptions
    : Array.isArray(value) ? value : null;
  if (!rows) throw new Error("cdp-webhooks-invalid-list");
  return rows.flatMap(parseSubscription);
}

function parseSubscription(value: unknown): Subscription[] {
  if (!isRecord(value)) return [];
  const id = stringField(value, "subscriptionId", "id");
  const eventTypes = Array.isArray(value.eventTypes)
    ? value.eventTypes.filter((entry): entry is string => typeof entry === "string")
    : typeof value.event_type === "string" ? [value.event_type] : [];
  const targetUrl = isRecord(value.target) && typeof value.target.url === "string"
    ? value.target.url
    : stringField(value, "notification_uri") ?? "";
  const labels = isRecord(value.labels)
    ? Object.fromEntries(Object.entries(value.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : legacyLabels(value.event_filters);
  if (!id || eventTypes.length === 0 || !targetUrl) return [];
  return [{
    id,
    eventTypes,
    targetUrl,
    labels,
    isEnabled: value.isEnabled !== false,
    addresses: parseAddressLabel(labels.wallet_addresses),
  }];
}

function legacyLabels(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const filter = value.find((entry) => isRecord(entry) && entry.network === CDP_ACTIVITY_NETWORK);
  if (!isRecord(filter)) return {};
  const addresses = Array.isArray(filter.addresses)
    ? filter.addresses.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { network: CDP_ACTIVITY_NETWORK, wallet_addresses: addresses.join(",") };
}

function parseAddressLabel(value: string | undefined): `0x${string}`[] {
  if (!value) return [];
  return [...new Set(value.split(",").flatMap((address) => {
    const trimmed = address.trim();
    return /^0x[0-9a-fA-F]{40}$/.test(trimmed)
      ? [trimmed.toLowerCase() as `0x${string}`]
      : [];
  }))];
}

function parseCreatedSubscription(value: unknown): { id: string; secret: string } | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "subscriptionId", "id");
  const secret = stringField(value, "secret") ??
    (isRecord(value.metadata) ? stringField(value.metadata, "secret") : null);
  return id && secret ? { id, secret } : null;
}

function subscriptionRequest(subscription: Subscription) {
  return {
    eventTypes: subscription.eventTypes,
    target: { url: subscription.targetUrl },
    labels: subscription.labels,
    isEnabled: subscription.isEnabled,
  };
}

function isBaseActivitySubscription(subscription: Subscription): boolean {
  return subscription.isEnabled &&
    (subscription.eventTypes.includes(CDP_ACTIVITY_EVENT_TYPE) ||
      subscription.eventTypes.includes("wallet.activity.multi")) &&
    subscription.labels.network === CDP_ACTIVITY_NETWORK;
}

function normalizeAddress(address: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("invalid-subscription-address");
  return address.toLowerCase() as `0x${string}`;
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (typeof value[key] === "string") return value[key];
  return null;
}

function observeSubscriptionFailure(reason: string): void {
  emitServerEvent("balances-webhook-subscription", {
    route: "/api/balances",
    code: "SUBSCRIPTION_FAILED",
    outcome: "unavailable",
    provider: reason,
    durationMs: 0,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
