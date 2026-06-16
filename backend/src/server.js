import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import athletesRouter from "./routes/athletes.js";
import plansRouter from "./routes/plans.js";
import templatesRouter from "./routes/templates.js";
import exercisesRouter from "./routes/exercises.js";
import { pool } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 3001);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "../../frontend");
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(corsOrigins.length ? cors({ origin: corsOrigins }) : cors());
app.use(express.json());

app.get("/api/health", async (_req, res, next) => {
  try {
    const result = await pool.query("select now() as now");
    res.json({ ok: true, dbTime: result.rows[0].now });
  } catch (error) {
    next(error);
  }
});

app.get("/api/db-config-check", (_req, res) => {
  const value = process.env.DATABASE_URL || "";
  let parsed = null;

  try {
    const url = new URL(value);
    parsed = {
      protocol: url.protocol,
      username: decodeURIComponent(url.username || ""),
      host: url.hostname,
      port: url.port,
      database: url.pathname.replace(/^\//, ""),
      hasPassword: Boolean(url.password),
    };
  } catch (error) {
    parsed = { error: error.message };
  }

  res.json({
    hasDatabaseUrl: Boolean(value),
    parsed,
  });
});

app.use("/api/athletes", athletesRouter);
app.use("/api/admin/athletes", athletesRouter);
app.use("/api/plans", plansRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/exercises", exercisesRouter);

app.use(express.static(frontendDir));
app.get(["/", "/app"], (_req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});
app.get("/athlete", (_req, res) => {
  res.sendFile(path.join(frontendDir, "athlete.html"));
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error", message: error.message });
});

app.listen(port, () => {
  console.log(`Optimove backend listening on http://localhost:${port}`);
});
