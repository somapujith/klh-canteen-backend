import express, { Express } from "express";
import cors from "cors";

export function createApp(): Express {
  const app = express();
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*" }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
