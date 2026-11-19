// Builds the static design mockups of docs/design/calendar-k4/ (README.md).
// Run: node docs/design/calendar-k4/build.mjs
// Not app code: it writes plain HTML that links the app's real stylesheet
// (frontend/styles.css) and mockup.css. Every name, place and number is invented.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- icons ----
const P = {
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  athletes: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2c2.2.2 3.8 1.8 4.5 4.8"/>',
  builder: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  load: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  run: '<circle cx="14" cy="4.5" r="1.8"/><path d="M6 20l4-5 3 2 2-5-4-2-3 3"/><path d="M15 12l3 2 2-1"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8"/>',
  bus: '<rect x="4" y="4" width="16" height="13" rx="2"/><path d="M4 11h16M7 20v-3M17 20v-3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  barbell: '<path d="M3 12h18M6 8v8M9 6v12M15 6v12M18 8v8"/>',
  chevL: '<path d="M15 6l-6 6 6 6"/>',
  chevR: '<path d="M9 6l6 6-6 6"/>',
};
const icon = (name, cls = "k4-icon") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name]}</svg>`;

// Event colours: the calendar's closed palette (styles.css --cc-team-N).
const C = { training: "#1f6f68", match: "#b5542b", travel: "#4a5fc1", gym: "#8a4c8f" };

// ---------------------------------------------------------------- frame ----
function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<!-- A STATIC DESIGN MOCKUP, not the app. Invented data only. See README.md. -->
<link rel="stylesheet" href="../../../frontend/styles.css">
<link rel="stylesheet" href="./mockup.css">
</head>
<body class="k4-doc">
${body}
</body>
</html>
`;
}
const step = (label, note = "") => `<p class="k4-step">${label}${note ? `<small>${note}</small>` : ""}</p>`;

function coachShell(eyebrow, h1, inner, active = "calendar") {
  const rail = ["home", "calendar", "athletes", "builder", "load"]
    .map((k) => `<span class="${k === active ? "on" : ""}">${icon(k, "")}</span>`).join("");
  return `<div class="k4-shell">
  <nav class="k4-rail" aria-label="Main">${rail}</nav>
  <main class="k4-main central-calendar">
    <header class="k4-topbar"><span class="k4-menu">${icon("menu")}</span><div><p class="eyebrow">${eyebrow}</p><h1>${h1}</h1></div></header>
    ${inner}
  </main>
</div>`;
}
function athleteShell(h1, tab, inner) {
  return `<div class="k4-shell">
  <nav class="k4-rail" aria-label="Main">${["home", "calendar", "builder", "athletes"].map((k) => `<span class="${(tab === "Calendar" && k === "calendar") || (tab === "Home" && k === "home") || (tab === "Weekly plan" && k === "builder") ? "on" : ""}">${icon(k, "")}</span>`).join("")}</nav>
  <main class="k4-main athlete-home-events">
    <header class="k4-topbar"><span class="k4-menu">${icon("menu")}</span><div><p class="eyebrow">Athlete</p><h1>${h1}</h1></div></header>
    <div class="k4-ath-tabs" role="tablist">${["Home", "Calendar", "Weekly plan"].map((t) => `<span class="${t === tab ? "on" : ""}">${t}</span>`).join("")}</div>
    ${inner}
  </main>
</div>`;
}

// ------------------------------------------------- the coach's calendar ----
const DAYS = [["Mon", 12], ["Tue", 13], ["Wed", 14], ["Thu", 15], ["Fri", 16], ["Sat", 17], ["Sun", 18]];
function ccCard({ when, kind, title, place = "", color = C.training, ic = "run", badge = "", count = "", open = false }) {
  return `<button type="button" class="cc-card cc-card-event${open ? " is-open" : ""}" style="--cc-team-color:${color}">
  <span class="cc-card-stripe" aria-hidden="true"></span>
  <span class="cc-card-body">
    <span class="cc-card-top"><span class="k4-tint" style="--k4-c:${color}">${icon(ic)}</span><span class="cc-card-when">${when}</span><span class="cc-card-kind">${kind}</span></span>
    <span class="cc-card-title">${title}</span>
    ${place ? `<span class="cc-card-place">${place}</span>` : ""}
    <span class="cc-card-meta"><span class="cc-team-pill"><span class="cc-team-dot" style="background:${color}"></span><span class="cc-team-pill-name">U19</span></span>${badge}${count ? `<span class="cc-card-count">${count}</span>` : ""}</span>
  </span>
</button>`;
}
const weekItems = {
  12: [ccCard({ when: "10:00", kind: "Training", title: "Team training", place: "North field", count: "18", open: true })],
  13: [ccCard({ when: "17:30", kind: "Training", title: "Speed & agility", place: "Indoor hall", count: "18" })],
  15: [ccCard({ when: "10:00", kind: "Training", title: "Tactical session", place: "North field", count: "18" })],
  17: [ccCard({ when: "15:00", kind: "Match", title: "U19 vs Lakeside", place: "City stadium", color: C.match, ic: "trophy", count: "20" })],
};
function weekColumns() {
  return `<div class="cc-week">${DAYS.map(([d, n]) => `<div class="cc-day-column${n === 12 ? " is-today" : ""}">
  <button type="button" class="cc-day-head"><span class="cc-day-name">${d}</span><span class="cc-day-number">${n}</span>${weekItems[n] ? `<span class="cc-day-count">${weekItems[n].length}</span>` : ""}</button>
  <div class="cc-day-cards">${(weekItems[n] || []).join("")}</div></div>`).join("")}</div>`;
}
function weekList() {
  return `<div class="k4-cal-list">${DAYS.filter(([, n]) => weekItems[n]).map(([d, n]) => `<div><p class="k4-day-label"><b>${d} ${n}.10</b>${n === 12 ? " · today" : ""}</p><div class="cc-day-cards">${weekItems[n].join("")}</div></div>`).join("")}</div>`;
}
function calNav() {
  return `<div class="k4-nav"><span class="k4-period">12 – 18 Oct 2026</span><button class="plain-button k4-btn" aria-label="Previous week">${icon("chevL")}</button><button class="plain-button k4-btn">Today</button><button class="plain-button k4-btn" aria-label="Next week">${icon("chevR")}</button><span class="k4-spacer"></span><button class="plain-button cc-primary k4-btn">New event</button></div>`;
}
function panelHead({ title = "Team training", when = "Monday 12 October 2026 (today) · 10:00–11:30", kind = "Training", color = C.training, ic = "run" } = {}) {
  return `<header class="cc-panel-head"><h3 class="cc-panel-title">${title}</h3><button class="plain-button icon-button cc-panel-close" aria-label="Close">×</button></header>
  <p class="cc-panel-kind"><span class="k4-tint" style="--k4-c:${color}">${icon(ic)}</span> <span>${kind}</span></p>
  <p class="cc-panel-when">${when}</p>
  <p class="cc-panel-note k4-row">${icon("pin")} North field · <a href="#" style="color:var(--accent);font-weight:800">Open in maps</a></p>
  <p class="cc-panel-teams"><span class="cc-panel-team"><span class="cc-team-dot" style="background:${color}"></span>U19 · 18 athletes</span></p>`;
}

// ================================================= 01 K3 =================
function k3Page() {
  const panel = `<aside class="cc-panel" aria-label="Team training">
  ${panelHead()}
  <p class="cc-panel-note">Collects: RPE.</p>
  <section class="k4-callout" data-callout="NEW" style="display:grid;gap:8px">
    <h5 class="cc-link-heading" style="margin:0">Training</h5>
    <p class="cc-panel-note">No training is planned for this event yet.</p>
    <button class="plain-button cc-primary k4-btn" style="justify-self:stretch">${icon("builder")} Plan the training</button>
  </section>
  <div class="cc-panel-actions"><button class="plain-button cc-panel-button">Edit</button><button class="plain-button cc-panel-button cc-danger-outline">Cancel event</button></div>
</aside>`;
  const calendar = coachShell("Central calendar", "Calendar", `${calNav()}<div class="k4-cal">${weekColumns()}${weekList()}${panel}</div>`);

  const band = (color = C.training) => `<section class="k4-band k4-callout" data-callout="NEW · band" style="--k4-c:${color}" role="region" aria-label="Planning for event Team training">
  <span class="k4-band-bar" aria-hidden="true"></span>
  <div><p class="k4-band-title"><span class="k4-tint">${icon("run")}</span>Team training <span class="k4-band-meta">· Mon 12.10 · 10:00–11:30 · North field · 18 athletes</span></p>
  <p class="k4-band-line">Sessions on this day go into this event.</p></div>
  <button class="plain-button k4-btn k4-band-back">${icon("back")} Back to calendar</button>
</section>`;
  const session = ({ slot, ampm, name, time, out = false, body }) => `<div class="k4-session">
  <div class="k4-session-top"><span class="k4-slot k4-ampm">${ampm}</span><span class="k4-slot">${slot}</span><span class="k4-session-name">${name}</span><span class="k4-session-time">${time}</span><span class="k4-spacer"></span>
  ${out ? `<button class="k4-in is-out"><span class="k4-dot"></span>Not in this event</button><button class="k4-link">Put back</button>` : `<button class="k4-in" aria-pressed="true"><span class="k4-dot"></span>In this event</button>`}</div>
  <div class="k4-session-body">${body}</div></div>`;
  const builder = coachShell("Builder · weekly plan", "Training · Mon 12.10", `${band()}
  <div class="k4-plan-head"><span class="k4-pill">${icon("athletes")} 18 athletes</span><span class="k4-pill">Week 12 – 18 Oct</span><span class="k4-pill">Draft</span></div>
  <div class="k4-day is-event" style="--k4-c:${C.training}">
    <div class="k4-day-head"><span class="k4-day-name">Monday 12.10.2026</span><span class="k4-in" style="min-height:30px;font-size:12px"><span class="k4-dot"></span>In this event</span><span class="k4-spacer"></span><button class="plain-button k4-btn">+ Session</button></div>
    ${session({ ampm: "AM", slot: "Before training", name: "Mobility & activation", time: "10:00 · from the event", body: "4 exercises · 15 min" })}
    ${session({ ampm: "AM", slot: "Training", name: "Main session", time: "10:30", body: "Rondos, small-sided games, finishing · 60 min" })}
    ${session({ ampm: "PM", slot: "After training", name: "Recovery", time: "16:00", out: true, body: "Pool + stretching · not part of this event" })}
  </div>
  <div class="k4-day k4-day-dim"><div class="k4-day-head"><span class="k4-day-name">Tuesday 13.10.2026</span><span class="k4-muted" style="font-size:14px">Other days are planned as usual.</span></div></div>
  <div class="k4-savebar"><span class="k4-note">Saving publishes the plan to the 18 athletes and links 2 sessions to the event.</span><span class="k4-spacer"></span><button class="plain-button cc-primary k4-btn k4-callout" data-callout="replaces ✓">${icon("check")} Save and link</button></div>`, "builder");

  const done = coachShell("Builder · weekly plan", "Training · Mon 12.10", `${band()}
  <p class="k4-ok" role="status">${icon("check")} Saved. 2 sessions for 18 athletes are in Team training · Mon 12.10.</p>
  <div class="k4-row" style="margin-top:10px"><button class="plain-button cc-primary k4-btn">${icon("back")} Back to calendar</button><button class="plain-button k4-btn">Keep editing</button></div>
  <p class="k4-step" style="margin-top:22px;background:#52607a">Other outcomes, same place</p>
  <div style="display:grid;gap:10px;margin-top:10px">
    <div class="k4-warn">${icon("alert")} Saved. We couldn't confirm the link. Checking never links twice. <button class="plain-button k4-btn">Check result</button></div>
    <div class="k4-warn">${icon("alert")} Some athletes of this training are not part of this event. Add them to the event first. <button class="plain-button k4-btn">Try linking again</button><button class="plain-button k4-btn">Back to calendar</button></div>
    <div class="k4-warn" style="background:#f8e3e3;color:#7d2626">${icon("alert")} The plan wasn't saved, so nothing was linked to the event. <button class="plain-button k4-btn">Try again</button></div>
  </div>`, "builder");

  const mixed = `<div class="k4-main"><div class="k4-backdrop"><section class="k4-sheet" role="dialog" aria-labelledby="mx">
  <h3 id="mx">Plan the training · Team training</h3>
  <p><b>12 athletes</b> have no plan for this week.</p>
  <p class="k4-muted"><b>6 already have one:</b> Ana K., Ben D., Mia S., Leo R. (and 2 more).</p>
  <div class="k4-row"><button class="plain-button cc-primary k4-btn">Plan for the 12</button><button class="plain-button k4-btn">Open an existing plan</button><button class="plain-button k4-btn">Cancel</button></div>
  <p class="k4-note">2 athletes of this event aren't in your workspace; plan their training in their own workspace.</p>
</section></div></div>`;

  return page("K3 · Plan the training", [
    step("1 · Calendar → event panel", "the coach opens the event; the one primary action is Plan the training"),
    calendar,
    step("2 · Builder inside the event", "band on top, the day marked, each session In / Not in this event, Save and link"),
    builder,
    step("3 · After Save and link", "one sentence, one next step; Back returns to the event"),
    done,
    step("2b · Only when athletes already have a plan (case c)", "a bottom sheet on a phone, a dialog on a computer"),
    mixed,
  ].join("\n"));
}

// ================================================ 02 K2c-3 ===============
function k2c3Page() {
  const chip = ({ title, meta, color, ic = "run", locked = false }) => `<button class="k4-chip${locked ? " is-locked" : ""}" style="--k4-c:${color}"><span class="k4-chip-bar"></span><span class="k4-tint">${icon(locked ? "lock" : ic)}</span>${title} <span class="k4-chip-meta">${meta}</span></button>`;
  const sel = (value, linked, color = C.training) => `<span class="k4-select-wrap"><label>Event:</label><select class="k4-select${linked ? " is-linked" : ""}" style="--k4-c:${color}"><option>${value}</option></select></span>`;
  const session = ({ ampm, slot, name, time, select, extra = "" }) => `<div class="k4-session">
  <div class="k4-session-top"><span class="k4-slot k4-ampm">${ampm}</span><span class="k4-slot">${slot}</span><span class="k4-session-name">${name}</span><span class="k4-session-time">${time}</span><span class="k4-spacer"></span>${select}</div>${extra}</div>`;

  const day = coachShell("Builder · weekly plan", "Week 12 – 18 Oct · U19 (18 athletes)", `
  <div class="k4-plan-head"><span class="k4-pill">${icon("athletes")} 18 athletes</span><span class="k4-pill">Published</span></div>
  <div class="k4-day">
    <div class="k4-day-head"><span class="k4-day-name">Monday 12.10.2026</span><span class="k4-day-tag">MD-1</span><span class="k4-spacer"></span><button class="plain-button k4-btn">+ Session</button></div>
    <div class="k4-events-row k4-callout" data-callout="NEW · events row">
      <span class="k4-events-label">Events:</span>
      ${chip({ title: "Team training", meta: "10:00–11:30 · North field", color: C.training })}
      ${chip({ title: "Video review", meta: "09:00 · Managed by the club", color: "#52607a", locked: true })}
      <span class="k4-spacer"></span>
      <button class="plain-button k4-btn k4-create">${icon("calendar")} Create event ${icon("arrow")}</button>
    </div>
    <div class="k4-wholeday"><label for="wd">Whole day:</label><select id="wd" class="k4-select"><option>Choose an event for every session…</option></select></div>
    ${session({ ampm: "AM", slot: "Before training", name: "Mobility & activation", time: "10:00 · from the event", select: sel("Team training 10:00", true) })}
    ${session({ ampm: "AM", slot: "Training", name: "Main session", time: "08:00", select: sel("No event", false),
      extra: `<p class="k4-warn">${icon("clock")} Main session is at 08:00, outside the event (10:00–11:30). Change its time first. <button class="plain-button k4-btn">Use the event's time</button></p>` })}
    ${session({ ampm: "PM", slot: "After training", name: "Recovery", time: "16:00", select: sel("No event", false) })}
  </div>`, "builder");

  const list = `<div class="k4-main"><p class="k4-note" style="margin-bottom:8px">What the <b>Event</b> list offers for <b>Before training · AM</b> (a native select on the device):</p>
  <ul class="k4-list" role="listbox">
    <li class="is-on" style="--k4-c:${C.training}"><span class="k4-tint">${icon("check")}</span><span>Team training · 10:00–11:30<small>Morning event · AM sessions fit</small></span></li>
    <li class="is-off">${icon("lock")}<span>Video review · 09:00<small>Linked by the club's admin from the calendar.</small></span></li>
    <li>— <span>No event<small>Stays its own training, as today</small></span></li>
  </ul>
  <p class="k4-note" style="margin-top:12px">A PM session (Recovery 16:00) would not be offered the morning event: O15, AM/PM must fit the event's half of the day.</p></div>`;

  const outside = coachShell("Builder · weekly plan", "Week 12 – 18 Oct · U19", `
  <div class="k4-day" style="--k4-c:${C.training}">
    <div class="k4-day-head"><span class="k4-day-name">Monday 12.10.2026</span></div>
    ${session({ ampm: "AM", slot: "Training", name: "Main session", time: "10:30", select: sel("Team training 10:00", true),
      extra: `<p class="k4-warn">${icon("alert")} Outside the event's time (11:00–12:30) <button class="plain-button k4-btn">Use the event's time</button><button class="k4-link">Open the event</button></p>` })}
  </div>
  <p class="k4-note">Shown when the event was moved later in the calendar. Nothing changes by itself.</p>`, "builder");

  const unsaved = `<div class="k4-main"><div class="k4-backdrop"><section class="k4-sheet" role="dialog" aria-labelledby="us">
  <h3 id="us">This plan isn't saved yet</h3>
  <p>Save it (the athletes will see it) and continue?</p>
  <div class="k4-row"><button class="plain-button cc-primary k4-btn">Save and continue</button><button class="plain-button k4-btn">Cancel</button></div>
</section></div></div>`;

  return page("K2c-3 · The Builder's events row", [
    step("1 · The Builder's day", "Events row, Create event →, Whole day, Event: [▾] on each session, and a time that doesn't fit"),
    day,
    step("2 · The Event list, open", "only the same day, only the session's half of the day, a locked event explained"),
    list,
    step("3 · The event moved later", "Outside the event's time, never fixed silently"),
    outside,
    step("4 · A draft that was never saved", "asked once, before Create event → or the selector"),
    unsaved,
  ].join("\n"));
}

// =========================================== 03 the form from the Builder ===
function formPage() {
  const field = (label, value, type = "text", hint = "") => `<label class="cc-field"><span class="cc-field-label">${label}</span><input type="${type}" value="${value}">${hint ? `<span class="cc-field-optional">${hint}</span>` : ""}</label>`;
  const form = `<aside class="cc-panel" style="max-width:640px">
  <header class="cc-panel-head"><h3 class="cc-panel-title">New event</h3><button class="plain-button icon-button cc-panel-close" aria-label="Close">×</button></header>
  <form class="cc-event-form" onsubmit="return false">
   <fieldset class="cc-form-fields" style="border:0;padding:0;margin:0;display:grid;gap:12px">
    <label class="cc-field"><span class="cc-field-label">Type</span><select><option>Training</option></select></label>
    ${field("Title", "Main session")}
    <div class="cc-form-grid">${field("Day", "2026-10-12", "date")}${field("Last day", "", "date", "For a camp, a trip or days off.")}${field("Starts", "10:00", "time")}${field("Ends", "11:30", "time")}</div>
    <fieldset style="border:0;padding:0;margin:0"><legend class="cc-field-label" style="font-weight:800">Who is it for?</legend>
      <p class="k4-row" style="margin:6px 0 0"><span class="cc-panel-team"><span class="cc-team-dot" style="background:${C.training}"></span>U19 · 18 athletes</span><span class="k4-note">from the plan</span></p></fieldset>
    <label class="cc-field"><span class="cc-field-label">Place</span><select><option>North field</option></select></label>
    <p class="k4-note">Collected after it: <b>RPE</b> · Notes and details as usual.</p>
   </fieldset>
   <div class="cc-form-actions k4-row" style="margin-top:14px"><button class="plain-button cc-primary k4-btn">Create event</button><button class="plain-button k4-btn">Close</button></div>
  </form>
</aside>`;
  const band = `<section class="k4-band k4-band-form k4-callout" data-callout="NEW · band" style="--k4-c:#b07a0a" role="region" aria-label="Creating an event for the Builder">
  <span class="k4-band-bar"></span>
  <div><p class="k4-band-title">${icon("builder")} Creating an event for the Builder <span class="k4-band-meta">· Monday 12.10</span></p><p class="k4-band-line">After Create event you go back to the Builder, with this event chosen for Main session.</p></div>
  <button class="plain-button k4-btn k4-band-back">${icon("back")} Back to the Builder</button>
</section>`;
  const screen = coachShell("Central calendar", "Calendar", `${band}${form}`);
  const back = coachShell("Builder · weekly plan", "Week 12 – 18 Oct · U19", `
  <p class="k4-ok">${icon("check")} The event Main session · 10:00–11:30 is in the calendar, with this session in it.</p>
  <div class="k4-day" style="margin-top:12px">
    <div class="k4-day-head"><span class="k4-day-name">Monday 12.10.2026</span></div>
    <div class="k4-events-row"><span class="k4-events-label">Events:</span><button class="k4-chip" style="--k4-c:${C.training}"><span class="k4-chip-bar"></span><span class="k4-tint">${icon("run")}</span>Main session <span class="k4-chip-meta">10:00–11:30 · North field</span></button><span class="k4-spacer"></span><button class="plain-button k4-btn k4-create">${icon("calendar")} Create event ${icon("arrow")}</button></div>
    <div class="k4-session"><div class="k4-session-top"><span class="k4-slot k4-ampm">AM</span><span class="k4-slot">Training</span><span class="k4-session-name">Main session</span><span class="k4-session-time">10:00 · from the event</span><span class="k4-spacer"></span><span class="k4-select-wrap"><label>Event:</label><select class="k4-select is-linked" style="--k4-c:${C.training}"><option>Main session 10:00</option></select></span></div></div>
  </div>`, "builder");
  return page("K2c-3 · The calendar's form, from the Builder", [
    step("1 · Create event → opens the calendar's own form", "prefilled: day, Training, title, time, the plan's athletes"),
    screen,
    step("2 · After Create event", "back in the Builder, the new event already chosen for that session"),
    back,
  ].join("\n"));
}

// ============================================ 04 K4a athlete calendar =====
function acard({ color = C.training, ic = "run", when, kind, title, place = "", sessions = [], actions = "", extra = "", cancelled = false }) {
  return `<article class="k4-acard${cancelled ? " is-cancelled" : ""}" style="--k4-c:${color}"><span class="k4-acard-bar"></span><div class="k4-acard-body">
  <p class="k4-acard-top"><span class="k4-tint">${icon(ic)}</span><span class="k4-when">${when}</span><span>${kind}</span>${cancelled ? `<span class="cc-badge cc-badge-cancelled">✕ Cancelled</span>` : ""}</p>
  <p class="k4-acard-title">${title}</p>
  ${place && !cancelled ? `<p class="k4-acard-place">${icon("pin")} ${place} <a href="#">Open in maps</a></p>` : ""}
  ${sessions.length ? `<ul class="k4-acard-sessions">${sessions.map(([s, n, t]) => `<li><span class="k4-slot">${s}</span><span><b>${n}</b>${t ? ` <span class="k4-muted">· ${t}</span>` : ""}</span></li>`).join("")}</ul>` : ""}
  ${extra}
  ${actions ? `<div class="k4-acard-actions">${actions}</div>` : ""}
</div></article>`;
}
function athleteWeek({ rpeState = "ask" } = {}) {
  const rpe = {
    ask: `<button class="plain-button cc-primary k4-btn">${icon("gauge")} Rate RPE</button>`,
    done: "",
  }[rpeState];
  const rpeLine = rpeState === "done" ? `<p class="k4-rpe-line">${icon("check")} Your RPE: 7 <span class="k4-spacer"></span><button class="plain-button k4-btn">${icon("edit")} Change</button><span style="flex-basis:100%;font-weight:600">You can change it until 22:00.</span></p>` : "";
  return `
  <div class="k4-nav"><span class="k4-period">12 – 18 Oct</span><button class="plain-button k4-btn" aria-label="Previous week">${icon("chevL")}</button><button class="plain-button k4-btn">Today</button><button class="plain-button k4-btn" aria-label="Next week">${icon("chevR")}</button></div>
  <div class="k4-strip k4-hide-desk">${DAYS.map(([d, n]) => `<button class="${n === 12 ? "is-today is-on" : ""}"><small>${d}</small><b>${n}</b>${[12, 13, 15, 17].includes(n) ? "<i></i>" : "<span style='height:6px'></span>"}</button>`).join("")}</div>
  <div class="k4-days">
    <section><p class="k4-day-label"><b>Monday 12.10</b> · today</p>
      ${acard({ when: "10:00–11:30", kind: "Training", title: "Team training", place: "North field", sessions: [["Before", "Mobility & activation", "15 min"], ["Training", "Main session", "10:30 · 60 min"]], extra: rpeLine, actions: `<button class="plain-button k4-btn k4-callout" data-callout="opens Weekly plan">${icon("builder")} Open training</button>${rpe}` })}
    </section>
    <section><p class="k4-day-label"><b>Tuesday 13.10</b></p>
      ${acard({ when: "17:30", kind: "Training", title: "Speed & agility", place: "Indoor hall", sessions: [["Training", "Sprint drills", ""]], actions: `<button class="plain-button k4-btn">${icon("builder")} Open training</button>` })}
      ${acard({ color: C.gym, ic: "barbell", when: "AM", kind: "My training", title: "Gym · upper body", actions: `<button class="plain-button k4-btn">${icon("builder")} Open training</button>` })}
    </section>
    <section><p class="k4-day-label"><b>Thursday 15.10</b></p>
      ${acard({ when: "10:00", kind: "Training", title: "Tactical session", cancelled: true })}
    </section>
    <section><p class="k4-day-label"><b>Saturday 17.10</b></p>
      ${acard({ color: C.travel, ic: "bus", when: "12:30", kind: "Travel", title: "Bus to City stadium", place: "Club car park" })}
      ${acard({ color: C.match, ic: "trophy", when: "15:00", kind: "Match", title: "U19 vs Lakeside", place: "City stadium" })}
    </section>
  </div>`;
}
function k4aPage() {
  const cal = athleteShell("Calendar", "Calendar", athleteWeek());
  const plan = athleteShell("Weekly plan", "Weekly plan", `
  <div class="k4-backbar k4-callout" data-callout="NEW"><button class="plain-button k4-btn">${icon("back")} Back to calendar</button><span class="k4-muted" style="font-size:14px">Monday 12.10 · Team training</span></div>
  <div class="k4-day" style="--k4-c:${C.training}">
    <div class="k4-day-head"><span class="k4-day-name">Monday 12.10</span><span class="k4-muted" style="font-size:14px">Team training · 10:00–11:30 · North field</span></div>
    <div class="k4-session"><div class="k4-session-top"><span class="k4-slot">Before training</span><span class="k4-session-name">Mobility & activation</span><span class="k4-session-time">10:00</span></div><div class="k4-session-body">Hip openers 2×10 · Band walks 2×12 · Leg swings 2×10 · Activation sprints 4×20 m</div></div>
    <div class="k4-session" style="box-shadow:inset 0 0 0 2px var(--accent-soft)"><div class="k4-session-top"><span class="k4-slot">Training</span><span class="k4-session-name">Main session</span><span class="k4-session-time">10:30</span></div><div class="k4-session-body">Rondo 5v2 · Small-sided games 4×4 · Finishing</div></div>
  </div>
  <p class="k4-note">The phone's Back and this button both return to the same week, day and scroll position.</p>`);
  return page("K4a · The athlete's Calendar", [
    step("1 · The athlete's Calendar", "a week by days; an event linked to training is ONE card; Open training and Rate RPE"),
    cal,
    step("2 · Open training → the Weekly plan on that day", "a visible Back to calendar"),
    plan,
  ].join("\n"));
}

// ================================================ 05 K4b change RPE =====
function k4bPage() {
  const cal = athleteShell("Calendar", "Calendar", athleteWeek({ rpeState: "done" }));
  const home = athleteShell("Home", "Home", `
  <section class="panel" style="padding:16px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);display:grid;gap:10px">
    <p class="eyebrow" style="margin:0">Today</p>
    ${acard({ when: "10:00–11:30", kind: "Training", title: "Team training", place: "North field", extra: `<p class="k4-rpe-line k4-callout" data-callout="NEW">${icon("check")} Your RPE: 7 <span class="k4-spacer"></span><button class="plain-button k4-btn">${icon("edit")} Change</button><span style="flex-basis:100%;font-weight:600">You can change it until 22:00.</span></p>`, actions: `<button class="plain-button k4-btn">${icon("builder")} Open training</button>` })}
  </section>`, );
  const scale = Array.from({ length: 11 }, (_, i) => `<button class="${i === 7 ? "is-on" : ""}">${i}</button>`).join("");
  const form = `<div class="k4-main"><div class="k4-backdrop"><section class="k4-sheet" role="dialog" aria-labelledby="rf" style="max-width:560px">
  <h3 id="rf">Change your RPE · Team training</h3>
  <p class="k4-note">Monday 12.10 · 10:00–11:30. Your answer: <b>7</b>, sent at 12:04.</p>
  <div class="k4-rpe-scale" role="radiogroup" aria-label="RPE 0 to 10">${scale}</div>
  <div class="k4-rpe-word"><span>0 · Rest</span><span>10 · Maximal</span></div>
  <label class="k4-field"><span>Duration (minutes)</span><input value="90" readonly><small class="k4-muted">Set by your coach; it can't be changed here.</small></label>
  <label class="k4-field"><span>Note <span class="k4-muted">(optional)</span></span><textarea rows="2">Legs heavy after the weekend.</textarea></label>
  <p class="k4-note">${icon("clock")} You can change it until 22:00. Your coach sees that it was changed.</p>
  <div class="k4-row"><button class="plain-button cc-primary k4-btn">Save change</button><button class="plain-button k4-btn">Cancel</button></div>
</section></div></div>`;
  const closed = athleteShell("Calendar", "Calendar", `<div class="k4-days"><section><p class="k4-day-label"><b>Monday 12.10</b></p>
    ${acard({ when: "10:00–11:30", kind: "Training", title: "Team training", place: "North field", extra: `<p class="k4-rpe-line is-closed">${icon("lock")} Your RPE: 7 · Answers closed at 22:00.</p>`, actions: `<button class="plain-button k4-btn">${icon("builder")} Open training</button>` })}
  </section></div>`);
  return page("K4b · Changing an RPE answer", [
    step("1 · After answering: on the Calendar card", "Your RPE: 7 · Change, with the deadline"),
    cal,
    step("2 · The same line on Home", ""),
    home,
    step("3 · Change → the form, filled in", "one primary action: Save change"),
    form,
    step("4 · After the question closes", "the value stays, Change is gone, a stable sentence"),
    closed,
  ].join("\n"));
}

// ===================================== 06 the coach's event panel (RPE) ===
function panelPage() {
  const rows = [
    ["Ivo P.", null, null], ["Kai B.", null, null], ["Lena M.", null, null], ["Ana K.", 7, 90, true], ["Ben D.", 6, 90], ["Mia S.", 8, 90], ["Leo R.", 7, 85], ["Noah T.", 5, 90],
    ["Ema V.", 7, 90], ["Sara L.", 8, 90],
  ];
  const list = rows.map(([n, r, d, ch]) => `<li><span class="k4-who"><a href="#">${n}</a>${ch ? `<span class="k4-changed" title="Changed by the athlete at 20:41 (was 6)">${icon("edit")} changed</span>` : ""}</span>${r == null ? `<span class="k4-num k4-waiting">—</span><span class="k4-num k4-waiting">waiting</span>` : `<span class="k4-num">${r}</span><span class="k4-num">${d} min</span>`}</li>`).join("");
  const panel = `<aside class="cc-panel" aria-label="Team training">
  ${panelHead()}
  <section class="k4-callout" data-callout="NEW · answers" style="display:grid;gap:10px">
    <h4 class="cc-panel-subtitle">RPE answers</h4>
    <div class="k4-sum"><div><small>Answered</small><b>12/15</b></div><div><small>Average RPE</small><b>6.8</b></div><div><small>Avg duration</small><b>89 min</b></div></div>
    <p class="k4-note">3 waiting (listed first) · answers close at 22:00 · 1 changed. 15 of the 18 were asked: 3 are marked Did not participate.</p>
    <ul class="k4-answers" role="list"><li class="k4-answers-head"><span>Athlete</span><span class="k4-num">RPE</span><span class="k4-num">Duration</span></li>${list}</ul>
    <p class="k4-history">Ana K. changed RPE 6 → 7 at 20:41.</p>
    <p class="k4-note">Showing 10 of 15 · <a href="#" style="color:var(--accent);font-weight:800">Show all</a></p>
    <button class="plain-button cc-primary k4-btn" style="justify-self:stretch">${icon("load")} Open in Training Load</button>
  </section>
  <section style="display:grid;gap:6px"><h5 class="cc-link-heading" style="margin:0">Linked trainings</h5><p class="cc-panel-note">Before training · Mobility & activation · 18 athletes</p><p class="cc-panel-note">Training · Main session · 18 athletes</p><button class="plain-button k4-btn" style="justify-self:start">${icon("builder")} Open the training</button></section>
  <div class="cc-panel-actions"><button class="plain-button cc-panel-button">Edit</button><button class="plain-button cc-panel-button cc-danger-outline">Cancel event</button></div>
</aside>`;
  return page("Coach · the event panel with answers", [
    step("The coach's event panel after training", "summary first, then each athlete; a changed answer is marked with a glyph and the word"),
    coachShell("Central calendar", "Calendar", `${calNav()}<div class="k4-cal">${weekColumns()}${weekList()}${panel}</div>`),
  ].join("\n"));
}

const pages = {
  "01-k3-plan-the-training.html": k3Page(),
  "02-k2c3-builder-events-row.html": k2c3Page(),
  "03-k2c3-event-form-from-builder.html": formPage(),
  "04-k4a-athlete-calendar.html": k4aPage(),
  "05-k4b-change-rpe.html": k4bPage(),
  "06-coach-event-panel-answers.html": panelPage(),
};
for (const [name, html] of Object.entries(pages)) writeFileSync(join(here, name), html.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n"));
console.log(Object.keys(pages).join("\n"));
