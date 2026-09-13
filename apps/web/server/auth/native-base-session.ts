import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { createPublicClient, getAddress, http } from "viem";
import { base } from "viem/chains";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { BASE_CHAIN_ID, type VerifiedAccountSession } from "@/shared/account/session-types";
import { resolveBaseRpcUrl } from "@/server/chain/rpc";
import { HOME_CDP_LIVE_COOKIE, HOME_CDP_SESSION_COOKIE } from "@/server/auth/cdp-render-session";
import {
  clearCookie,
  cookie,
  equalText,
  readCookie,
  readSignedValue,
  requestOrigin,
  signedValue,
} from "@/server/auth/signed-cookie";

export { clearCookie, cookie, readCookie, readSignedValue, signedValue } from "@/server/auth/signed-cookie";

export const HOME_SESSION_COOKIE = "home-session";
export const HOME_CHALLENGE_COOKIE = "home-auth-challenge";
export const NATIVE_BASE_NONCE_TTL_MS = 5 * 60 * 1000;
export const NATIVE_BASE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 96 * 1024;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const signaturePattern = /^0x(?:[0-9a-fA-F]{2})+$/;

function normalizeSecret(secret: string | undefined | null): Buffer | null {
  const value = secret?.trim();
  if (!value || Buffer.byteLength(value, "utf8") < 32) return null;
  return Buffer.from(value, "utf8");
}

export function isHomeSessionConfigured(secret: string | undefined): boolean {
  return normalizeSecret(secret) !== null;
}

function isSameOriginPost(request: Request): boolean {
  if (request.method !== "POST") return false;
  const expected = requestOrigin(request)?.origin;
  const rawOrigin = request.headers.get("origin");
  if (!expected || !rawOrigin || rawOrigin === "null") return false;
  try {
    const supplied = new URL(rawOrigin);
    if (supplied.origin !== rawOrigin || supplied.origin !== expected) return false;
  } catch {
    return false;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}

function json(body: unknown, status: number, cookies: string[] = []): Response {
  const headers: Array<[string, string]> = [
    ["Cache-Control", "private, no-store, max-age=0"],
    ["Pragma", "no-cache"],
    ["Vary", "Cookie, Authorization, X-Home-Account-Provider"],
    ...cookies.map((value): [string, string] => ["Set-Cookie", value]),
  ];
  return Response.json(body, { status, headers });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string" || !addressPattern.test(value)) return null;
  try {
    return getAddress(value).toLowerCase() as `0x${string}`;
  } catch {
    return null;
  }
}

function sessionForAddress(address: `0x${string}`): VerifiedAccountSession {
  const digest = createHash("sha256").update(address).digest("hex").slice(0, 32);
  return {
    user: { subject: `base-${digest}` },
    smartAccount: { address, chainId: BASE_CHAIN_ID },
    accountProvider: "base-account",
  };
}

type SessionTokenPayload = {
  version: 1;
  session: VerifiedAccountSession;
  issuedAt: string;
  expiresAt: string;
};

function issueSessionToken(
  secret: Buffer,
  address: `0x${string}`,
  now: Date,
): { token: string; session: VerifiedAccountSession } {
  const session = sessionForAddress(address);
  const payload: SessionTokenPayload = {
    version: 1,
    session,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + NATIVE_BASE_SESSION_TTL_MS).toISOString(),
  };
  return { token: signedValue(secret, JSON.stringify(payload)), session };
}

export type NativeBaseSessionRead =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; session: VerifiedAccountSession };

export function readNativeBaseSessionToken(
  token: string,
  secretValue: string | undefined = process.env.HOME_SESSION_SECRET,
  now: Date = new Date(),
): Exclude<NativeBaseSessionRead, { kind: "absent" }> {
  const secret = normalizeSecret(secretValue);
  if (!secret) return { kind: "invalid" };
  const raw = readSignedValue(secret, token);
  if (!raw) return { kind: "invalid" };
  try {
    const payload = JSON.parse(raw) as SessionTokenPayload;
    const address = normalizeAddress(payload?.session?.smartAccount?.address);
    if (
      payload.version !== 1 ||
      payload.session.accountProvider !== "base-account" ||
      payload.session.smartAccount?.chainId !== BASE_CHAIN_ID ||
      !address ||
      payload.session.user.subject !== sessionForAddress(address).user.subject ||
      !Number.isFinite(Date.parse(payload.issuedAt)) ||
      Date.parse(payload.expiresAt) <= now.getTime()
    ) return { kind: "invalid" };
    return { kind: "valid", session: sessionForAddress(address) };
  } catch {
    return { kind: "invalid" };
  }
}

export function readNativeBaseSession(
  request: Request,
  secretValue: string | undefined = process.env.HOME_SESSION_SECRET,
  now: Date = new Date(),
): NativeBaseSessionRead {
  const found = readCookie(request, HOME_SESSION_COOKIE);
  if (!found.present) return { kind: "absent" };
  if (!found.value) return { kind: "invalid" };
  return readNativeBaseSessionToken(found.value, secretValue, now);
}

export type NativeBaseAuthDependencies = {
  sessionSecret?: string;
  now?: () => Date;
  randomId?: () => string;
  verify?: (input: {
    address: `0x${string}`;
    domain: string;
    message: string;
    nonce: string;
    signature: `0x${string}`;
  }) => Promise<boolean>;
};

function dependencies(input: NativeBaseAuthDependencies) {
  const now = input.now ?? (() => new Date());
  return {
    secret: normalizeSecret(input.sessionSecret ?? process.env.HOME_SESSION_SECRET),
    now,
    randomId: input.randomId ?? (() => randomBytes(24).toString("hex")),
    verify: input.verify ?? (async (value) => {
      const client = createPublicClient({
        chain: base,
        transport: http(resolveBaseRpcUrl()),
      });
      return client.verifySiweMessage(value);
    }),
  };
}

export function createNativeBaseNonceHandler(input: NativeBaseAuthDependencies = {}) {
  return async function POST(request: Request): Promise<Response> {
    const deps = dependencies(input);
    const origin = requestOrigin(request);
    const body = await readBody(request);
    const address = normalizeAddress(body?.address);
    if (!deps.secret) return json({ error: { code: "AUTH_UNAVAILABLE" } }, 503);
    if (!origin || !address) return json({ error: { code: "INVALID_REQUEST" } }, 400);

    const issuedAt = deps.now();
    const expiresAt = new Date(issuedAt.getTime() + NATIVE_BASE_NONCE_TTL_MS);
    const nonce = deps.randomId();
    if (!/^[0-9a-f]{48}$/.test(nonce)) return json({ error: { code: "AUTH_UNAVAILABLE" } }, 503);
    const message = createSiweMessage({
      address,
      chainId: BASE_CHAIN_ID,
      domain: origin.host,
      uri: origin.origin,
      version: "1",
      nonce,
      issuedAt,
      expirationTime: expiresAt,
      statement: "Sign in to Home.",
    });
    const challenge = signedValue(deps.secret, JSON.stringify({
      version: 1,
      address,
      origin: origin.origin,
      messageHash: createHash("sha256").update(message).digest("base64url"),
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }));
    return json(
      { message, expiresAt: expiresAt.toISOString() },
      200,
      [cookie(HOME_CHALLENGE_COOKIE, challenge, request, NATIVE_BASE_NONCE_TTL_MS / 1000)],
    );
  };
}

export function createNativeBaseVerifyHandler(input: NativeBaseAuthDependencies = {}) {
  return async function POST(request: Request): Promise<Response> {
    const deps = dependencies(input);
    const clearChallenge = clearCookie(HOME_CHALLENGE_COOKIE, request);
    const origin = requestOrigin(request);
    const body = await readBody(request);
    const message = typeof body?.message === "string" && body.message.length <= 16_384
      ? body.message
      : null;
    const signature = typeof body?.signature === "string" &&
      body.signature.length <= 65_536 && signaturePattern.test(body.signature)
      ? body.signature.toLowerCase() as `0x${string}`
      : null;
    const challengeCookie = readCookie(request, HOME_CHALLENGE_COOKIE);
    if (!deps.secret) return json({ error: { code: "AUTH_UNAVAILABLE" } }, 503, [clearChallenge]);
    if (!origin || !message || !signature || !challengeCookie.value) {
      return json({ error: { code: "INVALID_AUTH_PROOF" } }, 401, [clearChallenge]);
    }
    const rawChallenge = readSignedValue(deps.secret, challengeCookie.value);
    let challenge: {
      address: `0x${string}`;
      origin: string;
      messageHash: string;
      nonce: string;
      issuedAt: string;
      expiresAt: string;
    } | null = null;
    try {
      const parsed = JSON.parse(rawChallenge ?? "null") as Record<string, unknown> | null;
      const address = normalizeAddress(parsed?.address);
      const issuedAt = typeof parsed?.issuedAt === "string" ? Date.parse(parsed.issuedAt) : Number.NaN;
      const expiresAt = typeof parsed?.expiresAt === "string" ? Date.parse(parsed.expiresAt) : Number.NaN;
      if (
        parsed?.version === 1 &&
        address &&
        parsed.origin === origin.origin &&
        typeof parsed.messageHash === "string" &&
        typeof parsed.nonce === "string" && /^[0-9a-f]{48}$/.test(parsed.nonce) &&
        Number.isFinite(issuedAt) &&
        Number.isFinite(expiresAt) &&
        expiresAt > deps.now().getTime() &&
        expiresAt - issuedAt === NATIVE_BASE_NONCE_TTL_MS &&
        equalText(parsed.messageHash, createHash("sha256").update(message).digest("base64url"))
      ) {
        challenge = {
          address,
          origin: parsed.origin,
          messageHash: parsed.messageHash,
          nonce: parsed.nonce,
          issuedAt: parsed.issuedAt as string,
          expiresAt: parsed.expiresAt as string,
        };
      }
    } catch {
      challenge = null;
    }
    if (!challenge) return json({ error: { code: "INVALID_AUTH_PROOF" } }, 401, [clearChallenge]);

    const parsed = parseSiweMessage(message);
    if (
      parsed.address?.toLowerCase() !== challenge.address ||
      parsed.chainId !== BASE_CHAIN_ID ||
      parsed.domain !== origin.host ||
      parsed.uri !== challenge.origin ||
      parsed.nonce !== challenge.nonce ||
      parsed.issuedAt?.toISOString() !== challenge.issuedAt ||
      parsed.expirationTime?.toISOString() !== challenge.expiresAt
    ) return json({ error: { code: "INVALID_AUTH_PROOF" } }, 401, [clearChallenge]);

    let verified = false;
    try {
      verified = await deps.verify({
        address: challenge.address,
        domain: origin.host,
        message,
        nonce: parsed.nonce,
        signature,
      });
    } catch {
      return json({ error: { code: "AUTH_UNAVAILABLE" } }, 503, [clearChallenge]);
    }
    if (!verified) return json({ error: { code: "INVALID_AUTH_PROOF" } }, 401, [clearChallenge]);

    const issued = issueSessionToken(deps.secret, challenge.address, deps.now());
    return json(issued.session, 200, [
      clearChallenge,
      cookie(HOME_SESSION_COOKIE, issued.token, request, NATIVE_BASE_SESSION_TTL_MS / 1000),
    ]);
  };
}

export function createNativeBaseLogoutHandler() {
  return async function POST(request: Request): Promise<Response> {
    if (!isSameOriginPost(request)) {
      return json({ error: { code: "INVALID_REQUEST" } }, 403);
    }
    return json({ signedOut: true }, 200, [
      clearCookie(HOME_CHALLENGE_COOKIE, request),
      clearCookie(HOME_SESSION_COOKIE, request),
      clearCookie(HOME_CDP_SESSION_COOKIE, request),
      clearCookie(HOME_CDP_LIVE_COOKIE, request),
    ]);
  };
}
