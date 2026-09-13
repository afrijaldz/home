import { describe, expect, test } from "bun:test";
import type { VerifiedAccountSession } from "@/shared/account/session-types";
import type {
  FundingProvider,
  FundingProviderManifest,
  Instruction,
  QuoteIntent,
} from "@/shared/funding/provider-contract";
import { MemoryFundingOrderStore } from "./store";
import { FundingCore } from "./service";

const session: VerifiedAccountSession = { user: { subject: "user" }, accountProvider: "base-account", smartAccount: { address: "0x1111111111111111111111111111111111111111", chainId: 8453 } };
const manifest = { id: "fixture", displayName: "Fixture", docsUrl: "https://example.com", bindings: [{ region: "ID", assetId: "base:idrx", paymentMethods: [{ id: "bank", label: "Bank" }], env: ["FIXTURE_KEY"] }], apiOrigins: ["https://example.com"], reference: "home" } as const satisfies FundingProviderManifest;

function setup(outcome: "created" | "ambiguous" = "created") {
  let dispatches = 0;
  let blockReads = 0;
  let observation: "awaiting-payment" | "sent" = "awaiting-payment";
  let date = new Date("2026-09-12T00:00:00.000Z");
  const provider: FundingProvider = {
    manifest,
    async createOrder(input, ctx) {
      dispatches += 1;
      expect(input.destination).toBe(session.smartAccount!.address);
      if (outcome === "ambiguous") return { outcome: "ambiguous" };
      return { outcome: "created", order: { providerOrderId: "fixture-order", tokenAddress: ctx.binding.asset.address, expectedTokenAmountAtomic: input.quote!.tokenAmountAtomic, fees: [], expiresAt: null, instructions: { kind: "bank-transfer", rail: "VA", accountNumber: "12345678", amount: input.fiatAmount, currency: "IDR" } } };
    },
    async getOrder() { return { state: observation, providerStatus: observation, transactionHash: observation === "sent" ? `0x${"2".repeat(64)}` : null }; },
  };
  const core = new FundingCore({ providers: [provider], store: new MemoryFundingOrderStore(), env: { FIXTURE_KEY: "set", FUNDING_QUOTE_SECRET: "s".repeat(32) }, currentBaseBlock: async () => { blockReads += 1; return "500"; }, verifyReceipt: async (_order, hash) => ({ transactionHash: hash, logIndex: 4 }), now: () => date });
  return { core, dispatches: () => dispatches, blockReads: () => blockReads, advance(minutes: number) { date = new Date(date.getTime() + minutes * 60_000); }, sent() { observation = "sent"; date = new Date("2026-09-12T00:00:10.000Z"); } };
}

describe("FundingCore", () => {
  test("binds a quote to the verified destination and dispatches exactly once", async () => {
    const fixture = setup();
    const quote = await fixture.core.createQuote(session, { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000.00" }, "https://home.example");
    const first = await fixture.core.createOrder(session, { quoteToken: quote.quoteToken }, "https://home.example");
    const replay = await fixture.core.createOrder(session, { quoteToken: quote.quoteToken }, "https://home.example");
    expect(first.id).toBe(replay.id);
    expect(first.quoteToken).toBe(quote.quoteToken);
    expect(replay.quoteToken).toBe(quote.quoteToken);
    expect(fixture.dispatches()).toBe(1);
    expect(fixture.blockReads()).toBe(1);
    expect(first.state).toBe("awaiting-payment");
  });

  test("rejects noncanonical token aliases without a second block read or dispatch", async () => {
    const fixture = setup();
    const quote = await fixture.core.createQuote(session, { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000" }, "https://home.example");
    await fixture.core.createOrder(session, { quoteToken: quote.quoteToken }, "https://home.example");
    await expect(fixture.core.createOrder(session, { quoteToken: `${quote.quoteToken}=` }, "https://home.example")).rejects.toMatchObject({ code: "INVALID_QUOTE_TOKEN" });
    expect(fixture.blockReads()).toBe(1);
    expect(fixture.dispatches()).toBe(1);
  });

  test("recovers an existing reservation after token expiry but refuses a new expired intent", async () => {
    const fixture = setup();
    const existingQuote = await fixture.core.createQuote(session, { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000" }, "https://home.example");
    const created = await fixture.core.createOrder(session, { quoteToken: existingQuote.quoteToken }, "https://home.example");
    fixture.advance(6);
    const recovered = await fixture.core.createOrder(session, { quoteToken: existingQuote.quoteToken }, "https://home.example");
    expect(recovered.id).toBe(created.id);
    expect(fixture.blockReads()).toBe(1);
    expect(fixture.dispatches()).toBe(1);

    const fresh = setup();
    const expiredNew = await fresh.core.createQuote(session, { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "21000" }, "https://home.example");
    fresh.advance(6);
    await expect(fresh.core.createOrder(session, { quoteToken: expiredNew.quoteToken }, "https://home.example")).rejects.toMatchObject({ code: "INVALID_QUOTE_TOKEN" });
    expect(fresh.blockReads()).toBe(0);
    expect(fresh.dispatches()).toBe(0);
  });

  test("never retries an ambiguous create", async () => {
    const fixture = setup("ambiguous");
    const quote = await fixture.core.createQuote(session, { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000" }, "https://home.example");
    const first = await fixture.core.createOrder(session, { quoteToken: quote.quoteToken }, "https://home.example");
    const replay = await fixture.core.createOrder(session, { quoteToken: quote.quoteToken }, "https://home.example");
    expect(first.state).toBe("dispatch-ambiguous"); expect(replay.state).toBe("dispatch-ambiguous"); expect(replay.quoteToken).toBe(quote.quoteToken); expect(fixture.dispatches()).toBe(1);
    expect((await fixture.core.getOpenOrder(session, "ID"))?.id).toBe(first.id);
  });

  test("marks received only after receipt evidence is uniquely claimed", async () => {
    const fixture = setup();
    const quote = await fixture.core.createQuote(session, { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000" }, "https://home.example");
    const created = await fixture.core.createOrder(session, { quoteToken: quote.quoteToken }, "https://home.example");
    fixture.sent();
    const received = await fixture.core.getOrder(session, created.id);
    expect(received.state).toBe("received");
    expect(received.instructions).toBeNull();
  });

  test("logs unmatched webhooks without raw bodies or provider order identifiers", async () => {
    const events: Array<{ providerId: string; reason: "invalid" | "unmatched" }> = [];
    const provider: FundingProvider = { manifest, createOrder: async () => ({ outcome: "ambiguous" }), getOrder: async () => ({ state: "unknown", providerStatus: "unknown" }), verifyWebhook: () => ({ providerOrderId: "secret-provider-order" }) };
    const core = new FundingCore({ providers: [provider], store: new MemoryFundingOrderStore(), env: { FIXTURE_KEY: "set", FUNDING_QUOTE_SECRET: "s".repeat(32) }, currentBaseBlock: async () => "1", verifyReceipt: async () => null, logUnmatchedWebhook: (event) => events.push(event) });
    expect(await core.handleWebhook("fixture", new TextEncoder().encode("private-body"), new Headers())).toEqual({ accepted: true, matched: false });
    expect(events).toEqual([{ providerId: "fixture", reason: "unmatched" }]);
    expect(JSON.stringify(events)).not.toContain("secret-provider-order");
    expect(JSON.stringify(events)).not.toContain("private-body");
  });

  test("rejects a tampered quote before provider dispatch", async () => {
    const fixture = setup();
    const quote = await fixture.core.createQuote(session, { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000" }, "https://home.example");
    await expect(fixture.core.createOrder(session, { quoteToken: `${quote.quoteToken}x` }, "https://home.example")).rejects.toEqual(expect.objectContaining({ code: "INVALID_QUOTE_TOKEN" }));
    const otherOwner = { ...session, user: { subject: "other-user" } };
    await expect(fixture.core.createOrder(otherOwner, { quoteToken: quote.quoteToken }, "https://home.example")).rejects.toMatchObject({ code: "INVALID_QUOTE_TOKEN" });
    expect(fixture.blockReads()).toBe(0);
    expect(fixture.dispatches()).toBe(0);
  });

  test("passes the request origin return URL into provider quotes", async () => {
    const captured: QuoteIntent[] = [];
    const provider: FundingProvider = {
      manifest: { ...manifest, quotes: true },
      async createQuote(input) {
        captured.push(input);
        return {
          fiatAmount: input.fiatAmount,
          tokenAmountAtomic: "2000000",
          fees: [],
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
      async createOrder() { return { outcome: "ambiguous" }; },
      async getOrder() { return { state: "unknown", providerStatus: "unknown" }; },
    };
    const core = new FundingCore({
      providers: [provider],
      store: new MemoryFundingOrderStore(),
      env: { FIXTURE_KEY: "set", FUNDING_QUOTE_SECRET: "s".repeat(32) },
      currentBaseBlock: async () => "1",
      verifyReceipt: async () => null,
    });
    await core.createQuote(
      session,
      { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000" },
      "https://preview.home.example",
    );
    expect(captured[0]?.returnUrl).toBe("https://preview.home.example/fund?return=funding");
  });

  test("propagates provider quote transport errors for the route to report QUOTE_UNAVAILABLE", async () => {
    const providerError = Object.assign(new TypeError("synthetic quote timeout"), {
      code: "ETIMEDOUT",
    });
    const provider: FundingProvider = {
      manifest: { ...manifest, quotes: true },
      async createQuote() { throw providerError; },
      async createOrder() { return { outcome: "ambiguous" }; },
      async getOrder() { return { state: "unknown", providerStatus: "unknown" }; },
    };
    const core = new FundingCore({
      providers: [provider],
      store: new MemoryFundingOrderStore(),
      env: {
        FIXTURE_KEY: "set",
        FUNDING_QUOTE_SECRET: "x".repeat(32),
      },
      currentBaseBlock: async () => "1",
      verifyReceipt: async () => null,
    });

    try {
      await core.createQuote(
        session,
        { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000" },
        "https://home.example",
      );
      throw new Error("Expected provider quote error.");
    } catch (error) {
      expect(error).toBe(providerError);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ code: "ETIMEDOUT" });
    }
  });

  test("marks a contradictory post-create token echo dispatch-ambiguous", async () => {
    const core = coreWithInstruction(
      { kind: "bank-transfer", rail: "VA", accountNumber: "12345678", amount: "20000", currency: "IDR" },
      "1999999",
    );
    const quote = await core.createQuote(
      session,
      { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000" },
      "https://home.example",
    );
    const order = await core.createOrder(session, { quoteToken: quote.quoteToken }, "https://home.example");
    expect(order.state).toBe("dispatch-ambiguous");
    expect(order.instructions).toBeNull();
  });

  test("persists a safe embed instruction while awaiting payment", async () => {
    const instruction = {
      kind: "embed",
      url: "https://pay.example/apple-pay",
      presentation: "apple-pay",
      amount: "20.50",
      currency: "USD",
    } as const satisfies Instruction;
    const core = coreWithInstruction(instruction);
    const quote = await core.createQuote(
      session,
      { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000" },
      "https://home.example",
    );
    const order = await core.createOrder(
      session,
      { quoteToken: quote.quoteToken },
      "https://home.example",
    );

    expect(order.state).toBe("awaiting-payment");
    expect(order.instructions).toEqual(instruction);
  });

  test("marks unsafe redirect and embed instruction values dispatch-ambiguous", async () => {
    const scenarios: Array<
      | Extract<Instruction, { kind: "redirect" }>
      | Extract<Instruction, { kind: "embed" }>
    > = [
      { kind: "redirect", url: "https://evil.example/pay" },
      { kind: "redirect", url: "http://pay.example/pay" },
      { kind: "redirect", url: "https://user@pay.example/pay" },
      { kind: "embed", url: "https://pay.example/pay#secret", presentation: "apple-pay", amount: "20", currency: "USD" },
      { kind: "embed", url: `https://pay.example/${"x".repeat(4096)}`, presentation: "apple-pay", amount: "20", currency: "USD" },
      { kind: "embed", url: "https://pay.example/pay", presentation: "apple-pay", amount: "020", currency: "USD" },
      { kind: "embed", url: "https://pay.example/pay", presentation: "apple-pay", amount: "20", currency: "usd" },
    ];
    for (const instruction of scenarios) {
      const core = coreWithInstruction(instruction);
      const quote = await core.createQuote(
        session,
        { providerId: "fixture", region: "ID", paymentMethod: "bank", fiatAmount: "20000" },
        "https://home.example",
      );
      const order = await core.createOrder(session, { quoteToken: quote.quoteToken }, "https://home.example");
      expect(order.state, instruction.url).toBe("dispatch-ambiguous");
      expect(order.instructions).toBeNull();
    }
  });
});

function coreWithInstruction(
  instructions: Instruction,
  expectedTokenAmountAtomic = "2000000",
): FundingCore {
  const provider: FundingProvider = {
    manifest: { ...manifest, redirectOrigins: ["https://pay.example"] },
    async createOrder(_input, ctx) {
      return {
        outcome: "created",
        order: {
          providerOrderId: "fixture-order",
          tokenAddress: ctx.binding.asset.address,
          expectedTokenAmountAtomic,
          fees: [],
          expiresAt: null,
          instructions,
        },
      };
    },
    async getOrder() { return { state: "unknown", providerStatus: "unknown" }; },
  };
  return new FundingCore({
    providers: [provider],
    store: new MemoryFundingOrderStore(),
    env: { FIXTURE_KEY: "set", FUNDING_QUOTE_SECRET: "s".repeat(32) },
    currentBaseBlock: async () => "1",
    verifyReceipt: async () => null,
  });
}
