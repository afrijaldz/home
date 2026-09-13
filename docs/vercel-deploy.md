# Vercel deploy (bun monorepo)

This is an operator build-settings note, not production authorization.

## Project settings

Keep **Root Directory** at the repository root so the root lockfile and workspace scripts apply.

| Setting | Value |
| --- | --- |
| Root Directory | Repository root |
| Framework preset | Next.js |
| Install Command | `bun install --frozen-lockfile` |
| Build Command | `bun run build` |
| Node.js | 22+ |

### Skew Protection

For the Vercel project `home-web`, **Project Settings → Advanced → Skew Protection** is enabled with a 12-hour max age.

Next exposes the serving deployment ID to client code, and Home adds it as the `x-deployment-id` header on client requests to `/api/*`. No environment variable is required. We use the explicit header rather than the alternative experimental `experimental.useSkewCookie` option.

Verify against a preview after an older deployment passes the configured max age:

```sh
# Set <old dpl id>, <current dpl id>, and <preview> from the Vercel preview deployments.
curl -sI -H "x-deployment-id: <old dpl id>" https://<preview>/api/market-prices    # 404 (expected; verify once on a preview)
curl -sI -H "x-deployment-id: <current dpl id>" https://<preview>/api/market-prices # 200
```

## Environment

Copy names from [`.env.example`](../.env.example); keep values in Vercel or gitignored `apps/web/.env.local`. Never expose server keys with `NEXT_PUBLIC_`.

Actions and balance observations require server-only `DATABASE_URL`; Home connects to PostgreSQL via `pg`, so Neon works as a regular Postgres database; keep `?sslmode=require` (or `verify-full`) in the URL and use Neon's pooled hostname on Vercel. Apply the disposable schema with `bun run db:migrate` (idempotent; safe on a database bootstrapped by the earlier runtime DDL). Configure server-only `BASE_RPC_URL` for hosted Base reads. Email sign-in requires the CDP project ID plus server validation keys. See [CDP setup](cdp-setup.md) for allowed origins.

## CDP balance activity webhook

Configure `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `HOME_WEBHOOK_ORIGIN` in the target environment. `HOME_WEBHOOK_ORIGIN` is the public HTTPS deployment origin without a path. Create the initial subscription once from a trusted operator shell, passing one to 100 lowercase smart-account addresses:

```sh
cd apps/web
HOME_WEBHOOK_ORIGIN=https://home.example bun run webhooks:register -- 0x1111111111111111111111111111111111111111
```

The command prints the subscription id and the one-time signing secret. Store that secret as the server-only `CDP_WEBHOOK_SECRET` in the same Vercel environment; never commit or prefix it with `NEXT_PUBLIC_`. Redeploy after setting it. Runtime balance reads only list existing subscriptions and use CDP's full-subscription update endpoint to add addresses to a subscription with room; runtime never creates a subscription because Home would have nowhere safe to persist a newly returned signing secret. Use another operator registration when every existing subscription has 100 addresses.

Verify in preview by sending a real CDP test delivery to `/api/webhooks/cdp`, confirming a 200 response, then confirming the next authenticated balance read fully re-observes. A missed delivery remains bounded by the 120-second balance backstop.

The action contract is [Actions](actions.md) under [Architecture](architecture.md): Home records confirmed actions, while CDP/Base and Base receipts provide execution status. A green deployment does not authorize a real-money launch.
