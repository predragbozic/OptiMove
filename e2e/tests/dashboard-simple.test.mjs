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
      await page.locator(".tl-simple-editor").waitFor({ state: "hidden" });
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
      await page.getByRole("button", { name: "Check again" }).click();
      await page.locator(".tl-simple-editor").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Widget actions: Updated sessions" }).waitFor();
      await screenshot(page, width, "after-recovery");
      await page.getByRole("button", { name: "Widget actions: Updated sessions" }).click();
      await action(page, "analysis-edit-widget").click();
      await action(page, "simple-next").click();
      await action(page, "simple-next").click();
      await action(page, "simple-title").fill("Unconfirmed edit");
      await action(page, "simple-preview").click();
      await page.locator(".tl-simple-preview-status[data-ready=true]").waitFor();
      await page.route("**/simple/widgets/*", route => route.abort("failed"), { times: 1 });
      await action(page, "simple-save").click();
      await page.getByText("We could not confirm that your widget was saved.").waitFor();
      await screenshot(page, width, "unconfirmed");
      const confirmation = page.waitForEvent("dialog");
      const cancel = action(page, "simple-close").click();
      const dialog = await confirmation;
      assert.match(dialog.message(), /may or may not be on the dashboard/);
      await dialog.accept();
      await cancel;
      await page.locator(".tl-simple-editor").waitFor({ state: "hidden" });

      const dashboardPath = world.baseUrl + "/api/training-load/dashboards/" + dashboard.id;
      const detail = await (await context.request.get(dashboardPath)).json();
      const legacy = await context.request.post(dashboardPath + "/widgets", { data: {
        expectedDashboardRevision: detail.dashboard.revision, widgetType: "table", title: "Advanced fixture",
        widgetOrder: 10, mobileOrder: 10, x: 0, y: 20, width: 6, height: 4,
      } });
      assert.equal(legacy.status(), 201, await legacy.text());
      await page.goto(world.baseUrl);
      await page.getByText("Sign out").first().waitFor();
      await openTrainingLoad(page);
      await page.getByRole("tab", { name: "Data & Analysis" }).click();
      if (await dashboards.isVisible()) await dashboards.click();
      await action(page, "analysis-open-picker").click();
      await page.locator(`[data-dashboard-id="${dashboard.id}"]`).click();
      await page.getByRole("button", { name: "Widget actions: Advanced fixture" }).click();
      await action(page, "analysis-edit-widget").click();
      await page.getByRole("button", { name: "Open Advanced settings" }).waitFor();
      assert.equal(await action(page, "simple-next").count(), 0);
      await screenshot(page, width, "advanced-required");
      await page.getByRole("button", { name: "Open Advanced settings" }).click();
      await page.locator(".tl-simple-editor").waitFor({ state: "hidden" });
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}
