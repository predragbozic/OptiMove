import { defineConfig } from "vite";
import { resolve } from "node:path";

// perf/frontend-production-build: production-only build config. This file
// is never loaded by `node --test` (the existing frontend suite imports
// source .js modules directly - see frontend/tests/*.test.mjs) and never
// loaded by the plain dev flow (backend/src/server.js still serves
// frontend/ directly with `node --watch` - see backend's README/dev script).
// It only runs when someone explicitly runs `npm run build` in this
// directory, which is wired into the root/Render build step.
//
// Two real HTML entry points exist (see frontend/index.html and
// frontend/athlete.html) - both load the SAME frontend/app.js as their
// only <script type="module"> tag, and app.js itself branches at runtime
// on window.location.pathname for the public /invite, /join, and
// /verify-email flows (see app.js's init()). Vite's default multi-page
// model (one Rollup input per HTML file) handles this correctly: it
// discovers app.js and styles.css from each HTML file's own tags,
// dedupes the shared module graph into a common chunk, and rewrites each
// HTML file's tags to point at the hashed output - no separate "join" or
// "invite" HTML entry is needed because none exists today.
const rootDir = import.meta.dirname;

export default defineConfig({
  root: rootDir,
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Never embed a source map in a production artifact that's served
    // publicly - no monitoring/error-reporting process in this repo
    // consumes one today (see security audit in this PR's commit message).
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(rootDir, "index.html"),
        athlete: resolve(rootDir, "athlete.html"),
      },
    },
  },
  // No .env file exists in frontend/ and no source file reads
  // import.meta.env or process.env (api.js talks to the API with a
  // same-origin relative path - see frontend/api.js) - nothing for Vite
  // to inline here, and this PR intentionally introduces no VITE_* vars.
});
