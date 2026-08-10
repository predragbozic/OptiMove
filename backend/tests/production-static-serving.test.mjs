import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// perf/frontend-production-build: proves backend/src/server.js's production
// static-serving path (dist cache headers, HTML entry routing, the
// fail-fast dist-missing startup check) against REAL spawned server
// processes - not the shared `app` import other test files use, since
// isProduction/staticRoot/distDir are all computed once at module load
// time from process.env.NODE_ENV, and every other test file in this suite
// deliberately runs in non-production mode. Each test here spawns its own
// `node src/server.js` child so NODE_ENV=production only ever applies
// inside that child's own process, never to this test file's own process
// or to any other test file running in the same `npm test` run.

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.resolve(backendDir, "../frontend");
const distDir = path.join(frontendDir, "dist");
const distBackupDir = path.join(frontendDir, "dist.production-static-serving-test-backup");

// A throwaway, non-functional email config - just enough to satisfy
// assertEmailConfigValid() so these tests exercise the dist-serving/startup
// logic specifically, not the (separately tested, in email-service.test.mjs)
// email config validation. No real email is ever sent by these tests.
const fixtureEmailEnv = {
  EMAIL_PROVIDER: "brevo",
  BREVO_API_KEY: "production-static-serving-test-fixture-key",
  EMAIL_FROM: "Test Fixture <test-fixture@test.local>",
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  });
}

before(() => {
  const result = spawnSync("npm run build", { cwd: frontendDir, shell: true, encoding: "utf8" });
  assert.equal(result.status, 0, `frontend build must succeed before these tests can run - stderr:\n${result.stderr}`);
});

test("1. production startup fails clearly and non-zero when frontend/dist is missing", () => {
  assert.ok(existsSync(distDir), "dist must exist before this test can temporarily hide it");
  if (existsSync(distBackupDir)) rmSync(distBackupDir, { recursive: true, force: true });
  renameSync(distDir, distBackupDir);
  try {
    const result = spawnSync("node", ["src/server.js"], {
      cwd: backendDir,
      env: { ...process.env, NODE_ENV: "production", ...fixtureEmailEnv },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.notEqual(result.status, 0, "server must exit non-zero when frontend/dist is missing in production");
    assert.match(result.stderr, /frontend build is missing/i, "the error must clearly name the problem");
    assert.match(result.stderr, /npm run build/, "the error must say how to fix it");
  } finally {
    renameSync(distBackupDir, distDir);
  }
});

test("2. production server serves hashed assets, HTML entries, and never SPA-falls-back /api/* or unknown paths", async (t) => {
  const port = await getFreePort();
  const child = spawn("node", ["src/server.js"], {
    cwd: backendDir,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), ...fixtureEmailEnv },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => killChild(child));

  const healthy = await waitForHealth(port);
  assert.ok(healthy, `production server must become healthy on port ${port} - stderr so far:\n${stderr}`);

  await t.test("2a. GET / serves index.html, no-cache, referencing a real hashed asset", async () => {
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    const html = await res.text();
    const match = html.match(/\/assets\/app-[A-Za-z0-9_-]+\.js/);
    assert.ok(match, "index.html must reference a hashed app-*.js asset");
  });

  await t.test("2b. the hashed JS asset is served with a public, immutable, one-year cache header", async () => {
    const indexHtml = await (await fetch(`http://localhost:${port}/`)).text();
    const assetPath = indexHtml.match(/\/assets\/app-[A-Za-z0-9_-]+\.js/)[0];
    const res = await fetch(`http://localhost:${port}${assetPath}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  });

  await t.test("2c. /app, /invite, /join, /verify-email, /forgot-password, /reset-password, /confirm-email-change all serve the same index.html, no-cache (never immutable)", async () => {
    const indexBody = await (await fetch(`http://localhost:${port}/`)).text();
    // /confirm-email-change (security/verified-email-change) was originally
    // missing from this whitelist in backend/src/server.js - the real email
    // link 404'd on direct navigation despite the SPA route existing in
    // frontend/app.js. Caught by manual browser verification, not by this
    // test, since this list previously stopped at /reset-password.
    for (const routePath of ["/app", "/invite", "/join", "/verify-email", "/forgot-password", "/reset-password", "/confirm-email-change"]) {
      const res = await fetch(`http://localhost:${port}${routePath}`);
      assert.equal(res.status, 200, `${routePath} must return 200`);
      assert.equal(res.headers.get("cache-control"), "no-cache", `${routePath} must be no-cache, never immutable`);
      const body = await res.text();
      assert.equal(body, indexBody, `${routePath} must serve the exact same index.html as /`);
    }
  });

  await t.test("2d. /athlete serves athlete.html (distinct from index.html), no-cache", async () => {
    const res = await fetch(`http://localhost:${port}/athlete`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    const body = await res.text();
    assert.match(body, /athlete-mode/, "athlete.html must be the athlete shell, not index.html");
  });

  await t.test("2e. an unknown /api/* path returns a JSON 404, never HTML", async () => {
    const res = await fetch(`http://localhost:${port}/api/this-route-does-not-exist`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.equal(body.error, "Not found");
  });

  await t.test("2f. a genuinely unknown, non-API path returns a JSON 404 too - no SPA wildcard fallback swallows it into HTML", async () => {
    const res = await fetch(`http://localhost:${port}/this-page-was-never-registered-anywhere`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
  });

  await t.test("2g. a real API route (auth/me, unauthenticated) still returns JSON, unaffected by static serving changes", async () => {
    const res = await fetch(`http://localhost:${port}/api/auth/me`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.equal(body.user, null);
  });
});
