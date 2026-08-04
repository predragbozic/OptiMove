import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import athletesRouter from "./routes/athletes.js";
import authRouter from "./routes/auth.js";
import plansRouter from "./routes/plans.js";
import templatesRouter from "./routes/templates.js";
import exercisesRouter from "./routes/exercises.js";
import builderRouter from "./routes/builder.js";
import organizationRouter from "./routes/organization.js";
import coachesRouter from "./routes/coaches.js";
import notificationsRouter from "./routes/notifications.js";
import messagesRouter from "./routes/messages.js";
import taxonomyRouter from "./routes/taxonomy.js";
import { attachAuthorizationContext, authMiddleware, requireAuth, requireCoach } from "./auth.js";
import { pool } from "./db.js";
import { realtimeRouter } from "./realtime.js";

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
app.use(attachAuthorizationContext);

app.get("/api/health", async (_req, res, next) => {
  try {
    const result = await pool.query("select now() as now");
    res.json({
      ok: true,
      dbTime: result.rows[0].now,
      commit: process.env.RENDER_GIT_COMMIT || null,
      deployedAt: process.env.RENDER_DEPLOY_CREATED_AT || null,
    });
  } catch (error) {
    next(error);
  }
});

app.use("/api/auth", authRouter);
app.use("/api/athletes", requireAuth, athletesRouter);
app.use("/api/admin/athletes", requireAuth, athletesRouter);
app.use("/api/plans", requireAuth, plansRouter);
app.use("/api/templates", requireAuth, templatesRouter);
app.use("/api/exercises", requireAuth, requireCoach, exercisesRouter);
app.use("/api/builder", requireAuth, requireCoach, builderRouter);
app.use("/api/organization", requireAuth, requireCoach, organizationRouter);
app.use("/api/taxonomy", requireAuth, requireCoach, taxonomyRouter);
app.use("/api/coaches", requireAuth, coachesRouter);
app.use("/api/notifications", requireAuth, notificationsRouter);
app.use("/api/messages", requireAuth, messagesRouter);
app.get("/api/realtime", requireAuth, realtimeRouter);

// This is a plain ES-modules frontend with no build step: script imports (e.g.
// "./builder-view.js") carry no cache-busting hash, and browsers cache compiled
// ES modules more aggressively than typical HTTP caching -- a stale module can
// keep getting reused across reloads (even hard reloads) independent of the HTML
// page. Force revalidation on every request so a deploy is never masked by a
// cached JS/CSS file.
app.use(express.static(frontendDir, {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
}));
app.get(["/", "/app", "/invite", "/join"], (_req, res) => {
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

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  app.listen(port, () => {
    console.log(`Optimove backend listening on http://localhost:${port}`);
  });
}

export { app };
