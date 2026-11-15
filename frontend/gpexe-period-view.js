// P4: the period chooser that "Find new sessions" opens (gpexe-period-data.js holds its state). Pure template strings.
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";
import { inboxBucket, isHiddenVersion } from "./gpexe-import-data.js";
import { dayOff, daysInPeriod, localDay, missingWindow, periodMonth, periodOf, periodRange, PERIOD_MAX_DAYS, sessionDay, todayDay } from "./gpexe-period-data.js";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// One state per session: colour, glyph and word (never colour alone). "Stays out" gets no mark.
const CHIP = {
  attention: { cls: "needs", glyph: "!", word: "needs you" },
  ready: { cls: "ready", glyph: "→", word: "ready" },
  imported: { cls: "done", glyph: "✓", word: "imported" },
};
const CHIPS_SHOWN = 3;

const short = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}.`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "12.11. - 14.11." / "12.11."; the year only when the period leaves this year.
export function periodText(from, to, now = new Date()) {
  const year = String(now.getFullYear());
  const fmt = (d) => (d.startsWith(year) ? short(d) : formatDate(d));
  return from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
}

// The sessions found so far, by the day the server searches them under (sessionDay), in start-time order, each with its state (null for "stays out").
function sessionsByDay(gx) {
  const byDay = new Map();
  const list = (gx.candidates || []).filter((c) => !isHiddenVersion(c, gx)).slice().sort((a, b) => String(a.sessionStartedAt).localeCompare(String(b.sessionStartedAt)));
  for (const c of list) {
    const day = sessionDay(c.sessionStartedAt);
    if (!day) continue;
    const bucket = inboxBucket(c, gx);
    if (bucket === "hidden") continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ c, chip: CHIP[bucket] || null });
  }
  return byDay;
}

function chipsHtml(items) {
  const marked = items.filter((x) => x.chip);
  if (!marked.length) return "";
  const shown = marked.slice(0, CHIPS_SHOWN).map((x) => `<i class="period-chip is-${x.chip.cls}">${x.chip.glyph}</i>`).join("");
  const more = marked.length > CHIPS_SHOWN ? `<i class="period-chip is-more">+${marked.length - CHIPS_SHOWN}</i>` : "";
  return `<span class="period-chips" aria-hidden="true">${shown}${more}</span>`;
}

function dayLabel(day, items, flags) {
  const [y, m, d] = day.split("-").map(Number);
  const name = `${d} ${MONTH_NAMES[m - 1]}${y !== new Date().getFullYear() ? ` ${y}` : ""}`;
  const found = items.length ? `${plural(items.length, "session", "sessions")}: ${items.map((x) => (x.chip ? x.chip.word : "stays out")).join(", ")}` : "nothing found yet";
  return [name, found, ...flags].join(", ");
}

function gridHtml(gx, byDay, now, range, suggestedTo) {
  const month = periodMonth(gx, now, suggestedTo);
  const [y, m] = month.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const today = localDay(now);
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(`<span class="period-day is-blank" aria-hidden="true"></span>`);
  for (let d = 1; d <= days; d += 1) {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    const items = byDay.get(day) || [];
    const off = dayOff(day, gx, now);
    const inRange = Boolean(range && day >= range.from && day <= range.to);
    const edge = Boolean(range && (day === range.from || day === range.to));
    const flags = [day === today ? "today" : "", inRange ? "chosen" : "", off ? (day > todayDay(now) ? "in the future" : `more than ${PERIOD_MAX_DAYS} days from the first day`) : ""].filter(Boolean);
    const cls = ["period-day", day === today ? "is-today" : "", inRange ? "is-in" : "", edge ? "is-edge" : "", off ? "is-off" : "", items.some((x) => x.chip) ? "is-found" : ""].filter(Boolean).join(" ");
    cells.push(`<button type="button" class="${cls}" data-action="training-load-gpexe-period-day" data-day="${day}" aria-label="${escapeAttr(dayLabel(day, items, flags))}" aria-pressed="${inRange ? "true" : "false"}"${off ? ' aria-disabled="true"' : ""}><span class="period-num">${d}</span>${chipsHtml(items)}</button>`);
  }
  return `
    <div class="period-nav">
      <button type="button" class="plain-button gpexe-button period-turn" data-action="training-load-gpexe-period-month" data-delta="-1" aria-label="Previous month">&lsaquo;</button>
      <strong class="period-month" aria-live="polite">${escapeHtml(`${MONTH_NAMES[m - 1]} ${y}`)}</strong>
      <button type="button" class="plain-button gpexe-button period-turn" data-action="training-load-gpexe-period-month" data-delta="1" aria-label="Next month">&rsaquo;</button>
    </div>
    <div class="period-grid" role="group" aria-label="${escapeAttr(`Days of ${MONTH_NAMES[m - 1]} ${y}. Tap the first and the last day to search.`)}">
      ${WEEKDAYS.map((w) => `<span class="period-weekday" aria-hidden="true">${w}</span>`).join("")}
      ${cells.join("")}
    </div>
  `;
}

// UX review (MEDIUM): the sessions of the chosen (or suggested) days, grouped by date, each opening its review; at most
// SESSIONS_LISTED, then how many more. Nothing while no day is chosen.
const SESSIONS_LISTED = 8;
function rangeListHtml(range, byDay, nameOf, timeOf) {
  if (!range) return "";
  const days = [...byDay.keys()].filter((d) => d >= range.from && d <= range.to).sort();
  const all = days.flatMap((d) => byDay.get(d).map((x) => ({ ...x, day: d })));
  if (!all.length) return "";
  const shown = all.slice(0, SESSIONS_LISTED);
  const groups = [];
  for (const x of shown) {
    if (!groups.length || groups[groups.length - 1].day !== x.day) groups.push({ day: x.day, items: [] });
    groups[groups.length - 1].items.push(x);
  }
  return `
    <div class="period-daylist" role="group" aria-label="Sessions already found on these days">
      <p class="period-daylist-title">Already found on these days</p>
      ${groups.map((grp) => `
        <p class="period-daylist-date">${escapeHtml(formatDate(grp.day))}</p>
        <ul>
          ${grp.items.map(({ c, chip }) => `<li><button type="button" class="plain-button gpexe-button period-daylist-open" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(c.id)}"><span>${escapeHtml(`${nameOf(c)} · ${timeOf(c.sessionStartedAt)}`)}</span>${chip ? `<span class="period-chip is-${chip.cls}" aria-hidden="true">${chip.glyph}</span><span class="period-daylist-state">${escapeHtml(chip.word)}</span>` : `<span class="period-daylist-state muted">stays out</span>`}</button></li>`).join("")}
        </ul>`).join("")}
      ${all.length > shown.length ? `<p class="muted period-daylist-more">${escapeHtml(`${plural(all.length - shown.length, "more session", "more sessions")} in the tabs below.`)}</p>` : ""}
    </div>
  `;
}

// "Search from 08.11. to today": what the first button covers, in plain words (UX review: "missing" alone is jargon).
function missingText(missing, now) {
  if (missing.from === missing.to) return "Search today";
  return `Search from ${periodText(missing.from, missing.from, now)} to today`;
}

// The period chooser. On a computer it is always on the page under the banner; on a phone "Find new sessions" opens it
// as a full-screen sheet (CSS: .imports-period is hidden there unless .is-open). `running` turns every search button
// off (one search at a time). `suggested` is the days a session needs to be found again (datesNeededFor): shown as
// chosen until the person taps a day.
export function renderPeriodHtml(gx, status, { nameOf, timeOf, running = false, now = new Date(), suggested = null, quiet = false } = {}) {
  const s = periodOf(gx);
  const byDay = sessionsByDay(gx);
  const missing = missingWindow(status, now);
  const chosen = periodRange(gx);
  const suggestedRange = !chosen && suggested ? { from: suggested.from, to: suggested.to, days: daysInPeriod(suggested.from, suggested.to) } : null;
  const range = chosen || suggestedRange;
  const off = running ? "disabled" : "";
  // One main action inside the chooser: the chosen days' Search once days are chosen, otherwise the first button - unless
  // a group's own step leads the screen (`quiet`, code review: one main action per screen).
  const lead = range || quiet ? "plain-button" : "primary-button";
  const first = missing
    ? `<button type="button" class="${lead} gpexe-button period-missing" data-action="training-load-gpexe-check" data-from="${escapeAttr(missing.from)}" data-to="${escapeAttr(missing.to)}" ${off}>${escapeHtml(missingText(missing, now))}</button>${missing.clipped ? `<p class="muted period-hint">The latest ${PERIOD_MAX_DAYS} days; tap earlier days below to search them too.</p>` : ""}`
    : `<button type="button" class="${lead} gpexe-button period-missing" data-action="training-load-gpexe-check" ${off}>Search the last 14 days</button>`;
  const why = suggestedRange
    ? (suggested.clipped ? "The latest 31 days of the sessions that need finding again; search the earlier ones afterwards." : "These days hold the sessions that need finding again.")
    : "";
  const search = range ? `<button type="button" class="${quiet ? "plain-button" : "primary-button"} gpexe-button" data-action="training-load-gpexe-check" data-from="${escapeAttr(range.from)}" data-to="${escapeAttr(range.to)}" ${off}>${escapeHtml(`Search ${periodText(range.from, range.to, now)}`)}</button>` : "";
  return `
    <section class="gpexe-panel imports-period${s.open ? " is-open" : ""}" id="imports-period" ${s.open ? 'role="dialog" aria-modal="true" aria-labelledby="imports-period-title"' : 'aria-label="Find new sessions"'}>
      <div class="period-head">
        <h3 id="imports-period-title">Find new sessions</h3>
        <button type="button" class="plain-button gpexe-button period-close" data-action="training-load-gpexe-period-toggle" aria-label="Close">×</button>
      </div>
      <div class="period-first">${first}</div>
      <div class="period-cal">
        ${gridHtml(gx, byDay, now, range, suggestedRange?.to || "")}
        <ul class="period-legend" aria-hidden="true">
          <li><i class="period-chip is-needs">!</i> needs you</li>
          <li><i class="period-chip is-ready">→</i> ready</li>
          <li><i class="period-chip is-done">✓</i> imported</li>
        </ul>
      </div>
      <div class="period-side">
        ${s.anchor
          ? `<p class="period-wait" role="status">${escapeHtml(`Search ${periodText(s.anchor, s.anchor, now)}, or tap another day to make the period longer (at most ${PERIOD_MAX_DAYS} days).`)}</p>`
          : `<p class="muted period-note">Tap the first and the last day (at most ${PERIOD_MAX_DAYS} days)<span class="period-fine">, or drag across them</span>.</p>`}
        ${range ? `
          <div class="period-range" role="group" aria-label="Chosen days">
            ${why ? `<p class="period-range-note">${escapeHtml(why)}</p>` : ""}
            <span class="period-range-text">${escapeHtml(`${periodText(range.from, range.to, now)} · ${plural(range.days, "day", "days")}`)}</span>
            <span class="period-range-actions">${search}${chosen ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-period-clear">Clear</button>` : ""}</span>
          </div>` : ""}
        <p class="muted period-note">Days without a mark may not have been searched yet. Nothing is imported until you import it.</p>
        ${rangeListHtml(range, byDay, nameOf, timeOf)}
      </div>
    </section>
  `;
}
