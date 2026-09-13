import { describe, expect, test } from "bun:test";
import {
  MemoryWebhookSubscriptionStore,
  type WebhookSubscriptionStore,
} from "./webhook-subscription-store";
import { CDP_WEBHOOK_SUBSCRIPTIONS_PATH, createCdpWebhookSubscriptions, deploymentWebhookOrigin } from "./webhook-subscriptions";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const env = { CDP_API_KEY_ID: "key", CDP_API_KEY_SECRET: "api-value", HOME_WEBHOOK_ORIGIN: "https://home.example" };
const jwt = async () => "fixture.jwt";

function persistentStore(): WebhookSubscriptionStore {
  const memory = new MemoryWebhookSubscriptionStore();
  return {
    persistent: true,
    insert: (record) => memory.insert(record),
    list: () => memory.list(),
  };
}

function subscription(addresses: string[] = [OTHER]) {
  return {
    subscriptionId: "subscription-1",
    eventTypes: ["wallet_activity"],
    target: { url: "https://home.example/api/webhooks/cdp" },
    labels: { network: "base-mainnet", wallet_addresses: addresses.join(",") },
    isEnabled: true,
  };
}

describe("CDP balance webhook subscriptions", () => {
  test("re-lists before PUT and confirms the address after a successful update", async () => {
    const requests: string[] = [];
    let updated = false;
    const manager = createCdpWebhookSubscriptions({
      env,
      store: persistentStore(),
      generateJwtImpl: jwt as never,
      fetchImpl: async (_input, init) => {
        const method = init?.method ?? "GET";
        requests.push(method);
        if (method === "PUT") updated = true;
        return Response.json({ subscriptions: [subscription(updated ? [OTHER, ADDRESS] : [OTHER])] });
      },
    });
    await manager.ensureAddressSubscribed(ADDRESS);
    expect(requests).toEqual(["GET", "GET", "PUT", "GET"]);
  });

  test("creates a subscription and persists its one-time signing SECRET when no candidate has room", async () => {
    const store = persistentStore();
    const requests: Array<{ method: string; body: unknown }> = [];
    const manager = createCdpWebhookSubscriptions({
      env,
      store,
      generateJwtImpl: jwt as never,
      fetchImpl: async (_input, init) => {
        const method = init?.method ?? "GET";
        requests.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
        return method === "POST"
          ? Response.json({ subscriptionId: "new-subscription", secret: "one-time-value" })
          : Response.json({ subscriptions: [] });
      },
    });
    await manager.ensureAddressSubscribed(ADDRESS);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(requests[1]?.body).toEqual({
      eventTypes: ["wallet_activity"],
      target: { url: "https://home.example/api/webhooks/cdp" },
      labels: { network: "base-mainnet", wallet_addresses: ADDRESS },
      isEnabled: true,
    });
    expect(await store.list()).toEqual([expect.objectContaining({
      subscriptionId: "new-subscription",
      secret: "one-time-value",
    })]);
  });

  test("registration is disabled once per instance without persistent storage", async () => {
    const failures: string[] = [];
    let calls = 0;
    const manager = createCdpWebhookSubscriptions({
      env,
      store: new MemoryWebhookSubscriptionStore(),
      fetchImpl: async () => { calls += 1; return Response.json({}); },
      logFailure: (reason) => failures.push(reason),
    });
    await manager.ensureAddressSubscribed(ADDRESS);
    await manager.ensureAddressSubscribed(OTHER);
    expect(calls).toBe(0);
    expect(failures).toEqual(["subscription-persistence-unavailable"]);
  });

  test("enables production or an explicit origin only", () => {
    expect(deploymentWebhookOrigin({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "home.example" })).toBeNull();
    expect(deploymentWebhookOrigin({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "home.example" })).toBe("https://home.example");
    expect(deploymentWebhookOrigin({ HOME_WEBHOOK_ORIGIN: "https://preview.example" })).toBe("https://preview.example");
  });

  test("uses the CDP subscription endpoint", () => {
    expect(CDP_WEBHOOK_SUBSCRIPTIONS_PATH).toBe("/platform/v2/data/webhooks/subscriptions");
  });
});
