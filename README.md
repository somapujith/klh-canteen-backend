# KLH Canteen Backend

Node.js + Express + PostgreSQL (Prisma) API for the KLH Pantry App.

## Local dev

```bash
cp .env.example .env
docker compose up -d
npm install
npx prisma migrate dev
npm run dev
```

Server runs on http://localhost:4000. Health check: `GET /health`.

## Deploy (Cloudflare Workers)

### Prerequisites

- A Cloudflare account.
- The `wrangler` CLI: `npm install -g wrangler` (or just use `npx wrangler`
  for the commands below).
- `wrangler login` to authenticate the CLI with your Cloudflare account.

### One-time setup

1. Create a Neon Postgres database, copy its connection string.
2. Create the KV namespace used for rate limiting:

   ```bash
   npx wrangler kv namespace create RATE_LIMIT_KV
   ```

   Paste the returned namespace id into the `kv_namespaces` binding in
   `wrangler.jsonc`.
3. The Durable Object used for real-time SSE is applied automatically as a
   migration on the first `wrangler deploy`, as long as its class is
   exported from the Worker entrypoint and bound in `wrangler.jsonc` — no
   manual migration step needed.
4. Set secrets (these prompt for a value interactively and are never
   committed to the repo):

   ```bash
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put QR_TOKEN_SECRET
   npx wrangler secret put DATABASE_URL
   ```
5. Set `CORS_ORIGIN` (the deployed frontend URL) as a plain var in
   `wrangler.jsonc` — it isn't sensitive, so it doesn't need to be a secret.

### Local dev

```bash
npm run dev
```

This runs `wrangler dev` (check `package.json` for the exact script if it's
been renamed).

### Deploy

```bash
npm run deploy
```

(or `npx wrangler deploy` if no `deploy` script exists yet).

### Database migrations

Prisma migrations still run from a local machine — Workers doesn't run
migrations itself. The database is the same Neon Postgres instance; only
the compute layer moved to Cloudflare. Run, pointed at the prod
`DATABASE_URL`:

```bash
npm run migrate:deploy
```

Seed the first admin the same way: run `npm run seed:admin` locally pointed
at the prod `DATABASE_URL`.

### Result

The API is served from `klh-canteen-backend.somapujith.workers.dev`. Point
the frontend's `VITE_API_URL` there.

## API summary

- `POST /auth/login`
- `GET /menu`
- `POST /orders`, `GET /orders/my`, `GET /orders/:id`
- `POST /admin/students/bulk`
- `POST/PATCH/DELETE /admin/categories`, `/admin/menu-items`
- `GET /admin/orders/scan/:token`, `POST /admin/orders/:id/deliver`
