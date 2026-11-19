// Builds the static K5 design mockups of docs/design/calendar-k5/ (README.md).
// Run: node docs/design/calendar-k5/build.mjs
// Not app code: plain HTML on the app's real stylesheet plus mockup.css. Invented data only.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Tabler paths; gps, clipboard and gauge are copied from frontend/icon-library.js.
const P = {
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  athletes: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2c2.2.2 3.8 1.8 4.5 4.8"/>',
  builder: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  load: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  tests: '<path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2"/><path d="M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2"/><path d="M9 12h.01M13 12h2M9 16h.01M13 16h2"/>',
  gps: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M12 17l-1 -4l-4 -1l9 -4l-4 9"/>',
  gauge: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M13.41 10.59l2.59 -2.59"/><path d="M7 12a5 5 0 0 1 5 -5"/>',
  run: '<circle cx="14" cy="4.5" r="1.8"/><path d="M6 20l4-5 3 2 2-5-4-2-3 3"/><path d="M15 12l3 2 2-1"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8"/>',
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chevL: '<path d="M15 6l-6 6 6 6"/>',
  chevR: '<path d="M9 6l6 6-6 6"/>',
  roster: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18h3"/>',
};
const icon = (n, cls = "k4-icon") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`;
const C = { training: "#1f6f68", match: "#b5542b", test: "#8a4c8f", rpe: "#b07a0a", gps: "#2c5aa0", plan: "#3b7f9c" };

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
<script>/* Mockup only: the chosen "Show only" chip is scrolled into view, as the app should do. */
document.querySelectorAll(".k5-quick").forEach((row) => { const on = row.querySelector(".is-on"); if (on) row.scrollLeft = on.offsetLeft - row.offsetLeft - (row.clientWidth - on.offsetWidth) / 2; });</script>
</body>
</html>
`;
}
const step = (label, note = "") => `<p class="k4-step">${label}${note ? `<small>${note}</small>` : ""}</p>`;
function shell(eyebrow, h1, inner, active = "calendar") {
  const rail = ["home", "calendar", "athletes", "builder", "tests", "load"].map((k) => `<span class="${k === active ? "on" : ""}">${icon(k, "")}</span>`).join("");
  return `<div class="k4-shell"><nav class="k4-rail" aria-label="Main">${rail}</nav>
  <main class="k4-main central-calendar"><header class="k4-topbar"><span class="k4-menu">${icon("menu")}</span><div><p class="eyebrow">${eyebrow}</p><h1>${h1}</h1></div></header>
  ${inner}</main></div>`;
}
const nav = (label = "12 – 18 Oct 2026") => `<div class="k4-nav"><span class="k4-period">${label}</span><button class="plain-button k4-btn" aria-label="Previous week">${icon("chevL")}</button><button class="plain-button k4-btn">Today</button><button class="plain-button k4-btn" aria-label="Next week">${icon("chevR")}</button><span class="k4-spacer"></span><button class="plain-button cc-primary k4-btn">New event</button></div>`;

function card({ when, kind, title, place = "", color = C.training, ic = "run", extra = "", count = "", open = false }) {
  return `<button type="button" class="cc-card cc-card-event${open ? " is-open" : ""}" style="--cc-team-color:${color}">
  <span class="cc-card-stripe" aria-hidden="true"></span>
  <span class="cc-card-body">
    <span class="cc-card-top"><span class="k4-tint" style="--k4-c:${color}">${icon(ic)}</span><span class="cc-card-when">${when}</span><span class="cc-card-kind">${kind}</span></span>
    <span class="cc-card-title">${title}</span>
    ${place ? `<span class="cc-card-place">${place}</span>` : ""}
    <span class="cc-card-meta"><span class="cc-team-pill"><span class="cc-team-dot" style="background:${color}"></span><span class="cc-team-pill-name">U19</span></span>${extra}${count ? `<span class="cc-card-count">${count}</span>` : ""}</span>
  </span></button>`;
}
const gpsMark = (n) => `<span class="k5-gps" title="GPS data of ${n} athletes is in this event">${icon("gps", "")} GPS · ${n}</span>`;
const mark = ({ ic, text, color, waiting = false, label }) => `<button type="button" class="k5-mark${waiting ? " is-waiting" : ""}" style="--k5-c:${color}" aria-label="${label || text}">${icon(ic, "")}${text}</button>`;
const dayMark = (n) => `<button type="button" class="k5-daymark" aria-label="${n} GPS sessions to review in Imports">${icon("gps", "")}${n} GPS sessions to review</button>`;

// ---------------------------------------------------------------- the week ----
const DAYS = [["Mon", 12], ["Tue", 13], ["Wed", 14], ["Thu", 15], ["Fri", 16], ["Sat", 17], ["Sun", 18]];
function weekData({ suggest = false } = {}) {
  return {
    12: { cards: [card({ when: "10:00", kind: "Training", title: "Team training", place: "North field", extra: gpsMark(18), count: "18", open: !suggest })],
          marks: [mark({ ic: "gauge", text: "RPE · Gym", color: C.rpe, label: "RPE request, Gym, not in an event" })] },
    13: { cards: [card({ when: "17:30", kind: "Training", title: "Speed & agility", place: "Indoor hall", count: "18" })],
          marks: [mark({ ic: "tests", text: "CMJ test", color: C.test, label: "Test schedule CMJ, not in an event" })] },
    14: { cards: [], marks: [mark({ ic: "gps", text: "GPS 10:05", color: C.gps, label: "Imported GPS activity at 10:05, not in an event" })], daymark: 2 },
    15: { cards: [card({ when: "10:00", kind: "Training", title: "Tactical session", place: "North field", count: "18", open: suggest })],
          marks: [mark({ ic: "gps", text: "GPS 10:05", color: C.gps, label: "Imported GPS activity at 10:05, not in an event" })] },
    17: { cards: [card({ when: "15:00", kind: "Match", title: "U19 vs Lakeside", place: "City stadium", color: C.match, ic: "trophy", count: "20", extra: gpsMark(16) })], marks: [] },
  };
}
function weekColumns(data) {
  return `<div class="cc-week">${DAYS.map(([d, n]) => {
    const it = data[n] || { cards: [], marks: [] };
    const count = it.cards.length + it.marks.length;
    return `<div class="cc-day-column${n === 12 ? " is-today" : ""}">
    <button type="button" class="cc-day-head"><span class="cc-day-name">${d}</span><span class="cc-day-number">${n}</span>${count ? `<span class="cc-day-count">${count}</span>` : ""}</button>
    <div class="cc-day-cards">${it.cards.join("")}${it.marks.length ? `<div class="k5-marks">${it.marks.join("")}</div>` : ""}${it.daymark ? dayMark(it.daymark) : ""}</div></div>`;
  }).join("")}</div>`;
}
function weekList(data) {
  return `<div class="k4-cal-list">${DAYS.filter(([, n]) => data[n]).map(([d, n]) => { const it = data[n];
    return `<div><p class="k4-day-label"><b>${d} ${n}.10</b>${n === 12 ? " · today" : ""}</p><div class="cc-day-cards">${it.cards.join("")}${it.marks.length ? `<div class="k5-marks">${it.marks.join("")}</div>` : ""}${it.daymark ? dayMark(it.daymark) : ""}</div></div>`; }).join("")}</div>`;
}
function panelHead({ title, kindWord, ic, color, when, place = "" }) {
  return `<header class="cc-panel-head"><h3 class="cc-panel-title">${title}</h3><button class="plain-button icon-button cc-panel-close" aria-label="Close">×</button></header>
  <p class="cc-panel-kind"><span class="k4-tint" style="--k4-c:${color}">${icon(ic)}</span> <span>${kindWord}</span></p>
  <p class="cc-panel-when">${when}</p>${place ? `<p class="cc-panel-note k4-row">${icon("pin")} ${place}</p>` : ""}`;
}
const goBtn = (label, ic, primary = true) => `<button class="plain-button ${primary ? "cc-primary " : ""}k4-btn">${icon(ic)} ${label} ${icon("arrow")}</button>`;

// ============================================= 01 K5-1 Go there ===========
function goPage() {
  const panels = [
    `<aside class="cc-panel">${panelHead({ title: "Gym · upper body", kindWord: "Planned training · Builder", ic: "builder", color: C.plan, when: "Tuesday 13 October 2026 · AM" })}
      <p class="cc-panel-note">Planned for 6 athletes · Weekly plan of week 12–18 Oct.</p>
      <div class="k5-go k4-callout" data-callout="NEW">${goBtn("Open in Builder", "builder")}<p class="k4-note">Opens the plan on Tuesday. Back returns here.</p></div></aside>`,
    `<aside class="cc-panel">${panelHead({ title: "CMJ test", kindWord: "Test schedule", ic: "tests", color: C.test, when: "Tuesday 13 October 2026 · 08:30" })}
      <div class="cc-panel-status"><span class="cc-badge cc-badge-awaiting">◔ 7 of 18 results</span></div>
      <div class="k5-go k4-callout" data-callout="NEW">${goBtn("Open in Tests", "tests")}<p class="k4-note">Opens Tests on Tuesday, to enter results.</p></div></aside>`,
    `<aside class="cc-panel">${panelHead({ title: "RPE · Gym", kindWord: "RPE request", ic: "gauge", color: C.rpe, when: "Monday 12 October 2026 · answers until 22:00" })}
      <div class="cc-panel-status"><span class="cc-badge cc-badge-awaiting">◔ 4 of 6 answered</span></div>
      <div class="k5-go k4-callout" data-callout="NEW">${goBtn("Open in Training Load", "load")}<p class="k4-note">Opens Training Load › Schedule on this request.</p></div></aside>`,
    `<aside class="cc-panel">${panelHead({ title: "GPS session 10:05", kindWord: "Imported GPS activity", ic: "gps", color: C.gps, when: "Wednesday 14 October 2026 · 10:05–11:20" })}
      <p class="cc-panel-note">Device data of 17 athletes · source GPEXE.</p>
      <p class="k4-warn">${icon("alert")} 3 athletes need an attendance state.</p>
      <div class="k5-go k4-callout" data-callout="exists + Roster">${goBtn("Open in Training Load", "load")}<button class="plain-button k4-btn">${icon("roster")} Roster · 3 need a state</button></div></aside>`,
  ];
  const event = `<aside class="cc-panel" style="max-width:420px">${panelHead({ title: "Team training", kindWord: "Training", ic: "run", color: C.training, when: "Monday 12 October 2026 · 10:00–11:30", place: "North field" })}
    <h5 class="cc-link-heading" style="margin:0">In this event</h5>
    <ul class="cc-link-list" role="list" style="display:grid;gap:8px;padding:0;margin:0;list-style:none">
      <li class="k4-row" style="justify-content:space-between"><span>${icon("builder")} <b>Main session</b> <span class="k4-muted">· 18 athletes</span></span><button class="plain-button k4-btn">Open in Builder</button></li>
      <li class="k4-row" style="justify-content:space-between"><span>${icon("gauge")} <b>RPE</b> <span class="k4-muted">· 12 of 18</span></span><button class="plain-button k4-btn">Open in Training Load</button></li>
      <li class="k4-row" style="justify-content:space-between"><span class="k4-tint" style="--k4-c:${C.gps}">${icon("gps")}</span><span style="flex:1"><b>GPS</b> <span class="k4-muted">· 18 athletes</span></span><button class="plain-button k4-btn">Open in Training Load</button></li>
    </ul></aside>`;
  return page("K5-1 · Go there", [
    step("1 · One way to the work, in every panel", "Builder training · Tests schedule · RPE request · imported GPS activity"),
    shell("Central calendar", "Calendar", `<div class="k5-panels">${panels.join("")}</div>`),
    step("2 · An event: the buttons of what it holds, in that order", "Builder, then RPE / Tests, then GPS"),
    shell("Central calendar", "Calendar", event),
  ].join("\n"));
}

// =============================================== 02 K5-2 marks ============
function marksPage() {
  const data = weekData();
  const evPanel = `<aside class="cc-panel">${panelHead({ title: "Team training", kindWord: "Training", ic: "run", color: C.training, when: "Monday 12 October 2026 (today) · 10:00–11:30", place: "North field" })}
    <p class="cc-panel-note k4-row k4-callout" data-callout="NEW">${gpsMark(18)} GPS data of 18 athletes is in this event.</p>
    <div class="k5-go">${goBtn("Open in Training Load", "load")}</div></aside>`;
  const month = (() => {
    const cells = [];
    for (let d = 1; d <= 28; d += 1) {
      const n = d + 4; // 5 Oct … 1 Nov, invented
      const lines = [];
      if ([5, 12, 15, 19, 22, 26].includes(n)) lines.push(`<span class="cc-mini-line" style="--k5-c:${C.training}"><i></i><span>10:00 Training</span></span>`);
      if ([12, 26].includes(n)) lines.push(`<span class="cc-mini-line" style="--k5-c:${C.gps}">${icon("gps", "")}<span>GPS · 18</span></span>`);
      if ([14, 21].includes(n)) lines.push(`<span class="cc-mini-line" style="--k5-c:${C.gps}">${icon("gps", "")}<span>GPS 10:05</span></span>`);
      if ([13, 20].includes(n)) lines.push(`<span class="cc-mini-line" style="--k5-c:${C.test}">${icon("tests", "")}<span>CMJ test</span></span>`);
      if ([12].includes(n)) lines.push(`<span class="cc-mini-line" style="--k5-c:${C.rpe}">${icon("gauge", "")}<span>RPE · Gym</span></span>`);
      if ([17, 31].includes(n)) lines.push(`<span class="cc-mini-line" style="--k5-c:${C.match}"><i></i><span>15:00 Match</span></span>`);
      if (n === 14) lines.push(`<span class="k5-more">+ 2 GPS to review</span>`);
      cells.push(`<div><b>${n > 31 ? n - 31 : n}</b>${lines.join("")}</div>`);
    }
    return `<div class="k5-month">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<p class="k4-day-label" style="margin:0;text-align:center">${d}</p>`).join("")}${cells.join("")}</div>`;
  })();
  return page("K5-2 · GPS and small marks", [
    step("1 · The week", "GPS mark on an event card; a test, an RPE request and a GPS activity that are in no event become small chips under their day"),
    shell("Central calendar", "Calendar", `${nav()}<div class="k4-cal">${weekColumns(data)}${weekList(data)}${evPanel}</div>`),
    step("2 · The month", "the same marks as one line each; on a phone only the icon"),
    shell("Central calendar", "Calendar", `${nav("October 2026")}${month}`),
  ].join("\n"));
}

// ============================================ 03 K5-3 add to event ========
function suggestPage() {
  const data = weekData({ suggest: true });
  const panel = (who) => `<aside class="cc-panel">${who === "gps"
    ? panelHead({ title: "GPS session 10:05", kindWord: "Imported GPS activity", ic: "gps", color: C.gps, when: "Thursday 15 October 2026 · 10:05–11:20" })
    : panelHead({ title: "CMJ test", kindWord: "Test schedule", ic: "tests", color: C.test, when: "Tuesday 13 October 2026 · 17:00" })}
    <div class="k5-suggest k4-callout" data-callout="NEW · suggestion">
      <p>${who === "gps" ? "Add to ‘Tactical session 10:00’?" : "Add to ‘Speed & agility 17:30’?"}</p>
      <small>${who === "gps" ? "Same morning, 17 of its 18 athletes are in the event." : "Same afternoon, all 18 athletes are in the event."}</small>
      <div class="k4-row"><button class="plain-button cc-primary k4-btn">Add</button><button class="plain-button k4-btn">Leave</button></div>
    </div>
    <div class="k5-go">${who === "gps" ? goBtn("Open in Training Load", "load", false) : goBtn("Open in Tests", "tests", false)}</div></aside>`;
  const done = `<div class="k4-main" style="display:grid;gap:10px;max-width:640px">
    <p class="k4-ok">${icon("check")} Added. GPS session 10:05 is now in Tactical session 10:00.</p>
    <p class="k4-warn">${icon("alert")} This event already collects RPE from another request, so the RPE request can't be added. <button class="plain-button k4-btn">Leave it</button></p>
    <p class="k4-note">After <b>Leave</b> the question is not asked again for this item; the chip stays under its day.</p></div>`;
  return page("K5-3 · Add to the event?", [
    step("1 · A lone GPS activity on a day with a training in the same half of the day", "a suggestion, never automatic: [Add] [Leave]"),
    shell("Central calendar", "Calendar", `${nav()}<div class="k4-cal">${weekColumns(data)}${weekList(data)}${panel("gps")}</div>`),
    step("2 · The same for a test schedule", ""),
    shell("Central calendar", "Calendar", `<div class="k5-panels" style="grid-template-columns:minmax(0,420px)">${panel("test")}</div>`),
    step("3 · Outcomes", "one sentence each; a refusal reads as the #643 sentences"),
    done,
  ].join("\n"));
}

// ============================================ 04 K5-4 to review ==========
function reviewPage() {
  const data = weekData();
  const imports = shell("Training Load · Imports", "Imports", `
    <div class="k4-row" style="margin-bottom:10px"><button class="plain-button k4-btn">${icon("chevL")} Back to calendar</button><span class="k5-mark" style="--k5-c:${C.gps}">${icon("gps", "")}Wednesday 14.10 · 2 sessions</span><button class="k4-link">Show all dates</button></div>
    <section style="display:grid;gap:8px;max-width:760px">
      <p class="k4-day-label"><b>Needs attention</b> · 2</p>
      ${[["GPS session 10:05", "17 athletes · 2 not linked"], ["GPS session 16:40", "6 athletes · ready to review"]].map(([t, m]) => `<article class="k4-acard" style="--k4-c:${C.gps}"><span class="k4-acard-bar"></span><div class="k4-acard-body"><p class="k4-acard-top"><span class="k4-tint">${icon("gps")}</span><span class="k4-when">Wed 14.10</span><span>GPEXE</span></p><p class="k4-acard-title">${t}</p><p class="k4-note">${m}</p><div class="k4-acard-actions"><button class="plain-button cc-primary k4-btn">Review</button></div></div></article>`).join("")}
    </section>`, "load");
  return page("K5-4 · GPS sessions to review", [
    step("1 · The day mark", "only for those who see Imports today; dashed amber = waiting for you"),
    shell("Central calendar", "Calendar", `${nav()}<div class="k4-cal" style="grid-template-columns:1fr">${weekColumns(data)}${weekList(data)}</div>`),
    step("2 · Its click opens Imports on that day", "filtered to the day, with Back to calendar and Show all dates"),
    imports,
  ].join("\n"));
}

// ============================================ 05 K5-5 open in calendar =====
function backPage() {
  const tests = shell("Tests", "Tests · week 12 – 18 Oct", `
    <div class="k4-nav"><span class="k4-period">12 – 18 Oct 2026</span><button class="plain-button k4-btn">${icon("chevL")}</button><button class="plain-button k4-btn">${icon("chevR")}</button><span class="k4-spacer"></span><button class="plain-button k4-btn k4-callout" data-callout="NEW">${icon("calendar")} Open in calendar</button></div>
    <div class="k4-day"><div class="k4-day-head"><span class="k4-day-name">Tuesday 13.10</span><span class="k4-spacer"></span><button class="k4-link">Open this day in calendar</button></div>
      <div class="k4-session"><div class="k4-session-top"><span class="k4-slot" style="background:#f3e7f4;color:${C.test}">08:30</span><span class="k4-session-name">CMJ test</span><span class="k4-session-time">7 of 18 results</span><span class="k4-spacer"></span><button class="plain-button cc-primary k4-btn">Enter results</button></div></div></div>`, "tests");
  const home = shell("Coach", "Home", `
    <section class="k4-day"><div class="k4-day-head"><span class="k4-day-name">Today · Monday 12.10</span><span class="k4-spacer"></span><button class="plain-button k4-btn k4-callout" data-callout="NEW">${icon("calendar")} Open in calendar</button></div>
      <div class="k4-session"><div class="k4-session-top"><span class="k4-tint" style="--k4-c:${C.training}">${icon("run")}</span><span class="k4-session-name">Team training</span><span class="k4-session-time">10:00 · North field</span><span class="k4-spacer"></span>${gpsMark(18)}</div></div>
      <div class="k4-session"><div class="k4-session-top"><span class="k4-tint" style="--k4-c:${C.rpe}">${icon("gauge")}</span><span class="k4-session-name">RPE · Gym</span><span class="k4-session-time">4 of 6 answered</span></div></div>
    </section>`, "home");
  return page("K5-5 · Open in calendar", [
    step("1 · Tests' week", "Open in calendar opens the same week; each day's link opens that day"),
    tests,
    step("2 · Coach Home's day", "Open in calendar opens today in the central calendar"),
    home,
  ].join("\n"));
}

// ============================================ 06 H3 the filter: "only this" =====
function filterPage() {
  const kinds = [["all", "All", null, 31], ["event", "Events", "calendar", 6], ["planned", "Planned training", "builder", 9], ["gps", "GPS imports", "gps", 5], ["activity", "Other activities", "load", 2], ["rpe", "RPE requests", "gauge", 4], ["test", "Scheduled tests", "tests", 3]];
  const quick = (on) => `<div class="k5-quick k4-callout" data-callout="NEW · Show only" role="radiogroup" aria-label="Show only">
    ${kinds.map(([k, label, ic, n]) => `<button type="button" role="radio" aria-checked="${k === on}" class="k5-q${k === on ? " is-on" : ""}${k === "gps" ? " k5-q-gps" : ""}">${ic ? icon(ic, "") : ""}${label}<span class="cc-chip-count">${n}</span></button>`).join("")}
  </div>`;
  const chip = (label, n, active, dot = "") => `<button type="button" class="cc-chip${active ? " is-active" : ""}" aria-pressed="${active}">${dot ? `<span class="cc-chip-dot" style="--cc-team-color:${dot}"></span>` : ""}<span class="cc-chip-label">${label}</span><span class="cc-chip-count">${n}</span></button>`;
  const more = `<details class="k5-more-filters"><summary class="plain-button k4-btn">More filters · groups and event types</summary>
    <div class="cc-chip-row"><span class="cc-chip-row-label">Groups</span>${chip("U19", 22, true, C.training)}${chip("U17", 9, true, C.match)}</div>
    <div class="cc-chip-row"><span class="cc-chip-row-label">Types</span>${chip("Training", 4, true)}${chip("Match", 1, true)}${chip("Travel", 1, true)}</div></details>`;
  const all = weekData();
  const gpsOnly = {
    12: { cards: [card({ when: "10:00", kind: "Training", title: "Team training", place: "North field", extra: gpsMark(18), count: "18" })], marks: [] },
    14: { cards: [], marks: [mark({ ic: "gps", text: "GPS 10:05", color: C.gps })], daymark: 2 },
    15: { cards: [], marks: [mark({ ic: "gps", text: "GPS 10:05", color: C.gps })] },
    17: { cards: [card({ when: "15:00", kind: "Match", title: "U19 vs Lakeside", place: "City stadium", color: C.match, ic: "trophy", count: "20", extra: gpsMark(16) })], marks: [] },
  };
  const status = (word) => `<p class="k5-filter-status" role="status">${icon("gps", "")} Showing only <b>${word}</b> · 5 this week <button class="k4-link">Show all</button></p>`;
  const testsOnly = { 13: { cards: [], marks: [mark({ ic: "tests", text: "CMJ test", color: C.test })] }, 16: { cards: [], marks: [mark({ ic: "tests", text: "Sprint 30 m", color: C.test })] }, 18: { cards: [], marks: [mark({ ic: "tests", text: "Yo-Yo IR1", color: C.test })] } };
  return page("H3 · Filter: only this", [
    step("1 · The filter, open", "one row, one choice: a tap shows only that kind; the old multi-choice chips stay under More filters"),
    shell("Central calendar", "Calendar", `${nav()}${quick("all")}${more}<div class="k4-cal" style="grid-template-columns:1fr">${weekColumns(all)}${weekList(all)}</div>`),
    step("2 · One tap on GPS imports", "only GPS: imported activities, events with a GPS mark, and what waits for review"),
    shell("Central calendar", "Calendar", `${nav()}${quick("gps")}${status("GPS imports")}<div class="k4-cal" style="grid-template-columns:1fr">${weekColumns(gpsOnly)}${weekList(gpsOnly)}</div>`),
    step("3 · Then one tap on Scheduled tests", "switches straight over; All (or Show all) brings everything back"),
    shell("Central calendar", "Calendar", `${nav()}${quick("test")}${status("Scheduled tests").replace("5 this week", "3 this week").replace(/<svg[\s\S]*?<\/svg>/, icon("tests", ""))}<div class="k4-cal" style="grid-template-columns:1fr">${weekColumns(testsOnly)}${weekList(testsOnly)}</div>`),
  ].join("\n"));
}

const pages = {
  "01-k5-1-go-there.html": goPage(),
  "02-k5-2-gps-and-marks.html": marksPage(),
  "03-k5-3-add-to-event.html": suggestPage(),
  "04-k5-4-gps-to-review.html": reviewPage(),
  "05-k5-5-open-in-calendar.html": backPage(),
  "06-h3-filter-only-this.html": filterPage(),
};
for (const [name, html] of Object.entries(pages)) writeFileSync(join(here, name), html.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n"));
console.log(Object.keys(pages).join("\n"));
