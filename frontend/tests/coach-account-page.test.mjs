import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Round 2 of Builder feedback, item 10: a coach never had an "Account" menu
// entry for their OWN login email/password, only Settings > Users/Clubs/
// Teams/Athletes/Tags (organization-wide administration). This mirrors the
// athlete rail's existing Account entry: same email-change/password-change
// panels (athlete-view.js's renderAccountEmailPasswordSectionsHtml, now
// shared rather than duplicated), minus the athlete-only personal-data/
// photo section a coach has no equivalent of. Backend needed no changes -
// PUT /api/auth/me/credentials and the email-change endpoints
// (backend/src/routes/auth.js) already check only req.user, no role gate.
//
// coach-account.js imports athlete-view.js, which transitively touches
// `document` at module scope (organization-view.js -> navigation.js ->
// dom.js) - same reasoning as every other athlete-view.js-adjacent test in
// this suite - so this is checked via source-pattern-guard tests over the
// raw file text, never imported directly.

function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const coachAccountSource = readSource("../coach-account.js");
const athleteViewSource = readSource("../athlete-view.js");
const appJsSource = readSource("../app.js");
const indexHtmlSource = readSource("../index.html");
const menuCachePolicySource = readSource("../menu-cache-policy.js");

function sliceFunction(source, name, windowSize = 1200) {
  const marker = source.includes(`function ${name}(`) ? `function ${name}(` : `export function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(start, start + windowSize);
}

test("renderCoachAccountHtml reuses the shared email/password sections rather than duplicating that markup", () => {
  assert.match(coachAccountSource, /import \{ renderAccountEmailPasswordSectionsHtml \} from "\.\/athlete-view\.js";/);
  const body = sliceFunction(coachAccountSource, "renderCoachAccountHtml", 900);
  assert.match(body, /\$\{renderAccountEmailPasswordSectionsHtml\(currentUser, emailChangeStatus\)\}/);
});

test("renderCoachAccountHtml never renders a Personal data form or athlete-profile fields - a coach has no athlete profile row", () => {
  const body = sliceFunction(coachAccountSource, "renderCoachAccountHtml", 900);
  assert.doesNotMatch(body, /Personal data/);
  assert.doesNotMatch(body, /data-account-form="personal-data"/);
});

test("athlete-view.js exports renderAccountEmailPasswordSectionsHtml with Login email and Change password, in that order", () => {
  const body = sliceFunction(athleteViewSource, "renderAccountEmailPasswordSectionsHtml", 1600);
  const loginIndex = body.indexOf("Login email");
  const passwordIndex = body.indexOf("Change password");
  assert.ok(loginIndex >= 0 && passwordIndex > loginIndex);
  assert.match(body, /data-account-form="password-change"/);
});

test("app.js wires state.activeTab === \"coach-account\" to renderCoachAccount() in both loadActiveTab() and renderCurrentNode()", () => {
  assert.match(appJsSource, /import \{ renderCoachAccountHtml \} from "\.\/coach-account\.js";/);
  const loadActiveTabStart = appJsSource.indexOf("async function loadActiveTab()");
  const loadActiveTabBody = appJsSource.slice(loadActiveTabStart, loadActiveTabStart + 900);
  assert.match(loadActiveTabBody, /if \(state\.activeTab === "coach-account"\) return renderCoachAccount\(\);/);

  const renderCurrentNodeStart = appJsSource.indexOf("function renderCurrentNode()");
  const renderCurrentNodeBody = appJsSource.slice(renderCurrentNodeStart, renderCurrentNodeStart + 900);
  assert.match(renderCurrentNodeBody, /if \(state\.activeTab === "coach-account"\) return renderCoachAccount\(\);/);
});

test("renderCoachAccount() follows the same render-immediately-then-patch-in-emailChangeStatus pattern as renderAthleteSettings()", () => {
  const body = sliceFunction(appJsSource, "renderCoachAccount", 900);
  assert.match(body, /els\.content\.innerHTML = renderCoachAccountHtml\(state\.currentUser, null\);/);
  assert.match(body, /api\("\/api\/auth\/account\/email-change\/status"\)\.catch\(\(\) => null\)/);
  assert.match(body, /if \(state\.activeTab !== "coach-account"\) return;/);
});

test("refreshAccountSettingsView routes to renderCoachAccount when on the coach Account tab, renderAthleteSettings otherwise - the email-change forms are shared between both pages", () => {
  const body = sliceFunction(appJsSource, "refreshAccountSettingsView", 400);
  assert.match(body, /if \(state\.activeTab === "coach-account"\) return renderCoachAccount\(\);/);
  assert.match(body, /return renderAthleteSettings\(\);/);
});

test("the email-change-request form submit and resend/cancel actions both go through refreshAccountSettingsView, not a hardcoded renderAthleteSettings", () => {
  const requestFormStart = appJsSource.indexOf("[data-account-form='email-change-request']");
  const requestFormBody = appJsSource.slice(requestFormStart, requestFormStart + 900);
  assert.match(requestFormBody, /await refreshAccountSettingsView\(\);/);

  const resendCancelStart = appJsSource.indexOf("async function submitEmailChangeAction");
  const resendCancelBody = appJsSource.slice(resendCancelStart, resendCancelStart + 700);
  assert.match(resendCancelBody, /await refreshAccountSettingsView\(\);/);
});

test("index.html has a new static Account sidebar button (data-library-tab=\"coach-account\") for the coach's own account, reusing the athlete rail's person-in-circle icon", () => {
  const start = indexHtmlSource.indexOf('data-library-tab="coach-account"');
  assert.ok(start >= 0, "the coach-account sidebar button must exist in index.html");
  const body = indexHtmlSource.slice(Math.max(0, start - 200), start + 400);
  assert.match(body, /title="Account"/);
  assert.match(body, /<circle cx="12" cy="8" r="4">/);
  assert.match(body, /<span>Account<\/span>/);
});

test("menu-cache-policy.js registers coach-account as static, mirroring athlete-settings", () => {
  assert.match(menuCachePolicySource, /"coach-account": \{/);
  const start = menuCachePolicySource.indexOf('"coach-account": {');
  const body = menuCachePolicySource.slice(start, start + 400);
  assert.match(body, /policy: "static"/);
  assert.match(body, /namespace: null/);
});
