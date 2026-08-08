// hotfix/render-vite-install: reproduces the exact failure Render hit -
// `sh: 1: vite: not found` - by running a clean install + build in an
// isolated copy of frontend/, under the same environment shape Render's
// build step runs under (NODE_ENV=production, plus npm's own
// production-config/omit=dev knobs, which npm may set independently of
// NODE_ENV). Vite is a frontend devDependency (it's a build-time tool, never
// a runtime backend dependency and never served as a dev server in
// production - see DEPLOY.md) - a plain `npm ci` under a "production-ish"
// npm config can skip devDependencies entirely, which is exactly what broke
// the Render build. `--include=dev` (root package.json's build script) is
// what this script proves actually works.
//
// This is a manually-run maintenance check, not part of `npm test` itself -
// invoke it with `npm run verify:render-build` from the repo root. It never
// touches the real frontend/node_modules or frontend/dist - everything runs
// inside a fresh OS temp directory that is always removed afterward, even on
// failure.
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.join(repoRoot, "frontend");

function log(message) {
  console.log(message);
}

function copyFrontendSourceOnly(destDir) {
  cpSync(frontendDir, destDir, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(frontendDir, source);
      // node_modules/dist are the two directories a real Render checkout
      // would never have either - excluding them here is what makes this a
      // genuine clean-install simulation instead of accidentally reusing
      // this machine's already-installed vite.
      if (rel === "node_modules" || rel.startsWith(`node_modules${path.sep}`)) return false;
      if (rel === "dist" || rel.startsWith(`dist${path.sep}`)) return false;
      return true;
    },
  });
}

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "optimove-render-build-"));
  const isolatedFrontend = path.join(tempDir, "frontend");
  log(`Isolated copy: ${isolatedFrontend}`);
  try {
    copyFrontendSourceOnly(isolatedFrontend);
    if (existsSync(path.join(isolatedFrontend, "node_modules"))) {
      throw new Error("isolated copy must never carry over an existing node_modules - the whole point is a Render-clean install");
    }
    if (existsSync(path.join(isolatedFrontend, "dist"))) {
      throw new Error("isolated copy must never carry over an existing dist");
    }

    // Simulate exactly the environment shape Render's build step runs
    // under: NODE_ENV=production for the whole build/deploy, AND (since
    // Render or any other host could plausibly set this independently)
    // npm's own config knobs that skip devDependencies - the precise
    // combination this hotfix guards against.
    const env = {
      ...process.env,
      NODE_ENV: "production",
      npm_config_production: "true",
      npm_config_omit: "dev",
    };

    log("Running: npm ci --include=dev (isolated copy, NODE_ENV=production, npm_config_production=true, npm_config_omit=dev)");
    const install = spawnSync("npm ci --include=dev", { cwd: isolatedFrontend, shell: true, env, encoding: "utf8" });
    if (install.status !== 0) {
      console.error(install.stdout);
      console.error(install.stderr);
      throw new Error(`npm ci --include=dev failed with exit code ${install.status}`);
    }

    const viteBinary = path.join(isolatedFrontend, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
    if (!existsSync(viteBinary)) {
      throw new Error(`vite was not installed - expected ${viteBinary} to exist after npm ci --include=dev`);
    }
    log(`vite binary present: ${viteBinary}`);

    log("Running: npm run build (isolated copy)");
    const build = spawnSync("npm run build", { cwd: isolatedFrontend, shell: true, env, encoding: "utf8" });
    if (build.status !== 0) {
      console.error(build.stdout);
      console.error(build.stderr);
      throw new Error(`npm run build failed with exit code ${build.status}`);
    }

    const indexHtml = path.join(isolatedFrontend, "dist", "index.html");
    const athleteHtml = path.join(isolatedFrontend, "dist", "athlete.html");
    if (!existsSync(indexHtml)) throw new Error(`missing ${indexHtml}`);
    if (!existsSync(athleteHtml)) throw new Error(`missing ${athleteHtml}`);
    log("dist/index.html and dist/athlete.html both exist.");

    log(
      "VERIFY PASSED: a clean, isolated install (NODE_ENV=production and npm's own dev-omitting config both set, simulating Render) still installs Vite via --include=dev and produces a working production build.",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("verify-render-build FAILED:", error.message);
  process.exitCode = 1;
});
