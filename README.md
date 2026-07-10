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
