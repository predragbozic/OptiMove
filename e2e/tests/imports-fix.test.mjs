// Imports Fix flow, slice 1: a coach fixes a session one problem per screen - the group's button opens the sheet, the
// unlinked GPEXE athlete is linked in it (Link..., Confirm link), the review recomputes, and the end says who imports.
// A club admin once, through to the import. Invented data only; the fake GPEXE source. 1280, 390 and 360 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad } from "../lib/browser.mjs";

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

const G = "/api/training-load/gpexe";
const SHOTS = process.env.E2E_SHOTS || "";
const CODE = /\b[a-z]+_[a-z_]+\b/;

async function openNeedsYou(page) {
  await openTrainingLoad(page);
  await page.click('[data-action="training-load-section"][data-section="imports"]');
  await page.waitForSelector('[data-attention-group="unlinked"]', { timeout: 20_000 });
}

// The sheet's layout: inside the viewport, no horizontal scroll, every control at least 44 px tall.
async function checkLayout(page, width) {
  const m = await page.evaluate(() => {
    const s = document.querySelector(".imports-fix.is-open");
    const r = s.getBoundingClientRect();
    const small = [...s.querySelectorAll("button:not(:disabled), select")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim() || b.className);
    return { left: r.left, right: r.right, width: r.width, scroll: document.documentElement.scrollWidth, inner: window.innerWidth, sheetScroll: s.scrollWidth - s.clientWidth, small, focusInside: s.contains(document.activeElement) };
  });
  assert.ok(m.scroll <= m.inner, `no horizontal page scroll at ${width} (${m.scroll} > ${m.inner})`);
  assert.ok(m.sheetScroll <= 1, `no horizontal scroll in the sheet at ${width}`);
  assert.ok(m.left >= 0 && m.right <= m.inner + 0.5, "the sheet is inside the viewport");
  if (width >= 760) assert.ok(Math.abs(m.width - 560) <= 1, `a 560 px dialog on a computer (${m.width})`);
  else assert.ok(Math.abs(m.width - m.inner) <= 1, "a full-width sheet on a phone");
  assert.deepEqual(m.small, [], "every control is at least 44 px tall");
  return m;
}

for (const width of [1280, 390, 360]) {
  test(`Fix (${width} px): a coach links the GPEXE athlete in the sheet, the review recomputes once, the end names who imports; Escape closes and the focus goes back`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
    try {
      const setup = await prepareImports(world);
      const target = world.ids.athleteIds[3];
      const coach = await openAs(browser, world, "team_coach", width);
      try {
        const posts = [];
        coach.page.on("request", (r) => { if (r.method() === "POST") posts.push(new URL(r.url()).pathname); });
        await openNeedsYou(coach.page);
        await coach.page.click('[data-attention-group="unlinked"] [data-action="training-load-gpexe-fix"]');
        await coach.page.waitForSelector(".imports-fix.is-open .gpexe-link select");
        assert.match(await coach.page.locator(".imports-fix-count").innerText(), /^Step 1 of 1$/);
        const text = (await coach.page.locator(".imports-fix.is-open").innerText()).replace(/\s+/g, " ");
        assert.ok(!CODE.test(text), `no server code for the coach: ${text.match(CODE)}`);
        assert.ok(!/\b121\b/.test(text), "no GPEXE id");
        assert.equal(await coach.page.locator(".imports-fix.is-open select").inputValue(), "", "nothing is preselected");
        assert.equal(await coach.page.locator(".gpexe-detail-overlay").count(), 0, "the full review is not open under it");
        await checkLayout(coach.page, width);
        if (SHOTS) await coach.page.screenshot({ path: `${SHOTS}/fix-link-${width}.png` });
        await coach.page.locator(".imports-fix.is-open select").selectOption(target);
        await coach.page.click('.imports-fix.is-open [data-action="training-load-gpexe-link"]');
        assert.equal(posts.filter((p) => p.endsWith("/athlete-links")).length, 0, "Link... only asks");
        await coach.page.click('.imports-fix.is-open [data-action="training-load-gpexe-link-confirm"]');
        await coach.page.locator(".imports-fix.is-open", { hasText: "This session is ready." }).waitFor({ timeout: 20_000 });
        assert.equal(posts.filter((p) => p.endsWith("/athlete-links")).length, 1, "one link");
        assert.equal(posts.filter((p) => p.endsWith("/preview")).length, 1, "one recompute; no Update the review step");
        const end = (await coach.page.locator(".imports-fix.is-open").innerText()).replace(/\s+/g, " ");
        assert.match(end, /This session is ready\. Ask your club administrator to import it\./);
        assert.equal(await coach.page.locator('.imports-fix.is-open [data-action="training-load-gpexe-approve"]').count(), 0, "no Import button that would be refused");
        await checkLayout(coach.page, width);
        if (SHOTS) await coach.page.screenshot({ path: `${SHOTS}/fix-end-${width}.png` });
        await coach.page.keyboard.press("Escape");
        await coach.page.waitForSelector(".imports-fix.is-open", { state: "detached" });
        assert.equal(coach.pageErrors.length, 0, coach.pageErrors.join("\n"));
        const linked = (await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/athlete-links`)).body.links;
        assert.ok(linked.some((l) => String(l.gpexeAthleteId) === "121" && l.athleteId === target), "the link is in the database");
      } finally {
        await coach.context.close();
      }
    } finally {
      await world.stop();
    }
  });
}

test("Fix (club admin, 1280 px): the same steps without a code, through to the import", async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
  try {
    const setup = await prepareImports(world);
    const needs = setup.candidates.find((c) => String(c.gpexeTeamSessionId) === "9102");
    const admin = await openAs(browser, world, "club_admin", 1280);
    try {
      admin.page.on("dialog", (d) => d.accept());
      await openNeedsYou(admin.page);
      await admin.page.click('[data-attention-group="unlinked"] [data-action="training-load-gpexe-fix"]');
      await admin.page.waitForSelector(".imports-fix.is-open .gpexe-link select");
      const text = (await admin.page.locator(".imports-fix.is-open").innerText()).replace(/\s+/g, " ");
      assert.ok(!CODE.test(text) && !/Technical details/.test(text), "no code for the club admin");
      await admin.page.locator(".imports-fix.is-open select").selectOption(world.ids.athleteIds[3]);
      await admin.page.click('.imports-fix.is-open [data-action="training-load-gpexe-link"]');
      await admin.page.click('.imports-fix.is-open [data-action="training-load-gpexe-link-confirm"]');
      await admin.page.locator(".imports-fix.is-open", { hasText: "This session is ready" }).waitFor({ timeout: 20_000 });
      const end = (await admin.page.locator(".imports-fix.is-open").innerText()).replace(/\s+/g, " ");
      assert.ok(!CODE.test(end), "no code at the end either");
      // The server says whether this club admin may import (the seed's team switch is in team mode); the end follows it.
      const canApprove = (await setup.call("club_admin", "GET", `${G}/teams/${setup.teamId}/status`)).body.viewer?.canApprove === true;
      const approve = admin.page.locator('.imports-fix.is-open [data-action="training-load-gpexe-approve"]');
      assert.equal(await approve.count(), canApprove ? 1 : 0, "an Import button exactly when the server allows it");
      if (canApprove) {
        await approve.click();
        await admin.page.locator(".imports-fix.is-open", { hasText: "This session is imported." }).waitFor({ timeout: 30_000 });
        const after = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${needs.id}`)).body.candidate;
        assert.equal(after.status, "imported");
      } else {
        assert.match(end, /This session is ready\. Contact OptiMove support to import it\./, "a club admin who may not import is told who does");
      }
      assert.equal(admin.pageErrors.length, 0, admin.pageErrors.join("\n"));
    } finally {
      await admin.context.close();
    }
  } finally {
    await world.stop();
  }
});

test("Fix (platform admin, 1280 px): Fix beside the review, through the link to the import in the sheet", async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
  try {
    const setup = await prepareImports(world);
    const needs = setup.candidates.find((c) => String(c.gpexeTeamSessionId) === "9102");
    const admin = await openAs(browser, world, "platform_admin", 1280);
    try {
      admin.page.on("dialog", (d) => d.accept());
      await openNeedsYou(admin.page);
      assert.equal(await admin.page.locator('[data-attention-group="unlinked"] [data-action="training-load-gpexe-open"]').count() > 0, true, "the review is still offered");
      await admin.page.click('[data-attention-group="unlinked"] [data-action="training-load-gpexe-fix"]');
      await admin.page.waitForSelector(".imports-fix.is-open .gpexe-link select");
      await admin.page.locator(".imports-fix.is-open select").selectOption(world.ids.athleteIds[3]);
      await admin.page.click('.imports-fix.is-open [data-action="training-load-gpexe-link"]');
      await admin.page.click('.imports-fix.is-open [data-action="training-load-gpexe-link-confirm"]');
      const approve = admin.page.locator('.imports-fix.is-open [data-action="training-load-gpexe-approve"]');
      await approve.waitFor({ timeout: 20_000 });
      assert.equal((await approve.innerText()).trim(), "Import 3 athletes");
      await approve.click();
      await admin.page.locator(".imports-fix.is-open", { hasText: "This session is imported." }).waitFor({ timeout: 30_000 });
      const after = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${needs.id}`)).body.candidate;
      assert.equal(after.status, "imported", "imported through the sheet");
      assert.equal(admin.pageErrors.length, 0, admin.pageErrors.join("\n"));
    } finally {
      await admin.context.close();
    }
  } finally {
    await world.stop();
  }
});

// Slice 2: an athlete GPEXE recorded on more than one track. Whoever imports chooses the recording in the sheet; anyone else
// is told who does.
for (const width of [1280, 390, 360]) {
  test(`Fix slice 2 (${width} px): a platform admin chooses the recording of an athlete on two tracks, then imports in the sheet`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "multitrack" } });
    try {
      const setup = await prepareImports(world);
      const session = setup.candidates.find((c) => String(c.gpexeTeamSessionId) === "9131");
      assert.ok(session, "the session is found");
      const admin = await openAs(browser, world, "platform_admin", width);
      try {
        admin.page.on("dialog", (d) => d.accept());
        const puts = [];
        admin.page.on("request", (r) => { if (r.method() === "PUT" && /track-choices\//.test(r.url())) puts.push(r.postDataJSON()); });
        await openTrainingLoad(admin.page);
        await admin.page.click('[data-action="training-load-section"][data-section="imports"]');
        await admin.page.waitForSelector('[data-attention-group="review"]', { timeout: 20_000 });
        await admin.page.click('[data-attention-group="review"] [data-action="training-load-gpexe-fix"]');
        await admin.page.waitForSelector(".imports-fix.is-open .imports-fix-choice", { timeout: 20_000 });
        const text = (await admin.page.locator(".imports-fix.is-open").innerText()).replace(/\s+/g, " ");
        assert.match(text, /Which recording is .+\? GPEXE recorded them on 2 tracks in this session\./);
        assert.match(text, /Recording 1 · started \d{2}:\d{2} · \d+ min · [\d,]+ m/);
        assert.ok(!/\b900[34]\b/.test(text), "never a track id in what is read");
        await checkLayout(admin.page, width);
        if (SHOTS) await admin.page.screenshot({ path: `${SHOTS}/fix-track-${width}.png` });
        await admin.page.locator(".imports-fix.is-open .imports-fix-choice").first().click();
        await admin.page.click('.imports-fix.is-open [data-action="training-load-gpexe-fix-track-save"]');
        const approve = admin.page.locator('.imports-fix.is-open [data-action="training-load-gpexe-approve"]');
        await approve.waitFor({ timeout: 20_000 });
        assert.equal(puts.length, 1, "one choice sent");
        assert.equal(puts[0].choice, "track");
        assert.equal((await approve.innerText()).trim(), "Import 3 athletes");
        await approve.click();
        await admin.page.locator(".imports-fix.is-open", { hasText: "This session is imported." }).waitFor({ timeout: 30_000 });
        const after = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${session.id}`)).body.candidate;
        assert.equal(after.status, "imported");
        assert.equal(admin.pageErrors.length, 0, admin.pageErrors.join("\n"));
      } finally {
        await admin.context.close();
      }
    } finally {
      await world.stop();
    }
  });
}

test("Fix slice 2 (coach, 1280 px): a coach who may not import reads no recordings; the end says whoever imports chooses", async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "multitrack" } });
  try {
    await prepareImports(world);
    const coach = await openAs(browser, world, "team_coach", 1280);
    try {
      const reads = [];
      coach.page.on("request", (r) => { if (/track-choices/.test(r.url())) reads.push(r.url()); });
      await openTrainingLoad(coach.page);
      await coach.page.click('[data-action="training-load-section"][data-section="imports"]');
      await coach.page.waitForSelector('[data-attention-group="review"]', { timeout: 20_000 });
      await coach.page.click('[data-attention-group="review"] [data-action="training-load-gpexe-fix"]');
      await coach.page.locator(".imports-fix.is-open", { hasText: "whoever imports chooses" }).waitFor({ timeout: 20_000 });
      const text = (await coach.page.locator(".imports-fix.is-open").innerText()).replace(/\s+/g, " ");
      assert.match(text, /This session is ready, except an athlete GPEXE recorded on more than one track: whoever imports chooses which recording to use\. Ask your club administrator to import it\./);
      assert.ok(!CODE.test(text), `no code: ${text.match(CODE)}`);
      assert.equal(await coach.page.locator('.imports-fix.is-open [data-action="training-load-gpexe-approve"]').count(), 0);
      assert.deepEqual(reads, [], "the approver-only read is never asked");
      assert.equal(coach.pageErrors.length, 0, coach.pageErrors.join("\n"));
    } finally {
      await coach.context.close();
    }
  } finally {
    await world.stop();
  }
});
