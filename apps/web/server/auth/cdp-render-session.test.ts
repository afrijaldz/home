import { describe, expect, test } from "bun:test";
import { type VerifiedAccountSession } from "@/shared/account/session-types";
import { signedValue } from "@/server/auth/signed-cookie";
import {
  HOME_CDP_LIVE_COOKIE,
  HOME_CDP_SESSION_COOKIE,
  issueCdpRenderHint,
  readCdpRenderSession,
  type RenderCookieStore,
} from "./cdp-render-session";

const KEY = "render-session-test-key-at-least-32-bytes";
const NOW = new Date("2026-09-13T12:00:00.000Z");
const REQUEST = new Request("https://home.example/api/session");
const SESSION: VerifiedAccountSession = {
  user: { subject: "cdp-user-123" },
  smartAccount: {
    address: "0xabcdef0123456789abcdef0123456789abcdef01",
    chainId: 8453,
  },
  accountProvider: "cdp-embedded",
};

describe("CDP render session", () => {
  test("issues and validates only a complete, well-formed cookie pair", () => {
    const issued = issueCdpRenderHint(KEY, SESSION, REQUEST, NOW);
    expect(issued).toHaveLength(2);
    expect(issued[0]).toContain(`${HOME_CDP_SESSION_COOKIE}=`);
    expect(issued[0]).toContain("HttpOnly");
    expect(issued[1]).toContain(`${HOME_CDP_LIVE_COOKIE}=`);
    expect(issued[1]).not.toContain("HttpOnly");
    expect(issued.every((value) =>
      value.includes("Path=/") &&
      value.includes("SameSite=Lax") &&
      value.includes("Max-Age=86400") &&
      value.includes("Secure")
    )).toBe(true);

    const validEntries = issued.map(parseSetCookie);
    const valid = cookieStore(validEntries);
    const live = validEntries.find(([name]) => name === HOME_CDP_LIVE_COOKIE)![1];
    const signed = validEntries.find(([name]) => name === HOME_CDP_SESSION_COOKIE)![1];
    const cases: Array<{
      name: string;
      cookies: RenderCookieStore;
      now?: Date;
      expected: VerifiedAccountSession | null;
    }> = [
      { name: "valid pair", cookies: valid, expected: SESSION },
      {
        name: "missing live cookie",
        cookies: cookieStore([[HOME_CDP_SESSION_COOKIE, signed]]),
        expected: null,
      },
      {
        name: "nonce mismatch",
        cookies: cookieStore([
          [HOME_CDP_SESSION_COOKIE, signed],
          [HOME_CDP_LIVE_COOKIE, "f".repeat(48)],
        ]),
        expected: null,
      },
      {
        name: "expired",
        cookies: valid,
        now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1),
        expected: null,
      },
      {
        name: "bad HMAC",
        cookies: cookieStore([
          [HOME_CDP_SESSION_COOKIE, tamper(signed)],
          [HOME_CDP_LIVE_COOKIE, live],
        ]),
        expected: null,
      },
      {
        name: "base-account provider",
        cookies: payloadCookies({
          provider: "base-account",
          session: { ...SESSION, accountProvider: "base-account" },
        }),
        expected: null,
      },
      {
        name: "malformed address",
        cookies: payloadCookies({
          session: {
            ...SESSION,
            smartAccount: { address: "not-an-address", chainId: 8453 },
          },
        }),
        expected: null,
      },
      {
        name: "duplicate cookie",
        cookies: cookieStore([...validEntries, [HOME_CDP_SESSION_COOKIE, signed]]),
        expected: null,
      },
    ];

    for (const entry of cases) {
      expect(
        readCdpRenderSession(entry.cookies, KEY, entry.now ?? NOW),
        entry.name,
      ).toEqual(entry.expected);
    }
  });
});

function payloadCookies(overrides: Record<string, unknown>): RenderCookieStore {
  const nonce = "a".repeat(48);
  const payload = {
    version: 1,
    provider: "cdp-embedded",
    session: SESSION,
    nonce,
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
  return cookieStore([
    [HOME_CDP_SESSION_COOKIE, signedValue(Buffer.from(KEY), JSON.stringify(payload))],
    [HOME_CDP_LIVE_COOKIE, nonce],
  ]);
}

function parseSetCookie(value: string): [string, string] {
  const first = value.slice(0, value.indexOf(";"));
  const separator = first.indexOf("=");
  return [first.slice(0, separator), first.slice(separator + 1)];
}

function cookieStore(entries: Array<[string, string]>): RenderCookieStore {
  return {
    getAll(name) {
      return entries
        .filter(([candidate]) => candidate === name)
        .map(([, value]) => ({ value }));
    },
  };
}

function tamper(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith("x") ? "y" : "x"}`;
}
