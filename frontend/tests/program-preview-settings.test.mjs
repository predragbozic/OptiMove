import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const {
  captureMetadataFormDraft,
  capturePreviewScroll,
  handleTemplateMetadataKeydown,
  restoreMetadataFormDraft,
  restorePreviewScroll,
  scheduleProgramCoverPreview,
  libraryScopeSummary,
  renderTemplatePreviewModalHtml,
  showProgramCoverPreviewError,
  syncTemplateMetadataForm,
} = await import("../program-preview.js");
const { submitTemplateMetadataForm } = await import("../program-library-actions.js");

const DRIVE_LINK = "https://drive.google.com/file/d/abc123/view?usp=sharing";

function template(overrides = {}) {
  return {
    plan_id: "plan-1",
    plan_name: "7 day microcycle",
    library_scope: "my",
    status: "active",
    is_free: true,
    access_model: "free_forever",
    can_copy: true,
    can_edit_copy: true,
    can_assign_to_athlete: true,
    athlete_can_view_directly: false,
    requires_approval: true,
    cover_image_url: DRIVE_LINK,
    description: "Seven days.",
    tags: [],
    ...overrides,
  };
}

function renderModal(selected, previewOverrides = {}) {
  return renderTemplatePreviewModalHtml({
    currentUserRole: "coach",
    groups: [],
    isMicrocycle: true,
    preview: { open: true, loading: false, settingsOpen: true, reviews: [], accessRequests: [], ...previewOverrides },
    athletes: [],
    programTagEditor: null,
    renderNodeButton: () => "",
    renderPlanMoreMenu: () => "",
    renderProgramDayCard: () => "",
    selected,
    templateOptions: { categories: [], tags: [] },
  });
}

function domOf(html) {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window;
}

test("everything under the header scrolls as one region: settings, access panel and the program", () => {
  const window = domOf(renderModal(template(), { assignOpen: true }));
  const doc = window.document;
  const modal = doc.querySelector(".program-preview-modal");
  assert.ok(modal.classList.contains("program-template-preview-modal"));
  const children = [...modal.children].map((child) => child.className);
  assert.deepEqual(children, ["program-preview-head", "program-preview-scroll"]);
  const scroll = doc.querySelector("[data-program-preview-scroll]");
  assert.equal(scroll.dataset.planId, "plan-1");
  for (const selector of ["[data-template-metadata-form]", ".program-assignment-panel", ".program-access-request-panel", ".program-preview-body"]) {
    assert.ok(scroll.querySelector(selector), `${selector} must be inside the scroll region`);
  }
  assert.equal(scroll.querySelector(".program-preview-head"), null);
});

test("the form posts the same request body as before, permissions now read from checkboxes", async () => {
  const window = domOf(renderModal(template()));
  const form = window.document.querySelector("[data-template-metadata-form]");
  const calls = [];
  globalThis.FormData = window.FormData;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  let reloaded = 0;
  await submitTemplateMetadataForm(form, { loadTemplates: async () => { reloaded += 1; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/templates/plan-1/metadata");
  assert.equal(calls[0].options.method, "PATCH");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(
    { ...body },
    {
      libraryScope: "my",
      programStatus: "active",
      libraryCategory: body.libraryCategory,
      coverImageUrl: DRIVE_LINK,
      description: "Seven days.",
      isFree: true,
      priceCents: 0,
      availableUntil: "",
      ownerType: null,
      visibility: null,
      accessModel: "free_forever",
      accessDurationDays: "",
      subscriptionPeriod: "month",
      canCopy: true,
      canEditCopy: true,
      canAssignToAthlete: true,
      athleteCanViewDirectly: false,
      requiresApproval: true,
    },
  );
  assert.equal(reloaded, 1);

  form.querySelector("input[name='canCopy']").checked = false;
  form.querySelector("input[name='athleteCanViewDirectly']").checked = true;
  form.querySelector("input[name='requiresApproval']").checked = false;
  await submitTemplateMetadataForm(form, { loadTemplates: async () => {} });
  const flipped = JSON.parse(calls[1].options.body);
  assert.equal(flipped.canCopy, false);
  assert.equal(flipped.athleteCanViewDirectly, true);
  assert.equal(flipped.requiresApproval, false);
  assert.equal(flipped.canEditCopy, true);
});

test("each permission is a checkbox with value true that mirrors the saved flag", () => {
  const doc = domOf(renderModal(template({ can_copy: false, athlete_can_view_directly: true, requires_approval: false }))).document;
  const box = (name) => doc.querySelector(`input[type='checkbox'][name='${name}']`);
  for (const name of ["canCopy", "canEditCopy", "canAssignToAthlete", "athleteCanViewDirectly", "requiresApproval"]) {
    assert.ok(box(name), `${name} checkbox`);
    assert.equal(box(name).value, "true");
  }
  assert.equal(box("canCopy").checked, false);
  assert.equal(box("canEditCopy").checked, true);
  assert.equal(box("athleteCanViewDirectly").checked, true);
  assert.equal(box("requiresApproval").checked, false);
  assert.equal(doc.querySelector("select[name='canCopy']"), null);
  assert.equal(doc.querySelector("input[readonly]"), null, "no read-only Audience / Owner inputs");
});

test("the shelf sentence, the subscription period and the cover picture follow the form without a re-render", () => {
  const doc = domOf(renderModal(template())).document;
  const form = doc.querySelector("[data-template-metadata-form]");
  const subscription = form.querySelector("[data-program-subscription-field]");
  assert.equal(subscription.hidden, true);
  assert.equal(form.querySelector("[data-program-shelf-summary]").textContent, libraryScopeSummary("my"));
  assert.match(libraryScopeSummary("my"), /Private.*Coach/);

  const model = form.querySelector("select[name='accessModel']");
  model.value = "subscription";
  syncTemplateMetadataForm(form, model);
  assert.equal(subscription.hidden, false);
  model.value = "trial";
  syncTemplateMetadataForm(form, model);
  assert.equal(subscription.hidden, true);
  assert.equal(form.querySelector("input[name='accessDurationDays']").closest("[hidden]"), null, "access length stays visible: the server applies it to every license model");

  const shelf = form.querySelector("select[name='libraryScope']");
  shelf.value = "workspace";
  syncTemplateMetadataForm(form, shelf);
  assert.equal(form.querySelector("[data-program-shelf-summary]").textContent, libraryScopeSummary("workspace"));

  const preview = form.querySelector("[data-program-cover-preview]");
  assert.match(preview.querySelector("img").getAttribute("src"), /drive\.google\.com\/thumbnail\?id=abc123/);
  const cover = form.querySelector("input[name='coverImageUrl']");
  cover.value = "";
  syncTemplateMetadataForm(form, cover);
  assert.equal(preview.querySelector("img"), null);
  assert.ok(preview.querySelector(".program-metadata-cover-initials").textContent.trim().length > 0, "no link: the initials the library card shows");
  cover.value = "https://example.com/cover.jpg";
  syncTemplateMetadataForm(form, cover);
  assert.equal(preview.querySelector("img").getAttribute("src"), "https://example.com/cover.jpg");
});

test("a cover link that shows no picture says so, and only inside the preview box", () => {
  const doc = domOf(renderModal(template())).document;
  const image = doc.querySelector("[data-program-cover-preview] img");
  assert.equal(showProgramCoverPreviewError(image), true);
  assert.match(doc.querySelector("[data-program-cover-preview]").textContent, /does not show a picture/);
  const outside = doc.createElement("img");
  doc.body.append(outside);
  assert.equal(showProgramCoverPreviewError(outside), false);
});

test("a hostile cover link stays text", () => {
  const hostile = `https://x.test/a.jpg"><img src=x onerror="alert(1)">`;
  const doc = domOf(renderModal(template({ cover_image_url: hostile }))).document;
  assert.equal(doc.querySelectorAll("img[onerror]").length, 0);
  assert.equal(doc.querySelector("input[name='coverImageUrl']").value, hostile);
});

// Desktop: the region scrolls, the modal does not (its scrollTop stays as
// set by the code under test, which writes both; the test reads the one the
// layout would use). offsetTop values are relative to the modal.
function fakePreview({ planId = "plan-1", panels = "settings|", top = 0, modalTop = 0, offsetTop = 250, formTop = 250, assignTop = 1150, clientHeight = 560 } = {}) {
  const modal = { scrollTop: modalTop, clientHeight };
  const region = { dataset: { planId, previewPanels: panels }, scrollTop: top, offsetTop, clientHeight, closest: () => modal };
  const open = new Set(panels.split("|").filter(Boolean));
  const nodes = {
    "[data-program-preview-scroll]": region,
    "[data-template-metadata-form]": open.has("settings") ? { offsetTop: formTop } : null,
    ".program-assignment-panel": open.has("assign") ? { offsetTop: assignTop } : null,
  };
  return { root: { querySelector: (selector) => nodes[selector] ?? null }, region, modal };
}

test("the scroll region names which panels are open above the program", () => {
  const panelsOf = (preview) => domOf(renderModal(template(), preview)).document.querySelector("[data-program-preview-scroll]").dataset.previewPanels;
  assert.equal(panelsOf({ settingsOpen: true, assignOpen: false }), "settings|");
  assert.equal(panelsOf({ settingsOpen: false, assignOpen: true }), "|assign");
  assert.equal(panelsOf({ settingsOpen: false, assignOpen: false }), "|");
});

test("a re-render keeps the scroll for the same program with the same panels (desktop region and phone modal)", () => {
  const before = fakePreview({ top: 813, modalTop: 640 });
  const kept = capturePreviewScroll(before.root);
  const after = fakePreview();
  restorePreviewScroll(kept, after.root);
  assert.equal(after.region.scrollTop, 813);
  assert.equal(after.modal.scrollTop, 640);
});

test("another program starts from the top", () => {
  const kept = capturePreviewScroll(fakePreview({ top: 813, modalTop: 640 }).root);
  const after = fakePreview({ planId: "plan-2" });
  restorePreviewScroll(kept, after.root);
  assert.equal(after.region.scrollTop, 0);
  assert.equal(after.modal.scrollTop, 0);
});

test("opening Library settings while scrolled down shows the form, never the old offset", () => {
  const kept = capturePreviewScroll(fakePreview({ panels: "|", top: 800, modalTop: 900 }).root);
  const opened = fakePreview({ panels: "settings|", offsetTop: 250, formTop: 250 });
  restorePreviewScroll(kept, opened.root);
  assert.equal(opened.region.scrollTop, 0, "desktop: the form starts the region");
  assert.equal(opened.modal.scrollTop, 250, "phone: the modal goes to where the form begins");

  const atTop = capturePreviewScroll(fakePreview({ panels: "|", top: 0, modalTop: 0 }).root);
  const openedAtTop = fakePreview({ panels: "settings|" });
  restorePreviewScroll(atTop, openedAtTop.root);
  assert.equal(openedAtTop.region.scrollTop, 0);
  assert.equal(openedAtTop.modal.scrollTop, 0, "phone at the top: the form under the header is already visible, the header stays");
});

test("opening Assign below an open settings form brings the Assign panel into view", () => {
  const kept = capturePreviewScroll(fakePreview({ panels: "settings|", top: 0, modalTop: 0 }).root);
  const opened = fakePreview({ panels: "settings|assign", offsetTop: 250, assignTop: 1150 });
  restorePreviewScroll(kept, opened.root);
  assert.equal(opened.region.scrollTop, 900, "desktop: the panel's top is at the top of the region");
  assert.equal(opened.modal.scrollTop, 1150, "phone: the panel's top is at the top of the modal");
});

test("closing a panel starts the region from its top, never further down on a phone", () => {
  const kept = capturePreviewScroll(fakePreview({ panels: "settings|", top: 700, modalTop: 900 }).root);
  const closed = fakePreview({ panels: "|", offsetTop: 250 });
  restorePreviewScroll(kept, closed.root);
  assert.equal(closed.region.scrollTop, 0);
  assert.equal(closed.modal.scrollTop, 250);

  const nearTop = capturePreviewScroll(fakePreview({ panels: "settings|", top: 0, modalTop: 100 }).root);
  const closedNearTop = fakePreview({ panels: "|" });
  restorePreviewScroll(nearTop, closedNearTop.root);
  assert.equal(closedNearTop.modal.scrollTop, 100);

  assert.equal(capturePreviewScroll({ querySelector: () => null }), null);
  restorePreviewScroll(null, closed.root);
});

test("unsaved Library settings survive a re-render of the same program and are what Save sends", async () => {
  const before = domOf(renderModal(template())).window;
  const form = before.document.querySelector("[data-template-metadata-form]");
  form.querySelector("textarea[name='description']").value = "Edited, not saved yet.";
  form.querySelector("input[name='canCopy']").checked = false;
  form.querySelector("select[name='isFree']").value = "false";
  syncTemplateMetadataForm(form, form.querySelector("select[name='isFree']"));
  form.querySelector("input[name='price']").value = "25";
  form.querySelector("select[name='accessModel']").value = "subscription";
  form.querySelector("select[name='programStatus']").value = "draft";
  form.querySelector("input[name='coverImageUrl']").value = "https://example.com/new.jpg";
  const draft = captureMetadataFormDraft(before.document);

  // The re-render after a tag: the new form is built from the SAVED values.
  const after = domOf(renderModal(template({ tags: [{ id: "t1", name: "FUDBAL" }] }))).window;
  restoreMetadataFormDraft(draft, after.document);
  const next = after.document.querySelector("[data-template-metadata-form]");
  assert.equal(next.querySelector("textarea[name='description']").value, "Edited, not saved yet.");
  assert.equal(next.querySelector("input[name='canCopy']").checked, false);
  assert.equal(next.querySelector("input[name='price']").disabled, false);
  assert.equal(next.querySelector("input[name='price']").value, "25");
  assert.equal(next.querySelector("[data-program-subscription-field]").hidden, false);
  assert.match(next.querySelector("[data-program-shelf-summary]").textContent, /^Saved as a draft/);
  assert.equal(next.querySelector("[data-program-cover-preview] img").getAttribute("src"), "https://example.com/new.jpg");

  const calls = [];
  globalThis.FormData = after.FormData;
  globalThis.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; };
  await submitTemplateMetadataForm(next, { loadTemplates: async () => {} });
  assert.equal(calls[0].description, "Edited, not saved yet.");
  assert.equal(calls[0].canCopy, false);
  assert.equal(calls[0].isFree, false);
  assert.equal(calls[0].priceCents, 2500);
  assert.equal(calls[0].accessModel, "subscription");
  assert.equal(calls[0].programStatus, "draft");
  assert.equal(calls[0].coverImageUrl, "https://example.com/new.jpg");
});

test("a draft is never carried to another program or to a closed form", () => {
  const before = domOf(renderModal(template())).window;
  before.document.querySelector("textarea[name='description']").value = "Typed for plan-1";
  const draft = captureMetadataFormDraft(before.document);
  const other = domOf(renderModal(template({ plan_id: "plan-2", description: "Plan 2" }))).window;
  restoreMetadataFormDraft(draft, other.document);
  assert.equal(other.document.querySelector("textarea[name='description']").value, "Plan 2");
  const closed = domOf(renderModal(template(), { settingsOpen: false })).window;
  assert.equal(captureMetadataFormDraft(closed.document), null);
  restoreMetadataFormDraft(draft, closed.document);
});

test("the live sentence follows the server's rule: a draft always goes to Draft / working material", () => {
  assert.equal(libraryScopeSummary("my", "active"), "Sharing: Private · Owner: Coach");
  assert.equal(libraryScopeSummary("team", "active"), "Sharing: Team · Owner: Team");
  assert.equal(libraryScopeSummary("club", "archived"), "Sharing: Club · Owner: Club");
  assert.equal(libraryScopeSummary("marketplace", "active"), "Sharing: Platform · Owner: Marketplace");
  assert.match(libraryScopeSummary("team", "draft"), /^Saved as a draft in Draft \/ working material · Sharing: Private/);
  assert.match(libraryScopeSummary("workspace", "active"), /^Saved as a draft/);

  const doc = domOf(renderModal(template({ library_scope: "my" }), {})).document;
  const form = doc.querySelector("[data-template-metadata-form]");
  const status = form.querySelector("select[name='programStatus']");
  status.value = "draft";
  assert.equal(syncTemplateMetadataForm(form, status), true);
  assert.match(form.querySelector("[data-program-shelf-summary]").textContent, /^Saved as a draft/);
  assert.equal(syncTemplateMetadataForm(form, form.querySelector("input[name='libraryCategory']")), false, "fields without a live part are left to the form");
});

test("a time-limited or trial license without an access length says that access never ends", () => {
  const doc = domOf(renderModal(template({ access_model: "trial", access_duration_days: null }))).document;
  const form = doc.querySelector("[data-template-metadata-form]");
  const note = form.querySelector("[data-program-access-length-note]");
  assert.equal(note.hidden, false);
  const days = form.querySelector("input[name='accessDurationDays']");
  days.value = "14";
  syncTemplateMetadataForm(form, days);
  assert.equal(note.hidden, true);
  const model = form.querySelector("select[name='accessModel']");
  days.value = "";
  model.value = "free_forever";
  syncTemplateMetadataForm(form, model);
  assert.equal(note.hidden, true);
  model.value = "time_limited";
  syncTemplateMetadataForm(form, model);
  assert.equal(note.hidden, false);
});

test("Enter adds the tag in Add tag and shows the picture in the cover link - it never saves the form", () => {
  const window = domOf(renderModal(template()));
  const doc = window.document;
  const form = doc.querySelector("[data-template-metadata-form]");
  let submitted = 0;
  form.addEventListener("submit", (event) => { submitted += 1; event.preventDefault(); });
  let added = 0;
  doc.querySelector("[data-action='program-tag-add']").addEventListener("click", () => { added += 1; });
  const press = (target) => {
    const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    return { handled: handleTemplateMetadataKeydown(event), prevented: event.defaultPrevented };
  };
  assert.deepEqual(press(doc.querySelector("[data-program-tag-input]")), { handled: true, prevented: true });
  assert.equal(added, 1);
  const cover = form.querySelector("input[name='coverImageUrl']");
  cover.value = "https://example.com/typed.jpg";
  assert.deepEqual(press(cover), { handled: true, prevented: true });
  assert.equal(form.querySelector("[data-program-cover-preview] img").getAttribute("src"), "https://example.com/typed.jpg");
  assert.equal(press(form.querySelector("input[name='libraryCategory']")).handled, false);
  assert.equal(submitted, 0);
});

test("the cover picture follows the link while it is typed", async () => {
  const doc = domOf(renderModal(template())).document;
  const cover = doc.querySelector("input[name='coverImageUrl']");
  cover.value = "https://example.com/pasted.jpg";
  const previousSetTimeout = globalThis.setTimeout;
  scheduleProgramCoverPreview(cover, 0);
  await new Promise((resolve) => previousSetTimeout(resolve, 10));
  // jsdom nodes built outside a live document report isConnected for their own document.
  assert.equal(doc.querySelector("[data-program-cover-preview] img").getAttribute("src"), "https://example.com/pasted.jpg");
});

test("the Assign button says Hide assign while its panel is open", () => {
  const label = (assignOpen) => domOf(renderModal(template(), { assignOpen })).document.querySelector("[data-action='template-assign']").textContent;
  assert.equal(label(false), "Assign");
  assert.equal(label(true), "Hide assign");
});

test("styles: one scroll region under the header, dvh heights, 16px fields on phones", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const block = (selector, from = 0) => {
    const start = css.indexOf(`${selector} {`, from);
    assert.ok(start >= 0, `${selector} rule exists`);
    return css.slice(start, css.indexOf("}", start));
  };
  assert.match(block(".program-template-preview-modal"), /grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  const scroll = block(".program-preview-scroll");
  assert.match(scroll, /min-height:\s*0/);
  assert.match(scroll, /overflow-y:\s*auto/);
  assert.match(block(".program-preview-scroll > .program-preview-body"), /overflow:\s*visible/);
  assert.match(block(".program-preview-modal"), /100dvh/);
  const inPhoneBlock = css.indexOf("  .program-metadata-grid {\n    grid-template-columns: 1fr;");
  assert.ok(inPhoneBlock > 0, "the phone rule of the settings grid exists");
  const phoneStart = css.lastIndexOf("@media (max-width: 760px)", inPhoneBlock);
  const phone = css.slice(phoneStart, css.indexOf("\n}\n", inPhoneBlock));
  assert.match(phone, /\.program-preview-modal \{[^}]*100dvh/);
  assert.match(phone, /\.program-metadata-form input:not\(\[type="checkbox"\]\) \{[^}]*font-size:\s*16px/);
  assert.match(block(".program-metadata-permission"), /min-height:\s*44px/);
});
