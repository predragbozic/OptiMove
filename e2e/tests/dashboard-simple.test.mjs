import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";
import { startWorld } from "../lib/world.mjs";

let world, browser;
before(async () => {
  const config = {
    DASHBOARD_SIMPLE_MODE: "enabled",
    DASHBOARD_SIMPLE_BUDGET_VERIFIED: "true",
    DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED: "true",
    DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE: "2",
    DASHBOARD_SIMPLE_KEY_ID: "browser-fixture",
    DASHBOARD_SIMPLE_KEY_BASE64: randomBytes(32).toString("base64"),
  };
  const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  try { world = await startWorld(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  browser = await launch();
});
after(async () => { await browser?.close(); await world?.stop(); });

const action = (page, name) => page.locator(`[data-action="training-load-${name}"]`).first();
async function screenshot(page, width, phase) {
  const folder = process.env.DASHBOARD_SIMPLE_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await page.screenshot({ path: path.join(folder, `dashboard-simple-${width}-${phase}.png`) });
}

for (const width of [WIDTHS.phone, WIDTHS.desktop]) {
  test(`(${width}px) Simple creates, edits and recovers a lost save response`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    const title = `Simple test ${width}`;
    try {
      const creation = await context.request.post(`${world.baseUrl}/api/training-load/dashboards`, { data: { name: title } });
      assert.equal(creation.status(), 201, await creation.text());
      const { dashboard } = await creation.json();
      await openTrainingLoad(page);
      await page.getByRole("tab", { name: "Data & Analysis" }).click();
      const dashboards = page.getByRole("tab", { name: "Dashboards" });
      if (await dashboards.isVisible()) await dashboards.click();
      await action(page, "analysis-open-picker").click();
      await page.locator(`[data-dashboard-id="${dashboard.id}"]`).click();
      await action(page, "analysis-add-widget").click();
      const select = page.locator('[data-action="training-load-simple-metric"][data-kind="builtin"][data-id="session_count"]');
      await select.click();
      await action(page, "simple-next").click();
      await action(page, "simple-next").click();
      await action(page, "simple-title").fill("Saved sessions");
      await action(page, "simple-preview").click();
      await page.locator(".tl-simple-preview-status[data-ready=true]").waitFor();
      await screenshot(page, width, "before-save");
      await action(page, "simple-save").click();
      await page.getByText("Save recorded.", { exact: true }).waitFor();
      await action(page, "simple-close").click();
      await page.getByRole("button", { name: "Widget actions: Saved sessions" }).click();
      await action(page, "analysis-edit-widget").click();
      await action(page, "simple-next").click();
      await action(page, "simple-next").click();
      await action(page, "simple-title").fill("Updated sessions");
      await action(page, "simple-preview").click();
      await page.locator(".tl-simple-preview-status[data-ready=true]").waitFor();
      await page.route("**/simple/widgets/*", async route => {
        if (route.request().method() !== "PUT") return route.continue();
        const reply = await route.fetch();
        assert.equal(reply.status(), 200, await reply.text());
        await route.abort("failed");
      }, { times: 1 });
      await action(page, "simple-save").click();
      await page.getByRole("button", { name: "Check status" }).click();
      await page.getByText("Save recorded.", { exact: true }).waitFor();
      await action(page, "simple-close").click();
      await page.getByRole("button", { name: "Widget actions: Updated sessions" }).waitFor();
      await screenshot(page, width, "after-recovery");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}
