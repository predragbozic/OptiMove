// A new version of OptiMove after a deploy. The app installed on an iPhone
// home screen keeps running the version it was opened with until iOS
// restarts it (it has no service worker, and switching apps only resumes
// it), so this notices a newer deploy and shows a notice at the top of the
// screen with Refresh and Later. It never refreshes by itself, and Refresh
// holds back while work is in progress: an upload or a save the app's leave
// guards know about (beforeunload), or an in-app draft the caller's
// `mayLeave` asks about. Shown only when there is something to refresh;
// Later hides it until the app next checks and still finds a newer deploy.
//
// Versions are deploy commits: the one this page was built from (a
// <meta name="optimove-build"> the production build adds, see
// vite.config.js) or, without one, the first one /api/health reports; later
// /api/health answers are compared with it.

export const APP_UPDATE_CHECK_MS = 15 * 60 * 1000; // while the app is open and on screen
export const APP_UPDATE_MIN_GAP_MS = 60 * 1000; // a check at most once a minute (the app coming back to the screen)
const BANNER_ID = "app-update-banner";
const BUSY_TEXT = "Something is still being saved or uploaded. Refresh when it is done.";
const DRAFT_TEXT = "Not refreshed: finish or discard your open changes first.";
const COMMIT = /^[0-9a-f]{7,40}$/i;

export function buildVersion(doc = globalThis.document) {
  const stamp = String(doc?.querySelector?.('meta[name="optimove-build"]')?.getAttribute("content") || "").trim();
  return COMMIT.test(stamp) ? stamp : "";
}

const watch = { loaded: "", latest: "", lastCheck: -Infinity, stop: null, started: false };

// Tests start over from here.
export function resetAppUpdateWatch() {
  watch.stop?.();
  Object.assign(watch, { loaded: "", latest: "", lastCheck: -Infinity, stop: null, started: false });
}

// Without the session cookie: the version is public, and a signed-in check
// would cost the server a session and rights lookup each time.
async function readDeployedVersion(fetchImpl) {
  const response = await fetchImpl("/api/health", { cache: "no-store", credentials: "omit", headers: { Accept: "application/json" } });
  if (!response?.ok) return "";
  const data = await response.json();
  const commit = typeof data?.commit === "string" ? data.commit.trim() : "";
  return COMMIT.test(commit) ? commit : "";
}

// True when a leave guard of the app would hold a reload back (an upload or a
// save on its way): the same check the browser makes before leaving the page.
export function workInProgress(win = globalThis.window) {
  if (!win?.dispatchEvent) return false;
  const probe = new win.Event("beforeunload", { cancelable: true });
  win.dispatchEvent(probe);
  return probe.defaultPrevented;
}

export function renderAppUpdateBannerHtml() {
  return `
    <p class="app-update-text">A new version of OptiMove is available.</p>
    <div class="app-update-actions">
      <button class="plain-button compact-button app-update-refresh" type="button" data-app-update-refresh>Refresh</button>
      <button class="text-action app-update-later" type="button" data-app-update-later>Later</button>
    </div>
    <p class="app-update-busy" data-app-update-busy hidden>${BUSY_TEXT}</p>
  `;
}

function showBanner(doc, { reload, win, mayLeave }) {
  if (!doc?.body) return;
  const existing = doc.getElementById(BANNER_ID);
  if (existing) {
    // A sentence about work in progress is about the last tap, not this check.
    existing.querySelector("[data-app-update-busy]").hidden = true;
    return;
  }
  const banner = doc.createElement("div");
  banner.id = BANNER_ID;
  banner.className = "app-update-banner";
  // Announced when it appears (a filled-in status region is often not).
  banner.setAttribute("role", "alert");
  banner.innerHTML = renderAppUpdateBannerHtml();
  const say = (text) => {
    const line = banner.querySelector("[data-app-update-busy]");
    line.textContent = text;
    line.hidden = false;
  };
  banner.querySelector("[data-app-update-refresh]").addEventListener("click", () => {
    if (workInProgress(win)) return say(BUSY_TEXT);
    // An in-app draft (for example an unsaved dashboard layout) is asked about
    // first; held back (declined, or a save still running), it says so.
    if (mayLeave && !mayLeave()) return say(DRAFT_TEXT);
    reload();
  });
  banner.querySelector("[data-app-update-later]").addEventListener("click", () => banner.remove());
  doc.body.appendChild(banner);
}

// One check: the deployed version against the one this page runs. Resolves
// true when the notice is (or stays) shown. Never throws (a failed check is no news).
export async function checkForAppUpdate({
  fetchImpl = globalThis.fetch,
  doc = globalThis.document,
  win = globalThis.window,
  now = Date.now,
  reload = () => win.location.reload(),
  mayLeave = null,
  force = false,
} = {}) {
  if (!force && now() - watch.lastCheck < APP_UPDATE_MIN_GAP_MS) return false;
  watch.lastCheck = now();
  let deployed = "";
  try {
    deployed = await readDeployedVersion(fetchImpl);
  } catch {
    return false;
  }
  if (!deployed) return false;
  if (!watch.loaded) {
    watch.loaded = deployed;
    return false;
  }
  if (deployed === watch.loaded) return false;
  watch.latest = deployed;
  showBanner(doc, { reload, win, mayLeave });
  return true;
}

// app.js: once, at start. Checks now, when the app comes back to the screen
// (iOS resuming the installed app, a tab shown again, a page restored from
// the back-forward cache) and every APP_UPDATE_CHECK_MS while it stays on screen.
export function startAppUpdateWatch({ fetchImpl = globalThis.fetch, doc = globalThis.document, win = globalThis.window, now = Date.now, reload, mayLeave = null } = {}) {
  if (watch.started || !doc || !win) return;
  watch.started = true;
  watch.loaded = buildVersion(doc);
  const options = { fetchImpl, doc, win, now, mayLeave, ...(reload ? { reload } : {}) };
  const check = () => (doc.visibilityState === "hidden" ? undefined : void checkForAppUpdate(options));
  const onPageShow = (event) => { if (event.persisted) check(); };
  void checkForAppUpdate({ ...options, force: true });
  doc.addEventListener("visibilitychange", check);
  win.addEventListener("pageshow", onPageShow);
  const timer = win.setInterval(check, APP_UPDATE_CHECK_MS);
  watch.stop = () => {
    win.clearInterval(timer);
    doc.removeEventListener("visibilitychange", check);
    win.removeEventListener("pageshow", onPageShow);
  };
}
