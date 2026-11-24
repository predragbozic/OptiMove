import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, relative, sep } from "node:path";

// React islands (owner, 2026-11-24): every new screen, and every screen substantially reworked, is a React component.
// The rest of the app stays plain ES modules, served unbuilt in dev and e2e (backend/src/server.js serves frontend/ as
// it is), so a browser there cannot read JSX or the CommonJS `react` packages. This config compiles the islands once:
//
//   frontend/react/*.jsx  --vite build (JSX, React bundled, production mode)-->  frontend/react-build/{islands,react}.js
//
// The output is committed, like frontend/vendor/: dev, e2e and the node tests load it as plain ES modules, and the
// production build (vite.config.js) bundles the same file. `npm run build` rebuilds it first, and
// tests/react-islands-build.test.mjs fails when the committed output differs from a fresh build of the source.
//
// An island imports the app's own plain modules (api.js, state.js, app-errors-capture.js, ...) by a relative path
// outside react/. Those stay EXTERNAL: the built file imports the very same module the plain app does (one state,
// one api() with the one session cookie), never a bundled copy of it. react/ and react-build/ sit at the same depth
// under frontend/, so "../api.js" means the same file from both.
const rootDir = import.meta.dirname;
const islandsDir = resolve(rootDir, "react");

export function isAppModule(id, importer) {
  // Only an island's own import: React's packages require their cjs/ files by relative paths too.
  if (!importer || !id.startsWith(".") || /[\\/]node_modules[\\/]/.test(importer)) return false;
  const target = resolve(importer, "..", id);
  const fromIslands = relative(islandsDir, target);
  return fromIslands.startsWith(`..${sep}`) || fromIslands.startsWith("../");
}

export default defineConfig({
  root: rootDir,
  logLevel: "warn",
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "react-build",
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    copyPublicDir: false,
    lib: { entry: resolve(islandsDir, "islands.jsx"), formats: ["es"], fileName: () => "islands.js" },
    rolldownOptions: {
      external: (id, importer) => isAppModule(id, importer),
      output: {
        // React itself in its own file, so a change to an island does not rewrite the whole React bundle.
        codeSplitting: { groups: [{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }] },
        chunkFileNames: "[name].js",
        // Vite leaves a library's ES output unminified; React's chunk would be about 0.5 MB of committed text.
        minify: true,
      },
    },
  },
});
