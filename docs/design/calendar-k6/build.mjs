// Builds the static K6 design mockups of docs/design/calendar-k6/ (README.md).
// Run: node docs/design/calendar-k6/build.mjs
// Not app code: plain HTML on the app's real stylesheet plus base-k5.css and k6.css. Invented data only.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
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
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chevL: '<path d="M15 6l-6 6 6 6"/>',
  chevR: '<path d="M9 6l6 6-6 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
const icon = (n) => `<svg class="k4-icon" viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`;
const C = { training: "#1f6f68", match: "#b5542b", test: "#8a4c8f", rpe: "#b07a0a", gps: "#2c5aa0" };
const TEAMS = [
  { id: "u19", name: "U19", color: "#1f6f68", n: 18 },
  { id: "first", name: "First team", color: "#b5542b", n: 24 },
  { id: "u17", name: "U17", color: "#4a5fc1", n: 20 },
];
const ATH = {
  u19: ["Ana Kovač", "Ben Dorić", "Iva Perić", "Leo Radić", "Mia Savić", "Noah Tomić", "Ema Vuković", "Kai Babić", "Sara Lukić", "Tom Horvat"],
  first: ["Ante Marić", "Dino Kos", "Filip Jurić", "Marko Petrić", "Marta Novak", "Luka Šimić", "Nina Mlinar", "Pavle Rajić"],
  u17: ["Ada Marković", "Bruno Lalić", "Cvita Ilić", "David Mance", "Ena Hrgović", "Fran Pavić"],
};

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<!-- A STATIC DESIGN MOCKUP, not the app. Invented data only. See README.md. -->
<link rel="stylesheet" href="../../../frontend/styles.css">
<link rel="stylesheet" href="./base-k5.css">
<link rel="stylesheet" href="./k6.css">
</head>
<body class="k4-doc">
${body}
<script>/* Mockup only: every scroll row keeps its chosen item in view, as the app should. */
document.querySelectorAll(".k6-scrollrow").forEach((row) => { const on = row.querySelector(".is-active"); if (on) row.scrollLeft = on.offsetLeft - row.offsetLeft - (row.clientWidth - on.offsetWidth) / 2; });</script>
</body>
</html>
`;
}
const step = (label, note = "") => `<p class="k4-step">${label}${note ? `<small>${note}</small>` : ""}</p>`;
function shell(eyebrow, h1, inner, active = "calendar") {
  const rail = ["home", "calendar", "athletes", "builder", "tests", "load"].map((k) => `<span class="${k === active ? "on" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true">${P[k]}</svg></span>`).join("");
  return `<div class="k4-shell"><nav class="k4-rail" aria-label="Main">${rail}</nav>
  <main class="k4-main central-calendar"><header class="k4-topbar"><span class="k4-menu">${icon("menu")}</span><div><p class="eyebrow">${eyebrow}</p><h1>${h1}</h1></div></header>
  ${inner}</main></div>`;
}
const nav = () => `<div class="k4-nav"><span class="k4-period">12 – 18 Oct 2026</span><button class="plain-button k4-btn" aria-label="Previous week">${icon("chevL")}</button><button class="plain-button k4-btn">Today</button><button class="plain-button k4-btn" aria-label="Next week">${icon("chevR")}</button><span class="k4-spacer"></span><button class="plain-button cc-primary k4-btn">New event</button></div>`;
const initials = (name) => name.split(" ").map((p) => p[0]).join("").slice(0, 2);
const caption = (name) => { const p = name.split(" "); return `${p[0]} ${p.at(-1)[0]}.`; };
const team = (id) => TEAMS.find((t) => t.id === id);

// ------------------------------------------------- the shared switcher ----
function groupsRow(active, { counts = true } = {}) {
  const chip = (label, n, on, color) => `<button type="button" class="cc-chip${on ? " is-active" : ""}" aria-pressed="${on}"${color ? ` style="--cc-team-color:${color}"` : ""}>${color ? '<span class="cc-chip-dot" aria-hidden="true"></span>' : ""}<span class="cc-chip-label">${label}</span>${counts ? `<span class="cc-chip-count">${n}</span>` : ""}</button>`;
  return `<div class="cc-chip-row k6-scrollrow" role="group" aria-label="Groups"><span class="cc-chip-row-label">Groups</span>${chip("All groups", 62, active === "all")}${TEAMS.map((t) => chip(t.name, t.n, active === t.id, t.color)).join("")}</div>`;
}
function pill(name, teamId, on = false) {
  const t = team(teamId);
  return `<button class="builder-batch-pill${on ? " is-active" : ""}" type="button" aria-pressed="${on}" aria-label="${name}, ${t.name}" style="--k6-c:${t.color}"><span class="builder-batch-avatar"><span>${initials(name)}</span><i class="k6-teamdot" aria-hidden="true"></i></span><span class="builder-batch-caption">${caption(name)}</span></button>`;
}
const allPill = (on) => `<button class="builder-batch-pill k6-all${on ? " is-active" : ""}" type="button" aria-pressed="${on}"><span class="builder-batch-avatar"><span>All</span></span><span class="builder-batch-caption">Everyone</span></button>`;
function strip({ teamId = "u19", chosen = null, mixed = false }) {
  let pills;
  if (mixed) {
    pills = TEAMS.map((t) => `<span class="k6-divider" style="--k6-c:${t.color}">${t.name}</span>${ATH[t.id].map((a) => pill(a, t.id, a === chosen)).join("")}`).join("");
  } else {
    pills = ATH[teamId].map((a) => pill(a, teamId, a === chosen)).join("");
  }
  const list = mixed ? TEAMS.flatMap((t) => ATH[t.id]) : ATH[teamId];
  const total = mixed ? 62 : team(teamId).n;
  const pos = chosen ? `${list.indexOf(chosen) + 1} / ${total}` : `All · ${total}`;
  return `<p class="k6-label">Athletes <b>${chosen || (mixed ? "Everyone in the club" : `Everyone in ${team(teamId).name}`)}</b><span>${pos}</span></p>
  <div class="k6-row"><button class="plain-button icon-button" type="button" aria-label="Previous athlete">‹</button>
    <div class="builder-batch-pills k6-scrollrow">${allPill(!chosen)}${pills}</div>
    <button class="plain-button icon-button" type="button" aria-label="Next athlete">›</button></div>`;
}
const search = (value = "", results = "") => `<div><label class="k6-search">${icon("search")}<input type="search" value="${value}" placeholder="Find an athlete" aria-label="Find an athlete"></label>${results}</div>`;
function switcher({ groups = "u19", teamId = "u19", chosen = null, mixed = false, showGroups = true, searchValue = "", results = "", hidden = "" }) {
  return `<section class="k6-switch k4-callout" data-callout="NEW · athlete strip" aria-label="Team and athlete">
    ${showGroups ? groupsRow(groups) : ""}
    ${search(searchValue, results)}
    ${strip({ teamId, chosen, mixed })}
    ${hidden ? `<p class="k6-note">${hidden}</p>` : ""}
  </section>`;
}

// ---------------------------------------------------------------- the week ----
const DAYS = [["Mon", 12], ["Tue", 13], ["Wed", 14], ["Thu", 15], ["Fri", 16], ["Sat", 17], ["Sun", 18]];
function card({ when, kind, title, place = "", color = C.training, ic = "run", extra = "", count = "", teamName = "U19" }) {
  return `<button type="button" class="cc-card cc-card-event" style="--cc-team-color:${color}"><span class="cc-card-stripe" aria-hidden="true"></span><span class="cc-card-body">
    <span class="cc-card-top"><span class="k4-tint" style="--k4-c:${color}">${icon(ic)}</span><span class="cc-card-when">${when}</span><span class="cc-card-kind">${kind}</span></span>
    <span class="cc-card-title">${title}</span>${place ? `<span class="cc-card-place">${place}</span>` : ""}
    <span class="cc-card-meta"><span class="cc-team-pill"><span class="cc-team-dot" style="background:${color}"></span><span class="cc-team-pill-name">${teamName}</span></span>${extra}${count ? `<span class="cc-card-count">${count}</span>` : ""}</span></span></button>`;
}
const gpsMark = (n) => `<span class="k5-gps"><svg viewBox="0 0 24 24" aria-hidden="true">${P.gps}</svg> GPS · ${n}</span>`;
const chip = (ic, text, color) => `<button type="button" class="k5-mark" style="--k5-c:${color}"><svg viewBox="0 0 24 24" aria-hidden="true">${P[ic]}</svg>${text}</button>`;
function week(data) {
  const cols = `<div class="cc-week">${DAYS.map(([d, n]) => { const it = data[n] || [];
    return `<div class="cc-day-column${n === 12 ? " is-today" : ""}"><button type="button" class="cc-day-head"><span class="cc-day-name">${d}</span><span class="cc-day-number">${n}</span>${it.length ? `<span class="cc-day-count">${it.length}</span>` : ""}</button><div class="cc-day-cards">${it.join("")}</div></div>`; }).join("")}</div>`;
  const list = `<div class="k4-cal-list">${DAYS.filter(([, n]) => (data[n] || []).length).map(([d, n]) => `<div><p class="k4-day-label"><b>${d} ${n}.10</b>${n === 12 ? " · today" : ""}</p><div class="cc-day-cards">${data[n].join("")}</div></div>`).join("")}</div>`;
  return `<div class="k4-cal" style="grid-template-columns:1fr">${cols}${list}</div>`;
}
const teamWeek = {
  12: [card({ when: "10:00", kind: "Training", title: "Team training", place: "North field", extra: gpsMark(18), count: "18" }), `<div class="k5-marks">${chip("gauge", "RPE · Gym", C.rpe)}</div>`],
  13: [card({ when: "17:30", kind: "Training", title: "Speed & agility", place: "Indoor hall", count: "18" }), `<div class="k5-marks">${chip("tests", "CMJ test", C.test)}</div>`],
  15: [card({ when: "10:00", kind: "Training", title: "Tactical session", place: "North field", count: "18" }), `<div class="k5-marks">${chip("gps", "GPS 10:05", C.gps)}</div>`],
  17: [card({ when: "15:00", kind: "Match", title: "U19 vs Lakeside", place: "City stadium", color: C.match, ic: "trophy", count: "20", extra: gpsMark(16) })],
};
const anaWeek = {
  12: [card({ when: "10:00", kind: "Training", title: "Team training", place: "North field", extra: gpsMark(1) }), `<div class="k5-marks">${chip("gauge", "RPE · 7", C.rpe)}</div>`],
  13: [card({ when: "17:30", kind: "Training", title: "Speed & agility", place: "Indoor hall" }), `<div class="k5-marks">${chip("tests", "CMJ · 41 cm", C.test)}</div>`],
  15: [card({ when: "10:00", kind: "Training", title: "Tactical session", place: "North field" })],
  16: [`<div class="k5-marks">${chip("builder", "Gym · upper body", "#3b7f9c")}</div>`],
  17: [card({ when: "15:00", kind: "Match", title: "U19 vs Lakeside", place: "City stadium", color: C.match, ic: "trophy", extra: gpsMark(1) })],
};
const anaGps = {
  12: [card({ when: "10:00", kind: "Training", title: "Team training", place: "North field", extra: gpsMark(1) })],
  17: [card({ when: "15:00", kind: "Match", title: "U19 vs Lakeside", place: "City stadium", color: C.match, ic: "trophy", extra: gpsMark(1) })],
};
const markoWeek = {
  12: [card({ when: "09:00", kind: "Training", title: "First team training", place: "Main pitch", color: "#b5542b", teamName: "First team", extra: gpsMark(1) })],
  14: [card({ when: "09:00", kind: "Training", title: "Recovery & video", place: "Club house", color: "#b5542b", teamName: "First team" })],
  16: [card({ when: "11:00", kind: "Training", title: "Set pieces", place: "Main pitch", color: "#b5542b", teamName: "First team" }), `<div class="k5-marks">${chip("gauge", "RPE · 6", C.rpe)}</div>`],
  18: [card({ when: "16:00", kind: "Match", title: "First team vs Harbor FC", place: "City stadium", color: C.match, ic: "trophy", teamName: "First team", extra: gpsMark(1) })],
};
const chosenLine = (name, team, extra = "") => `<p class="k6-chosen" role="status">Showing <b>${name}</b> · ${team}${extra} <button class="k4-link">Show everyone</button></p>`;
const quick = (on) => `<div class="k5-quick" role="radiogroup" aria-label="Show only">${[["all", "All", null], ["event", "Events", "calendar"], ["gps", "GPS imports", "gps"], ["rpe", "RPE requests", "gauge"], ["test", "Scheduled tests", "tests"]].map(([k, l, ic]) => `<button type="button" role="radio" aria-checked="${k === on}" class="k5-q${k === on ? " is-on" : ""}${k === "gps" ? " k5-q-gps" : ""}">${ic ? `<svg viewBox="0 0 24 24" aria-hidden="true">${P[ic]}</svg>` : ""}${l}</button>`).join("")}</div>`;

// ================================================ 01 K6-1 the calendar =====
function calendarPage() {
  return page("K6-1 · The calendar by athlete", [
    step("1 · A club workspace: the Groups choice next to the athlete strip", "S3: the existing Groups chips, not a second team control; U19 chosen, the strip starts with All"),
    shell("Central calendar", "Calendar", `${nav()}${switcher({ groups: "u19", teamId: "u19" })}${week(teamWeek)}`),
    step("2 · One athlete chosen", "the week shows only Ana K.; ‹ › moves to the next athlete; the chosen pill stays in view"),
    shell("Central calendar", "Calendar", `${nav()}${switcher({ groups: "u19", teamId: "u19", chosen: "Ana Kovač" })}${chosenLine("Ana Kovač", "U19")}${week(anaWeek)}`),
    step("3 · With K5's Show only", "only GPS, for one athlete"),
    shell("Central calendar", "Calendar", `${nav()}${switcher({ groups: "u19", teamId: "u19", chosen: "Ana Kovač" })}${quick("gps")}${chosenLine("Ana Kovač", "U19", " · only GPS imports")}${week(anaGps)}`),
  ].join("\n"));
}

// ======================================== 02 K6-1 a team coach (no Groups) ===
function coachPage() {
  const none = `<p class="k6-note" role="status" style="margin-top:6px">No athlete in this team matches ‘marko’.</p>`;
  return page("K6-1 · A team coach (S5: only their own team)", [
    step("1 · A team coach's calendar", "the same strip, arrows and search, only the U19 team (the active team workspace); no Groups row and no All teams"),
    shell("Central calendar · U19", "Calendar", `${nav()}${switcher({ showGroups: false, teamId: "u19", chosen: "Leo Radić", hidden: "2 athletes of this team are not shown here: they are in another club's workspace." })}${chosenLine("Leo Radić", "U19")}${week(anaWeek)}`),
    step("2 · The search finds no one outside the team", "a short, calm sentence; nothing about other teams"),
    shell("Central calendar · U19", "Calendar", `${nav()}${switcher({ showGroups: false, teamId: "u19", searchValue: "marko", results: none })}`),
  ].join("\n"));
}

// =============================================== 03 S4 the club admin =======
function adminPage() {
  const hit = (name, teamId, q, hl = false) => { const t = team(teamId); const i = name.toLowerCase().indexOf(q);
    const shown = i < 0 ? name : `${name.slice(0, i)}<mark>${name.slice(i, i + q.length)}</mark>${name.slice(i + q.length)}`;
    return `<li class="${hl ? "is-hl" : ""}" style="--k6-c:${t.color}" role="option"><span class="builder-batch-avatar"><span>${initials(name)}</span></span><span>${shown}</span><small><i></i>${t.name}</small></li>`; };
  const results = `<ul class="k6-results" role="listbox" aria-label="Athletes found">${hit("Marko Petrić", "first", "mar", true)}${hit("Marta Novak", "first", "mar")}${hit("Ante Marić", "first", "mar")}${hit("Ada Marković", "u17", "mar")}</ul><p class="k6-note">4 of 62 athletes · across all teams · ↑ ↓ and Enter work too</p>`;
  return page("S4 · A club admin: every team and every athlete", [
    step("1 · All groups: every athlete of the club", "ordered by team, then by name; a team label between teams and each pill carrying its team's colour"),
    shell("Central calendar · Riverside FC", "Calendar", `${nav()}${switcher({ groups: "all", mixed: true })}${week(teamWeek)}`),
    step("2 · The search is the main way in for a big club", "\"mar\" finds athletes in any team, with the team's name and colour"),
    shell("Central calendar · Riverside FC", "Calendar", `${nav()}${switcher({ groups: "all", mixed: true, searchValue: "mar", results })}`),
    step("3 · Marko P. chosen (First team)", "his team is set in Groups, the strip becomes First team with Marko in view, and the week is his"),
    shell("Central calendar · Riverside FC", "Calendar", `${nav()}${switcher({ groups: "first", teamId: "first", chosen: "Marko Petrić" })}${chosenLine("Marko Petrić", "First team")}${week(markoWeek)}`),
  ].join("\n"));
}

// =============================================== 04 K6-2 the Weekly plan ====
function planHeader(name, idx, teamId = "u19", list = ATH[teamId]) {
  const t = team(teamId);
  return `<section class="k6-switch k4-callout" data-callout="NEW · header" aria-label="Athlete">
    <div class="k6-head"><button class="plain-button icon-button" aria-label="Previous athlete">‹</button>
      <div class="k6-head-name" style="--k6-c:${t.color}"><span class="builder-batch-avatar" style="border-color:${t.color}"><span>${initials(name)}</span></span><strong>${name}</strong><small>${t.name} · ${idx} / ${t.n}</small></div>
      <button class="plain-button icon-button" aria-label="Next athlete">›</button></div>
    <div class="k6-row"><span></span><div class="builder-batch-pills k6-scrollrow">${list.map((a) => pill(a, teamId, a === name)).join("")}</div><span></span></div>
  </section>`;
}
function planBody(name, notes) {
  return `<p class="k6-crumb">Week 12 – 18 Oct · <b>Monday 12.10</b> · <b>Training</b> · <b>Main session</b> <span class="k4-muted">(kept when you change athlete)</span></p>
  <div class="k4-day" style="--k4-c:${C.training}"><div class="k4-day-head"><span class="k4-day-name">Monday 12.10</span><span class="k4-muted" style="font-size:14px">Team training · 10:00 · North field</span></div>
    <div class="k4-session"><div class="k4-session-top"><span class="k4-slot">Before training</span><span class="k4-session-name">Mobility & activation</span></div></div>
    <div class="k4-session" style="box-shadow:inset 0 0 0 2px var(--accent)"><div class="k4-session-top"><span class="k4-slot">Training</span><span class="k4-session-name">Main session</span><span class="k4-session-time">10:30</span></div><div class="k4-session-body">${notes}</div></div>
  </div>`;
}
function planPage() {
  return page("K6-2 · The Weekly plan by athlete", [
    step("1 · Ana K. — Monday · Training · Main session open", "the header: ‹ name ›, her team and 1 / 18; the strip under it"),
    shell("Weekly plan", "Weekly plan", `${planHeader("Ana Kovač", 1)}${planBody("Ana Kovač", "Rondo 5v2 · Small-sided games 4×4 · Finishing · <b>Ana: max 60 min (knee)</b>")}`, "builder"),
    step("2 · › once: Ben D. — the same week, day and open session", "nothing else moves; only the athlete's own content changes"),
    shell("Weekly plan", "Weekly plan", `${planHeader("Ben Dorić", 2)}${planBody("Ben Dorić", "Rondo 5v2 · Small-sided games 4×4 · Finishing · <b>Ben: +2 sprints 30 m</b>")}`, "builder"),
  ].join("\n"));
}

// ===================================== 05 K6-3 from an event, each athlete ===
function eventPage() {
  const eventList = ["Ana Kovač", "Ben Dorić", "Iva Perić", "Leo Radić", "Mia Savić"];
  const panel = `<aside class="cc-panel" style="max-width:440px">
    <header class="cc-panel-head"><h3 class="cc-panel-title">Team training</h3><button class="plain-button icon-button cc-panel-close" aria-label="Close">×</button></header>
    <p class="cc-panel-kind"><span class="k4-tint" style="--k4-c:${C.training}">${icon("run")}</span> <span>Training</span></p>
    <p class="cc-panel-when">Monday 12 October 2026 · 10:00–11:30</p>
    <p class="cc-panel-note k4-row">${icon("pin")} North field · 5 athletes</p>
    <h5 class="cc-link-heading" style="margin:0">In this event</h5><p class="cc-panel-note">Training · Main session · 5 athletes</p>
    <div class="k5-go k4-callout" data-callout="NEW"><button class="plain-button cc-primary k4-btn">${icon("athletes")} See each athlete ${icon("arrow")}</button><p class="k4-note">Opens Main session, one athlete at a time, only the 5 of this event.</p></div>
  </aside>`;
  const header = `<div class="k4-backbar"><button class="plain-button k4-btn">${icon("back")} Back to calendar</button><span class="k4-muted" style="font-size:14px">Team training · Mon 12.10 · only this event's 5 athletes</span></div>
  <section class="k6-switch k4-callout" data-callout="event's athletes only"><div class="k6-head"><button class="plain-button icon-button" aria-label="Previous athlete">‹</button>
    <div class="k6-head-name"><span class="builder-batch-avatar" style="border-color:${C.training}"><span>IP</span></span><strong>Iva Perić</strong><small>3 / 5 in this event</small></div>
    <button class="plain-button icon-button" aria-label="Next athlete">›</button></div>
    <div class="k6-row"><span></span><div class="builder-batch-pills k6-scrollrow">${eventList.map((a) => pill(a, "u19", a === "Iva Perić")).join("")}</div><span></span></div></section>`;
  return page("K6-3 · From an event through its athletes", [
    step("1 · The event's panel", "See each athlete is the one primary action here"),
    shell("Central calendar", "Calendar", panel),
    step("2 · The Weekly plan on that session, only the event's athletes", "Back (button or the phone's) returns to the event's panel"),
    shell("Weekly plan", "Weekly plan", `${header}${planBody("Iva Perić", "Rondo 5v2 · Small-sided games 4×4 · Finishing")}`, "builder"),
  ].join("\n"));
}

const pages = {
  "01-k6-1-calendar-by-athlete.html": calendarPage(),
  "02-k6-1-team-coach.html": coachPage(),
  "03-s4-club-admin-search.html": adminPage(),
  "04-k6-2-weekly-plan-header.html": planPage(),
  "05-k6-3-event-each-athlete.html": eventPage(),
};
for (const [name, html] of Object.entries(pages)) writeFileSync(join(here, name), html.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n"));
console.log(Object.keys(pages).join("\n"));
