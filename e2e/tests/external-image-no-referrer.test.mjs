// The hypothesis behind referrerpolicy="no-referrer", tested in a real browser instead of assumed: an image host
// with hotlink protection (403 when the request carries a Referer, 200 when it does not - what a direct visit in a
// new tab looks like) refuses a plain <img> on another site's page and serves the <img> the app now draws.
// Two local servers on different ports (different origins); no database, no account. Also what it does NOT fix:
// a host that forbids embedding outright (Cross-Origin-Resource-Policy: same-origin) stays hidden either way.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { launch } from "../lib/browser.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { matchMedia: () => ({ matches: false }) };
const { renderImage } = await import("../../frontend/media.js");
const { renderMetricIconHtml } = await import("../../frontend/icon-render.js");

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let browser, pages, images, imageOrigin, pageOrigin;
const seen = [];
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  images = http.createServer((req, res) => {
    const referer = req.headers.referer || "";
    seen.push({ path: req.url, referer });
    if (req.url.startsWith("/protected/") && referer) { res.writeHead(403, { "Content-Type": "text/plain" }); return res.end("hotlinking is not allowed"); }
    const headers = { "Content-Type": "image/png", "Cache-Control": "no-store" };
    if (req.url.startsWith("/corp/")) headers["Cross-Origin-Resource-Policy"] = "same-origin";
    res.writeHead(200, headers);
    res.end(PNG);
  });
  imageOrigin = await listen(images);
  pages = http.createServer((req, res) => {
    const logo = (name) => `${imageOrigin}/${name}`;
    const body = `<!doctype html><meta charset="utf-8"><title>Team Example</title>
      <div id="plain"><img class="organization-avatar" src="${logo("protected/plain.png")}" alt=""></div>
      <div id="app">${renderImage(logo("protected/logo.png"), "organization-avatar", "Club Example")}</div>
      <div id="icon">${renderMetricIconHtml(logo("protected/icon.png"))}</div>
      <div id="open">${renderImage(logo("open/logo.png"), "organization-avatar")}</div>
      <div id="corp">${renderImage(logo("corp/logo.png"), "organization-avatar")}</div>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  });
  pageOrigin = await listen(pages);
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await new Promise((r) => images?.close(r));
  await new Promise((r) => pages?.close(r));
});

test("a hotlink-protected host refuses a plain <img> and serves the app's; a direct visit is served; a host that forbids embedding is not fixed", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${pageOrigin}/settings/club?secret=1`, { waitUntil: "load" });
    await page.waitForFunction(() => [...document.images].every((img) => img.complete));
    const shown = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("div[id]")].map((d) => [d.id, d.querySelector("img").naturalWidth > 0])));
    assert.deepEqual(shown, { plain: false, app: true, icon: true, open: true, corp: false });
    const by = (path) => seen.find((r) => r.path === path);
    // What the image host was told: the plain <img> gave our origin away, the app's pictures gave nothing.
    assert.equal(by("/protected/plain.png").referer, `${pageOrigin}/`, "the browser's default sends the page's origin to another site");
    for (const path of ["/protected/logo.png", "/protected/icon.png", "/open/logo.png", "/corp/logo.png"]) assert.equal(by(path).referer, "", path);
    assert.ok(!seen.some((r) => r.referer.includes("secret")), "never the page's address");
    // The direct visit the owner made - a new tab on the picture's own address - sends no Referer and is served.
    const direct = await context.newPage();
    const answer = await direct.goto(`${imageOrigin}/protected/direct.png`);
    assert.equal(answer.status(), 200);
    assert.equal(by("/protected/direct.png").referer, "");
  } finally { await context.close(); }
});
