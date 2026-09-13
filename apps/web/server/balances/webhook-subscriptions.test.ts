import { describe, expect, test } from "bun:test";
import {
  CDP_WEBHOOK_SUBSCRIPTIONS_PATH,
  createCdpActivitySubscription,
  createCdpWebhookSubscriptions,
} from "./webhook-subscriptions";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const env = { CDP_API_KEY_ID: "key", CDP_API_KEY_SECRET: "secret" };
const jwt = async () => "fixture.jwt";

function subscription(addresses: string[] = [OTHER]) {
  return {
    subscriptionId: "subscription-1",
    eventTypes: ["wallet_activity"],
    target: { url: "https://home.example/api/webhooks/cdp" },
    labels: {
      network: "base-mainnet",
      wallet_addresses: addresses.join(","),
    },
    isEnabled: true,
  };
}

describe("CDP balance webhook subscriptions", () => {
  test("lists once, then PUTs a missing address into a subscription with room", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const manager = createCdpWebhookSubscriptions({
      env,
      generateJwtImpl: jwt as never,
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json(init?.method === "PUT" ? subscription([OTHER, ADDRESS]) : {
          subscriptions: [subscription()],
        });
      },
      now: () => 1_000,
    });
    await manager.ensureAddressSubscribed(ADDRESS);
    await manager.ensureAddressSubscribed(ADDRESS);
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
    expect(requests[1]?.url).toEndWith(`${CDP_WEBHOOK_SUBSCRIPTIONS_PATH}/subscription-1`);
    expect(requests[1]?.body).toEqual({
      eventTypes: ["wallet_activity"],
      target: { url: "https://home.example/api/webhooks/cdp" },
      labels: { network: "base-mainnet", wallet_addresses: `${OTHER},${ADDRESS}` },
      isEnabled: true,
    });
  });

  test("accepts a legacy snake_case list fixture and skips an existing address", async () => {
    let calls = 0;
    const manager = createCdpWebhookSubscriptions({
      env,
      generateJwtImpl: jwt as never,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ subscriptions: [{
          id: "legacy",
          event_type: "wallet.activity.multi",
          event_filters: [{ network: "base-mainnet", addresses: [ADDRESS] }],
          notification_uri: "https://home.example/api/webhooks/cdp",
        }] });
      },
    });
    await manager.ensureAddressSubscribed(ADDRESS);
    expect(calls).toBe(1);
  });

  test("a full or missing subscription is non-fatal and emits one failure", async () => {
    const failures: string[] = [];
    const full = Array.from({ length: 100 }, (_, index) =>
      `0x${(index + 10).toString(16).padStart(40, "0")}`
    );
    const manager = createCdpWebhookSubscriptions({
      env,
      generateJwtImpl: jwt as never,
      fetchImpl: async () => Response.json({ subscriptions: [subscription(full)] }),
      logFailure: (reason) => failures.push(reason),
    });
    await expect(manager.ensureAddressSubscribed(ADDRESS)).resolves.toBeUndefined();
    expect(failures).toEqual(["no-subscription-with-room"]);
  });

  test("operator creation targets Home and returns the one-time secret", async () => {
    let requestBody: unknown;
    const created = await createCdpActivitySubscription({
      origin: "https://home.example",
      addresses: [ADDRESS],
      env,
      generateJwtImpl: jwt as never,
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ subscriptionId: "new-subscription", metadata: { secret: "hook-secret" } });
      },
    });
    expect(created).toEqual({ id: "new-subscription", secret: "hook-secret" });
    expect(requestBody).toEqual({
      eventTypes: ["wallet_activity"],
      target: { url: "https://home.example/api/webhooks/cdp" },
      labels: { network: "base-mainnet", wallet_addresses: ADDRESS },
      isEnabled: true,
    });
  });
});
