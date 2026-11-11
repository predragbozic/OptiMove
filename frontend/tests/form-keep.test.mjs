import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { captureChangedFields, restoreChangedFields } from "../form-keep.js";

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
