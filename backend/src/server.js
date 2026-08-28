import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import athletesRouter from "./routes/athletes.js";
import athleteHomeRouter from "./routes/athleteHome.js";
import athleteProfileRouter from "./routes/athleteProfile.js";
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
import testsRouter from "./routes/tests.js";
import testsCheckInRouter from "./routes/testsCheckIn.js";
import trainingLoadRouter from "./routes/trainingLoad.js";
import { attachAuthorizationContext, authMiddleware, requireAuth, requireCoach } from "./auth.js";
import { pool } from "./db.js";
import { realtimeRouter } from "./realtime.js";
import { assertEmailConfigValid } from "./email.js";

const app = express();
const port = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === "production";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "../../frontend");
// perf/frontend-production-build: in production, serve the built,
// hashed-and-minified frontend/dist (see frontend/vite.config.js) instead
// of the raw source directory. Dev/test keep serving frontendDir directly,
// unbuilt - the existing practical dev flow (`npm run dev` / `node --watch`)
// and the existing frontend test suite (which imports frontend/*.js source
// modules directly - see frontend/tests/*.test.mjs) are both untouched.
const distDir = path.join(frontendDir, "dist");
const staticRoot = isProduction ? distDir : frontendDir;
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
app.use("/api/athlete-home", requireAuth, athleteHomeRouter);
app.use("/api/athlete-profile", requireAuth, athleteProfileRouter);
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
// Public check-in link (feature/tests-wellness-phase2) - mounted BEFORE the
// requireAuth-gated /api/tests below so /api/tests/check-in/:token is
// reachable with no session at all (it requires login inline, only once it
// actually needs to resolve an athlete's own assignment - see
// backend/src/routes/testsCheckIn.js).
app.use("/api/tests/check-in", testsCheckInRouter);
app.use("/api/tests", requireAuth, testsRouter);
app.use("/api/training-load", requireAuth, trainingLoadRouter);
app.get("/api/realtime", requireAuth, realtimeRouter);

// Dev/test: this is a plain ES-modules frontend with no build step - script
// imports (e.g. "./builder-view.js") carry no cache-busting hash, and
// browsers cache compiled ES modules more aggressively than typical HTTP
// caching, so a stale module can keep getting reused across reloads (even
// hard reloads) independent of the HTML page. Force revalidation on every
// request so a local reload is never masked by a cached JS/CSS file.
//
// Production: staticRoot is frontend/dist (see above). Its hashed
// assets/* files (e.g. app-CB0IK9wT.js) are safe to cache forever - a new
// deploy always emits new hashed filenames, never reuses an old one - but
// index.html/athlete.html themselves must stay revalidate-on-every-request
// (same as dev), since THEY are what point at the current deploy's hashed
// filenames; caching them long-lived would keep serving a stale deploy's
// asset references after a new one ships.
const distAssetsDir = path.join(distDir, "assets") + path.sep;
app.use(express.static(staticRoot, {
  setHeaders: (res, filePath) => {
    if (isProduction && filePath.startsWith(distAssetsDir)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));
// res.sendFile() applies its own default Cache-Control (from the `send`
// package) and does NOT run through express.static's setHeaders above, so
// these routes must set the header themselves - otherwise these five paths
// would silently diverge from the "/" request (served by express.static's
// own directory-index handling, which DOES go through setHeaders) even
// though both must behave identically: revalidate on every request, never
// long-lived, so a new deploy's hashed asset references are picked up
// immediately.
function sendHtmlEntry(res, fileName) {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(staticRoot, fileName));
}
app.get(["/", "/app", "/invite", "/join", "/verify-email", "/forgot-password", "/reset-password", "/confirm-email-change"], (_req, res) => {
  sendHtmlEntry(res, "index.html");
});
app.get("/athlete", (_req, res) => {
  sendHtmlEntry(res, "athlete.html");
});
// Public schedule check-in link (feature/tests-wellness-phase2) - a coach
// pastes this into a WhatsApp/Viber group chat, so it must resolve to a real
// page for someone who isn't logged in (or isn't even on this device) yet.
// Served from the athlete shell (see frontend/app.js's pathname bypass in
// init()) since resolving a check-in always ends at one athlete's own
// assignment, never a coach view.
app.get("/tests/check-in/:token", (_req, res) => {
  sendHtmlEntry(res, "athlete.html");
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
  // Refuses to start at all in production if the configured email provider
  // is missing what it needs (see backend/src/email.js) - a no-op outside
  // production, so local dev/tests are never affected.
  assertEmailConfigValid();
  // Refuses to start at all in production if frontend/dist wasn't built -
  // silently falling back to serving nothing (or, worse, stale raw source)
  // would look like a healthy deploy while actually serving a broken or
  // missing frontend. A no-op outside production, so local dev/tests
  // (which serve frontendDir directly, unbuilt) are never affected.
  if (isProduction && (!existsSync(path.join(distDir, "index.html")) || !existsSync(path.join(distDir, "athlete.html")))) {
    throw new Error(
      `Production frontend build is missing: ${distDir} has no index.html/athlete.html. ` +
        "Run `npm run build` in frontend/ (wired into the root build step - see package.json) before starting the server in production.",
    );
  }
  app.listen(port, () => {
    console.log(`Optimove backend listening on http://localhost:${port}`);
  });
}

export { app };
