import { issueCdpRenderHint } from "@/server/auth/cdp-render-session";
import { isHomeSessionConfigured } from "@/server/auth/native-base-session";
import { getCdpAccessTokenValidator } from "@/server/cdp/provider";
import { createSessionHandler } from "@/server/cdp/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The only handler instance that issues the CDP render hint. The shared
// `authorizeSession` boundary used by every other `/api/*` route never does,
// so the hint has no API authority. The validator, gate, and secret are all
// resolved per request rather than captured at module evaluation, matching
// `server/auth/authorize.ts`, so module import order cannot pin them.
export const GET = createSessionHandler({
  getValidator: () => getCdpAccessTokenValidator(),
  baseAccountEnabled: () => isHomeSessionConfigured(process.env.HOME_SESSION_SECRET),
  issueCookies: (session, request) =>
    issueCdpRenderHint(process.env.HOME_SESSION_SECRET, session, request),
});
