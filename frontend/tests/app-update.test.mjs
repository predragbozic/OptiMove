import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// A newer deploy than the one the app runs: the installed iPhone app keeps an
// old version until iOS restarts it, so a notice at the top offers Refresh
// and Later. Shown only when there is a newer deploy; never refreshes by
// itself; Refresh holds back while work is in progress (a leave guard) and
// asks about an in-app draft first.

const dom = new JSDOM("<!doctype html><html><head></head><body><main id=\"content\"></main></body></html>", { pretendToBeVisual: true, url: "https://optimove.test/" });
const { window } = dom;
const doc = window.document;
const update = await import("../app-update.js");

const health = (commit, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => ({ ok: true, commit }) });
let deployed = "aaaaaaa1111111";
let failing = null;
const calls = [];
const fetchImpl = async (url, options) => {
  calls.push({ url, options });
  if (failing === "network") throw new TypeError("Failed to fetch");
  if (failing === "500") return health(null, { ok: false, status: 500 });
  return health(deployed);
};
let clock = 0;
const now = () => clock;
let reloads = 0;
const reload = () => { reloads += 1; };
const banner = () => doc.getElementById("app-update-banner");
const options = (extra = {}) => ({ fetchImpl, doc, win: window, now, reload, ...extra });
async function newerDeploy(extra = {}) {
  await update.checkForAppUpdate(options({ force: true, ...extra }));
  deployed = "bbbbbbb2222222";
  return update.checkForAppUpdate(options({ force: true, ...extra }));
}

beforeEach(() => {
  update.resetAppUpdateWatch();
  banner()?.remove();
  doc.head.querySelector('meta[name="optimove-build"]')?.remove();
  deployed = "aaaaaaa1111111";
  failing = null;
  calls.length = 0;
  clock = 0;
  reloads = 0;
});

test("1. the first answer is the version this page runs: nothing is shown; the same version later shows nothing either; asked fresh and without the session cookie", async () => {
  assert.equal(await update.checkForAppUpdate(options({ force: true })), false);
  assert.equal(banner(), null);
  clock += update.APP_UPDATE_MIN_GAP_MS;
  assert.equal(await update.checkForAppUpdate(options()), false);
  assert.equal(banner(), null, "no notice without a newer deploy");
  assert.equal(calls[0].url, "/api/health");
  assert.equal(calls[0].options.cache, "no-store", "never answered from a cache");
  assert.equal(calls[0].options.credentials, "omit", "no session lookup for a public answer");
});

test("2. a newer deploy shows the notice once, at the top, with Refresh and Later, announced to screen readers", async () => {
  assert.equal(await newerDeploy(), true);
  const shown = banner();
  assert.ok(shown, "shown");
  assert.equal(shown.getAttribute("role"), "alert");
  assert.equal(shown.querySelector(".app-update-text").textContent, "A new version of OptiMove is available.");
  assert.equal(shown.querySelector("[data-app-update-refresh]").textContent, "Refresh");
  assert.equal(shown.querySelector("[data-app-update-later]").textContent, "Later");
  assert.equal(shown.querySelector("[data-app-update-busy]").hidden, true);
  assert.equal(shown.parentElement, doc.body, "outside the app's content, which repaints");
  clock += update.APP_UPDATE_MIN_GAP_MS;
  await update.checkForAppUpdate(options());
  assert.equal(doc.querySelectorAll("#app-update-banner").length, 1, "never twice");
});

test("3. Refresh reloads; with an upload or a save on its way (a leave guard holds) it says so and does not reload; an in-app draft is asked about first", async () => {
  let leave = false;
  const asked = [];
  await newerDeploy({ mayLeave: () => { asked.push(1); return leave; } });
  const guard = (event) => event.preventDefault();
  window.addEventListener("beforeunload", guard);
  banner().querySelector("[data-app-update-refresh]").click();
  assert.equal(reloads, 0, "not while work is on its way");
  assert.equal(asked.length, 0, "the draft question is not asked while work is on its way");
  assert.equal(banner().querySelector("[data-app-update-busy]").hidden, false);
  assert.equal(banner().querySelector("[data-app-update-busy]").textContent, "Something is still being saved or uploaded. Refresh when it is done.");
  window.removeEventListener("beforeunload", guard);
  banner().querySelector("[data-app-update-refresh]").click();
  assert.equal(asked.length, 1, "an in-app draft is asked about");
  assert.equal(reloads, 0, "declined: no reload");
  assert.equal(banner().querySelector("[data-app-update-busy]").textContent, "Not refreshed: finish or discard your open changes first.", "and it says why");
  leave = true;
  banner().querySelector("[data-app-update-refresh]").click();
  assert.equal(reloads, 1, "then it refreshes");
  assert.equal(update.workInProgress(window), false);
});

test("4. Later hides the notice; the next check that still finds a newer deploy shows it again, without the old sentence", async () => {
  await newerDeploy();
  const guard = (event) => event.preventDefault();
  window.addEventListener("beforeunload", guard);
  banner().querySelector("[data-app-update-refresh]").click();
  window.removeEventListener("beforeunload", guard);
  assert.equal(banner().querySelector("[data-app-update-busy]").hidden, false);
  clock += update.APP_UPDATE_MIN_GAP_MS;
  await update.checkForAppUpdate(options());
  assert.equal(banner().querySelector("[data-app-update-busy]").hidden, true, "the sentence was about the last tap");
  banner().querySelector("[data-app-update-later]").click();
  assert.equal(banner(), null, "hidden");
  assert.equal(reloads, 0);
  clock += update.APP_UPDATE_MIN_GAP_MS;
  assert.equal(await update.checkForAppUpdate(options()), true);
  assert.ok(banner(), "back on the next check");
});

test("5. a failed or odd answer is no news: no notice, no error, and the version is still learnt later", async () => {
  for (const mode of ["network", "500"]) {
    failing = mode;
    assert.equal(await update.checkForAppUpdate(options({ force: true })), false, mode);
  }
  failing = null;
  for (const odd of [null, "", "not a commit", "<script>", 42]) {
    deployed = odd;
    assert.equal(await update.checkForAppUpdate(options({ force: true })), false, String(odd));
  }
  assert.equal(banner(), null);
  deployed = "ccccccc3333333";
  await update.checkForAppUpdate(options({ force: true }));
  deployed = "ddddddd4444444";
  assert.equal(await update.checkForAppUpdate(options({ force: true })), true, "learnt on the first good answer, then compared");
});

test("6. at most one check a minute (the app coming back to the screen again and again)", async () => {
  await update.checkForAppUpdate(options({ force: true }));
  const before = calls.length;
  clock += update.APP_UPDATE_MIN_GAP_MS - 1;
  assert.equal(await update.checkForAppUpdate(options()), false);
  assert.equal(calls.length, before, "not asked again within the minute");
  clock += 1;
  await update.checkForAppUpdate(options());
  assert.equal(calls.length, before + 1);
});

test("7. the watch: the page's own build version counts from the start; it checks when the app comes back to the screen and on a timer, never while hidden", async () => {
  const meta = doc.createElement("meta");
  meta.setAttribute("name", "optimove-build");
  meta.setAttribute("content", "eeeeeee5555555");
  doc.head.appendChild(meta);
  assert.equal(update.buildVersion(doc), "eeeeeee5555555");
  deployed = "fffffff6666666"; // already newer than the build when the page starts
  const timers = [];
  const win = new Proxy(window, { get: (target, key) => (key === "setInterval" ? (fn, ms) => { timers.push({ fn, ms }); return 7; } : key === "clearInterval" ? () => {} : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  try {
    update.startAppUpdateWatch({ fetchImpl, doc, win, now, reload });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(banner(), "the build is older than the deploy: shown at once");
    assert.equal(timers[0].ms, update.APP_UPDATE_CHECK_MS);
    banner().remove();
    update.startAppUpdateWatch({ fetchImpl, doc, win, now, reload });
    assert.equal(timers.length, 1, "started once");
    const before = calls.length;
    clock += update.APP_UPDATE_MIN_GAP_MS;
    Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "hidden" });
    doc.dispatchEvent(new window.Event("visibilitychange"));
    timers[0].fn();
    assert.equal(calls.length, before, "nothing while hidden");
    Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "visible" });
    doc.dispatchEvent(new window.Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, before + 1, "checked when back on screen");
    assert.ok(banner(), "and shown again");
  } finally {
    delete doc.visibilityState;
  }
  meta.setAttribute("content", "not-a-commit");
  assert.equal(update.buildVersion(doc), "", "an odd stamp is no stamp");
  meta.remove();
  assert.equal(update.buildVersion(doc), "", "no stamp outside a production build");
});

test("8. wiring: app.js starts the watch with the Training Load draft question; the production build stamps the deploy commit into the HTML (not the bundles); the notice sits at the top, clear of the notch, under every overlay, with 44 px buttons", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /import \{ startAppUpdateWatch \} from "\.\/app-update\.js";/);
  assert.match(app, /renderRailState\(\);\s+(\/\/[^\n]*\n\s+)*startAppUpdateWatch\(\{ mayLeave: \(\) => confirmLeaveTrainingLoad\(null, \{ discard: false \}\) \}\);/);
  const vite = readFileSync(new URL("../vite.config.js", import.meta.url), "utf8");
  assert.match(vite, /process\.env\.RENDER_GIT_COMMIT/);
  assert.match(vite, /transformIndexHtml: \(\) => \(\/\^\[0-9a-f\]\{7,40\}\$\/i\.test\(buildCommit\) \? \[\{ tag: "meta", attrs: \{ name: "optimove-build", content: buildCommit \}, injectTo: "head" \}\] : \[\]\)/);
  assert.match(vite, /plugins: \[buildStamp\]/);
  assert.doesNotMatch(vite, /define:/, "no stamp inside the bundles");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = css.indexOf(".app-update-banner {");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /position: fixed;/);
  assert.match(rule, /top: calc\(env\(safe-area-inset-top, 0px\) \+ 8px\);/);
  assert.match(rule, /z-index: 50;/, "above the sticky top bars (40-45), under every menu and overlay (55 and up)");
  assert.match(rule, /margin-inline: auto;/);
  assert.match(css, /\.app-update-refresh,\n\.app-update-later \{\n  min-height: 44px;/);
  assert.match(css, /\.app-update-actions \.app-update-later \{\n  min-width: 44px;\n  padding: 0 8px;/);
  assert.match(css, /body\.messages-open \.app-update-banner,\nbody:has\(#notificationPanel:not\(\[hidden\]\)\) \.app-update-banner,\nbody:has\(#workspacePanel:not\(\[hidden\]\)\) \.app-update-banner \{\n  display: none;/, "it steps aside for the top bar's own panels");
});
