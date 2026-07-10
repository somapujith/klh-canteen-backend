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

## Deploy (Render)

1. Push this repo to GitHub.
2. Create a Neon Postgres database, copy its connection string.
3. In Render, "New +" → "Blueprint" → point at this repo (uses `render.yaml`).
4. Set env vars in Render dashboard: `DATABASE_URL` (Neon connection string),
   `JWT_SECRET`, `QR_TOKEN_SECRET` (random strings), `CORS_ORIGIN` (deployed
   frontend URL).
5. Seed the first admin after deploy: run `npm run seed:admin` locally
   pointed at the prod `DATABASE_URL`, or add a one-off Render job.

## API summary

- `POST /auth/login`
- `GET /menu`
- `POST /orders`, `GET /orders/my`, `GET /orders/:id`
- `POST /admin/students/bulk`
- `POST/PATCH/DELETE /admin/categories`, `/admin/menu-items`
- `GET /admin/orders/scan/:token`, `POST /admin/orders/:id/deliver`
