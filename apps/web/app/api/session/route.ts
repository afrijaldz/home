import { issueCdpRenderHint } from "@/server/auth/cdp-render-session";
import { isHomeSessionConfigured } from "@/server/auth/native-base-session";
import { getCdpAccessTokenValidator } from "@/server/cdp/provider";
import { createSessionHandler } from "@/server/cdp/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sessionSecret = process.env.HOME_SESSION_SECRET;
const configured = isHomeSessionConfigured(sessionSecret);

export const GET = createSessionHandler({
  getValidator: getCdpAccessTokenValidator,
  homeSessionSecret: sessionSecret,
  baseAccountEnabled: configured,
  issueCookies: configured
    ? (session, request) => issueCdpRenderHint(sessionSecret, session, request)
    : undefined,
});
