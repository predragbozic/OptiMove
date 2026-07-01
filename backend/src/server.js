import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import athletesRouter from "./routes/athletes.js";
import authRouter from "./routes/auth.js";
import plansRouter from "./routes/plans.js";
import templatesRouter from "./routes/templates.js";
import exercisesRouter from "./routes/exercises.js";
import builderRouter from "./routes/builder.js";
import organizationRouter from "./routes/organization.js";
import { authMiddleware, requireAuth, requireCoach } from "./auth.js";
import { pool } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === "production";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "../../frontend");
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(corsOrigins.length ? cors({ origin: corsOrigins }) : cors());
app.use(express.json());
app.use(authMiddleware);

app.get("/api/health", async (_req, res, next) => {
  try {
    const result = await pool.query("select now() as now");
    res.json({ ok: true, dbTime: result.rows[0].now });
  } catch (error) {
    next(error);
  }
});

app.use("/api/auth", authRouter);
app.use("/api/athletes", requireAuth, athletesRouter);
app.use("/api/admin/athletes", requireAuth, athletesRouter);
app.use("/api/plans", requireAuth, plansRouter);
app.use("/api/templates", requireAuth, requireCoach, templatesRouter);
app.use("/api/exercises", requireAuth, requireCoach, exercisesRouter);
app.use("/api/builder", requireAuth, requireCoach, builderRouter);
app.use("/api/organization", requireAuth, requireCoach, organizationRouter);

app.use(express.static(frontendDir));
app.get(["/", "/app", "/invite"], (_req, res) => {
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
  const status = Number(error.status || error.statusCode || 500);
  res.status(status).json({
    error: status >= 500 ? "Internal server error" : error.message,
    message: status >= 500 && isProduction ? "Something went wrong." : error.message,
  });
});

app.listen(port, () => {
  console.log(`Optimove backend listening on http://localhost:${port}`);
});
