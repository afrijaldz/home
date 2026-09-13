# Base Account sign-in

Status: one Home-native mechanism as of #392 (issue #288, Jesse-locked September 11, 2026). Real Base Account signature compatibility still requires a manual user smoke with the intended wallet.

Home can show **Continue with email** and **Continue with Base Account** together in the existing sign-in sheet. Email authenticates through CDP when `NEXT_PUBLIC_CDP_PROJECT_ID` is configured. Base Account always uses Home-native SIWE, regardless of CDP configuration, and is available only when `HOME_SESSION_SECRET` is configured with at least 32 characters.

## Security boundary

The Home-native Base Account flow:

1. connects through `@base-org/account` on Base mainnet (`8453`);
2. requests `POST /api/auth/base/nonce`, which builds an EIP-4361 message for the connected address, current request domain and origin, a fresh nonce, and a five-minute expiry;
3. returns the message with a signed, HttpOnly `home-auth-challenge` cookie carrying the address, origin, message hash, nonce, issue time, and expiry;
4. signs the exact message with `personal_sign` and submits it to `POST /api/auth/base/verify`;
5. re-reads the challenge cookie, requires every message field to match, and verifies the signature with viem against Base; and
6. on success, issues an HMAC-signed `home-session` cookie that is `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, and valid for seven days.

The session subject derives from the verified, lowercased address. The browser's connected address is never accepted as session authority. Verification resolves smart-account signatures through ERC-1271 and ERC-6492 in viem and fails closed if the signature cannot be verified. Home creates no authentication database row; the signed challenge is the only nonce state.

A Bearer-validated CDP profile can create only a `cdp-embedded` email session. Requests whose explicit or restored CDP profile resolves to `base-account` receive `403 BASE_ACCOUNT_DISABLED`; Home never derives a Base Account session from a CDP token.

Account or chain changes during connection, signing, or verification invalidate the connector and hide the session. `POST /api/auth/base/logout` requires a same-origin request and clears `home-session`, `home-auth-challenge`, `home-cdp-session`, and `home-cdp-live`.

## CDP render hint

A successful Bearer-validated email session with a Base smart account also receives a 24-hour render-hint pair signed by `HOME_SESSION_SECRET`: HttpOnly `home-cdp-session` contains the validated session and a nonce, while readable `home-cdp-live` contains the same nonce. Both halves must be present and valid. The hint has no API authority; private API routes still require a fresh CDP access token. Server Components read a valid Home session first and then the hint, so a signed-in visit to `/` redirects before rendering to `/dashboard` while `/?account=signin` remains a loop-breaking sign-in destination.

## Operator setup

1. Set `HOME_SESSION_SECRET` to at least 32 characters in every environment where Base Account sign-in or CDP render hints should work. Keep it server-only; never use a `NEXT_PUBLIC_` prefix.
2. Configure `BASE_RPC_URL` when the deployment should use a dedicated Base mainnet RPC. Local development may use the documented public fallback.
3. Configure `NEXT_PUBLIC_CDP_PROJECT_ID`, `CDP_API_KEY_ID`, and `CDP_API_KEY_SECRET` only for email sign-in. Base Account does not require CDP SIWE, a CDP SIWE allowlist, or a separate public feature flag.
4. `DATABASE_URL` is not required for authentication itself because the flow is stateless.
5. Rotating `HOME_SESSION_SECRET` signs users out of Home-native sessions and invalidates existing render hints.

## Manual user smoke

No automated agent should perform this smoke because it opens a real wallet and requests a real signature.

1. Start Home on the intended origin and open `/?account=signin`.
2. Confirm email is available when CDP is configured and **Continue with Base Account** is available when `HOME_SESSION_SECRET` is configured.
3. Select the intended Base Account on Base mainnet (`8453`). Cancel once and verify Home remains signed out.
4. Retry and inspect the SIWE prompt: address, chain, domain, URI, nonce, and expiry must match the selected account and current Home origin.
5. Complete `personal_sign`. If verification fails, record only the sanitized Home error and stop; do not add a weaker fallback.
6. Confirm `/api/session` returns `accountProvider: "base-account"` and the selected address using the `home-session` cookie, with no Authorization header.
7. Confirm subsequent private API requests carry `X-Home-Account-Provider: base-account` and scope data to that verified address.
8. Reload `/` and confirm the server redirects to `/dashboard`. Open `/?account=signin` and confirm it still renders the sign-in sheet.
9. Change account or chain during a second attempt and confirm the flow fails closed.
10. Sign out and confirm private details disappear, all four Home cookies are cleared, and reloading remains signed out.

## History

Before #392, a configured CDP project selected a separate CDP SIWE hop while clones without a project used Home-native SIWE. That split implementation and the retired `NEXT_PUBLIC_ENABLE_BASE_ACCOUNT` flag are historical only; Base Account now always uses the Home-native route described above.

## References

- CDP email authentication: https://docs.cdp.coinbase.com/embedded-wallets/authentication/email
- Base Account `personal_sign`: https://docs.base.org/base-account/reference/core/provider-rpc-methods/personal_sign
- Base Account signature verification guide: https://docs.base.org/base-account/guides/verify-signatures
