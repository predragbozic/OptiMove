import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { captureChangedFields, resetLiveForm, restoreChangedFields } from "../form-keep.js";
import { renderFilterableSelect } from "../organization-select.js";

// F1: what a person typed in an open Settings form survives a repaint of the panel (a late /api/organization answer).
// Browser proof: e2e/tests/settings-keep-typed.test.mjs.
const dom = new JSDOM("<!doctype html><body><main id=content></main></body>");
const root = dom.window.document.getElementById("content");

const editTeam = (name, id = "t1") => `
  <section role="dialog" aria-modal="true" aria-label="Edit team">
    <form data-organization-form="edit-team" data-organization-edit-id="${id}">
      <input name="name" value="${name}">
      <input name="shortName" value="FT">
      <input name="password" type="password" value="">
      <select name="kind"><option value="a" selected>A</option><option value="b">B</option></select>
      <input type="checkbox" name="flag" value="on">
      <input type="radio" name="size" value="s" checked><input type="radio" name="size" value="l">
      <input type="hidden" name="token" value="x">
    </form>
  </section>`;

function repaint(html) {
  const kept = captureChangedFields(root);
  root.innerHTML = html;
  restoreChangedFields(root, kept);
  return kept;
}

test("a changed field keeps the typed value across a repaint; an untouched one takes the new saved value", () => {
  root.innerHTML = editTeam("First team");
  root.querySelector('[name="name"]').value = "First team S4";
  repaint(editTeam("First team").replace('value="FT"', 'value="F1"'));
  assert.equal(root.querySelector('[name="name"]').value, "First team S4");
  assert.equal(root.querySelector('[name="shortName"]').value, "F1", "not touched: the new value");
});

test("a select, a checkbox and a radio the person changed are kept", () => {
  root.innerHTML = editTeam("First team");
  root.querySelector('[name="kind"]').value = "b";
  root.querySelector('[name="flag"]').checked = true;
  root.querySelector('[name="size"][value="l"]').checked = true;
  repaint(editTeam("First team"));
  assert.equal(root.querySelector('[name="kind"]').value, "b");
  assert.equal(root.querySelector('[name="flag"]').checked, true);
  assert.equal(root.querySelector('[name="size"][value="l"]').checked, true);
  assert.equal(root.querySelector('[name="size"][value="s"]').checked, false);
});

test("a password survives the repaint in the DOM, and the kept values are only returned to the caller", () => {
  root.innerHTML = editTeam("First team");
  root.querySelector('[name="password"]').value = "s3cret-demo";
  const kept = repaint(editTeam("First team"));
  assert.equal(root.querySelector('[name="password"]').value, "s3cret-demo");
  assert.ok(Array.isArray(kept), "a plain local list for this one repaint: nothing written anywhere else");
  assert.ok(!kept.some((k) => k.field === "token"), "a hidden field is never captured");
});

test("nothing carries over after a successful save (form.reset) or after the form is closed", () => {
  root.innerHTML = editTeam("First team");
  const name = root.querySelector('[name="name"]');
  name.value = "Typed then saved";
  root.querySelector("form").reset();
  assert.deepEqual(repaint(editTeam("Saved name")), []);
  assert.equal(root.querySelector('[name="name"]').value, "Saved name");

  name.ownerDocument.querySelector('[name="name"]').value = "Typed then closed";
  repaint("<p>closed</p>");
  repaint(editTeam("Saved name"));
  assert.equal(root.querySelector('[name="name"]').value, "Saved name", "a closed form's text never comes back");
});

test("a value goes back only to the same form: another team's edit form or a form without data-* is left alone", () => {
  root.innerHTML = editTeam("First team", "t1");
  root.querySelector('[name="name"]').value = "Typed for t1";
  repaint(editTeam("U19 team", "t2"));
  assert.equal(root.querySelector('[name="name"]').value, "U19 team");

  root.innerHTML = '<form><input name="q" value=""></form>';
  root.querySelector('[name="q"]').value = "typed";
  assert.deepEqual(repaint('<form><input name="q" value=""></form>'), []);
});

const picker = (value = "t1") => `
  <form data-organization-form="edit-athlete" data-organization-edit-id="a1">
    <input name="name" value="Ana Example">
    ${renderFilterableSelect({ name: "teamId", label: "Team", value, options: [{ value: "t1", label: "First team" }, { value: "t2", label: "U19 team" }] })}
  </form>`;

test("a searchable picker's choice (its search text and its hidden value) survives the repaint, so Save sends it", () => {
  root.innerHTML = picker("t1");
  const search = root.querySelector("[data-org-select-filter]");
  search.value = "U19 team";
  root.querySelector('input[type="hidden"][name="teamId"]').value = "t2"; // what filterOrganizationSelect sets on a match
  repaint(picker("t1"));
  assert.equal(root.querySelector("[data-org-select-filter]").value, "U19 team");
  assert.equal(new dom.window.FormData(root.querySelector("form")).get("teamId"), "t2");
});

test("the field being typed in keeps the focus and its caret after the repaint", () => {
  root.innerHTML = editTeam("First team");
  const name = root.querySelector('[name="name"]');
  name.value = "First team S4";
  name.focus();
  name.setSelectionRange(5, 5);
  repaint(editTeam("First team"));
  const again = root.querySelector('[name="name"]');
  assert.notEqual(again, name, "a new node");
  assert.equal(dom.window.document.activeElement, again);
  assert.deepEqual([again.selectionStart, again.selectionEnd], [5, 5]);
});

test("after a successful save the form on screen is reset, also when a repaint replaced the submitted one", () => {
  root.innerHTML = editTeam("First team");
  const submitted = root.querySelector("form");
  submitted.querySelector('[name="name"]').value = "Typed";
  submitted.querySelector('[name="password"]').value = "s3cret-demo";
  repaint(editTeam("First team")); // a late answer during the request: the typed values move into a new form
  assert.equal(submitted.isConnected, false);
  resetLiveForm(submitted, dom.window.document);
  assert.equal(root.querySelector('[name="name"]').value, "First team");
  assert.equal(root.querySelector('[name="password"]').value, "", "no password left on screen");
});
