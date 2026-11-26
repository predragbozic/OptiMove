import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bindCentralCalendarTimePicker } from "../central-calendar-time-picker.js";
import { buildCentralCalendarEventRequest, newCentralCalendarCreateForm } from "../central-calendar-event-form.js";

test("phone wheel preserves exact minutes and removing time keeps the event date", () => {
  const { document } = new JSDOM(`
    <section class="cc-layout-phone"><fieldset>
      <input type="date" value="2026-11-26">
      <label><input type="time" data-cc-event-field="startTime" value="09:16"></label>
      <label><input type="time" data-cc-event-field="endTime" value="10:30"></label>
    </fieldset></section>`).window;
  const calendar = document.querySelector("section");
  const changed = [];
  calendar.addEventListener("change", (event) => changed.push([event.target.dataset.ccEventField, event.target.value]));
  bindCentralCalendarTimePicker(calendar);
  calendar.querySelector('[data-time-field="0"]').click();
  calendar.querySelector('[data-time-wheel="1"] [data-tick="1"]').click();
  calendar.querySelector(".cc-time-picker-apply").click();
  assert.deepEqual(changed, [["startTime", "09:17"]]);
  calendar.querySelector('[data-timing="untimed"]').click();
  assert.deepEqual(changed.slice(1), [["startTime", ""], ["endTime", ""]]);
  assert.equal(calendar.querySelector('[type="date"]').value, "2026-11-26");
  assert.ok(calendar.querySelector('[type="time"]').closest("label").hidden);
});

test("the picker is unavailable for disabled event fields", () => {
  const { document } = new JSDOM(`<section class="cc-layout-phone"><fieldset disabled>
    <label><input type="time" data-cc-event-field="startTime"></label>
    <label><input type="time" data-cc-event-field="endTime"></label>
  </fieldset></section>`).window;
  bindCentralCalendarTimePicker(document.querySelector("section"));
  assert.equal(document.querySelector(".cc-time-picker"), null);
});

test("the existing event request accepts a midnight crossing with a later end date", () => {
  const form = newCentralCalendarCreateForm({ day: "2026-11-26", types: [] });
  Object.assign(form.draft, {
    eventTypeId: "training",
    title: "Late training",
    startTime: "23:45",
    endTime: "00:15",
    targets: [{ kind: "team", id: "team-1" }],
  });
  assert.match(buildCentralCalendarEventRequest(form).errors.endTime, /after the start/);
  form.draft.endDay = "2026-11-27";
  const { body, errors } = buildCentralCalendarEventRequest(form);
  assert.deepEqual(errors, {});
  assert.deepEqual([body.endDay, body.startTime, body.endTime], ["2026-11-27", "23:45", "00:15"]);
});
