import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// The web app manifest and its icons, so "Add to Home screen" on a phone
// shows the OptiMove logo and opens the app without the browser's address
// bar. They live in frontend/public/ (Vite's publicDir): the production build
// copies that folder to the root of frontend/dist, and the dev server serves
// it at the root too (backend/src/server.js), so every URL below is
// root-absolute and must resolve to a file in frontend/public/.

const frontendDir = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(frontendDir, "public");
const manifest = JSON.parse(readFileSync(path.join(publicDir, "manifest.webmanifest"), "utf8"));

function publicFile(url) {
  assert.match(url, /^\/[a-z0-9/_.-]+$/, `${url} must be a root-absolute path`);
  return path.join(publicDir, url.slice(1));
}

function pngSize(file) {
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} is not a PNG`);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

test("1. the manifest names the app and opens it at the root, without the browser UI", () => {
  assert.equal(manifest.name, "OptiMove");
  assert.equal(manifest.short_name, "OptiMove");
  // "/" also serves athletes: app.js sends an athlete workspace on to /athlete.
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.display, "standalone");
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/);
});

test("2. every manifest icon exists as a PNG of exactly its declared size, any and maskable at 192 and 512", () => {
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    assert.equal(pngSize(publicFile(icon.src)), icon.sizes, icon.src);
  }
  for (const purpose of ["any", "maskable"]) {
    for (const sizes of ["192x192", "512x512"]) {
      assert.ok(
        manifest.icons.some((icon) => icon.purpose === purpose && icon.sizes === sizes),
        `missing a ${purpose} icon of ${sizes}`,
      );
    }
  }
});

for (const page of ["index.html", "athlete.html"]) {
  test(`3. ${page} links the manifest, the favicon and the iPhone icon, and every link resolves`, () => {
    const html = readFileSync(path.join(frontendDir, page), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    const href = (rel) => head.match(new RegExp(`<link rel="${rel}"[^>]*href="([^"]+)"`))?.[1];

    assert.equal(href("manifest"), "/manifest.webmanifest");
    assert.ok(existsSync(publicFile(href("manifest"))));
    assert.equal(pngSize(publicFile(href("icon"))), "32x32");
    assert.equal(pngSize(publicFile(href("apple-touch-icon"))), "180x180");
    assert.match(head, new RegExp(`<meta name="theme-color" content="${manifest.theme_color}">`));
  });
}
