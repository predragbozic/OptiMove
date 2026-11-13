// P4: the period chooser that "Find new sessions" opens (gpexe-period-data.js holds its state). Pure template strings.
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";
import { inboxBucket, isHiddenVersion } from "./gpexe-import-data.js";
import { dayOff, localDay, missingWindow, periodMonth, periodOf, periodRange, PERIOD_MAX_DAYS } from "./gpexe-period-data.js";

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

// The sessions found so far, by local day, in start-time order, each with its state (null for "stays out").
function sessionsByDay(gx) {
  const byDay = new Map();
  const list = (gx.candidates || []).filter((c) => !isHiddenVersion(c, gx)).slice().sort((a, b) => String(a.sessionStartedAt).localeCompare(String(b.sessionStartedAt)));
  for (const c of list) {
    const day = localDay(c.sessionStartedAt);
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
  const marked = items.filter((x) => x.chip);
  const found = marked.length ? `${plural(marked.length, "session", "sessions")}: ${marked.map((x) => x.chip.word).join(", ")}` : "nothing found yet";
  return [name, found, ...flags].join(", ");
}

function gridHtml(gx, byDay, now) {
  const month = periodMonth(gx, now);
  const [y, m] = month.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const today = localDay(now);
  const s = periodOf(gx);
  const range = periodRange(gx);
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(`<span class="period-day is-blank" aria-hidden="true"></span>`);
  for (let d = 1; d <= days; d += 1) {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    const items = byDay.get(day) || [];
    const off = dayOff(day, gx, now);
    const inRange = Boolean(range && day >= range.from && day <= range.to);
    const edge = Boolean(range && (day === range.from || day === range.to));
    const flags = [day === today ? "today" : "", inRange ? "chosen" : "", off ? (day > today ? "in the future" : `more than ${PERIOD_MAX_DAYS} days from the first day`) : ""].filter(Boolean);
    const cls = ["period-day", day === today ? "is-today" : "", inRange ? "is-in" : "", edge ? "is-edge" : "", off ? "is-off" : "", items.some((x) => x.chip) ? "is-found" : ""].filter(Boolean).join(" ");
    cells.push(`<button type="button" class="${cls}" data-action="training-load-gpexe-period-day" data-day="${day}" aria-label="${escapeAttr(dayLabel(day, items, flags))}" aria-pressed="${inRange ? "true" : "false"}"${off ? ' aria-disabled="true"' : ""}><span class="period-num">${d}</span>${chipsHtml(items)}</button>`);
  }
  return `
    <div class="period-nav">
      <button type="button" class="plain-button gpexe-button period-turn" data-action="training-load-gpexe-period-month" data-delta="-1" aria-label="Previous month">&lsaquo;</button>
      <strong class="period-month" aria-live="polite">${escapeHtml(`${MONTH_NAMES[m - 1]} ${y}`)}</strong>
      <button type="button" class="plain-button gpexe-button period-turn" data-action="training-load-gpexe-period-month" data-delta="1" aria-label="Next month">&rsaquo;</button>
    </div>
    <div class="period-grid" role="group" aria-label="${escapeAttr(`Days of ${MONTH_NAMES[m - 1]} ${y}. Tap the first and the last day to search, or drag across them.`)}">
      ${WEEKDAYS.map((w) => `<span class="period-weekday" aria-hidden="true">${w}</span>`).join("")}
      ${cells.join("")}
    </div>
    ${s.anchor ? `<p class="muted period-wait" role="status">Now tap the last day (at most ${PERIOD_MAX_DAYS} days).</p>` : ""}
  `;
}

// The sessions of the day tapped first, each opening its review.
function dayListHtml(gx, byDay, nameOf, timeOf) {
  const day = periodOf(gx).day;
  const items = (day && byDay.get(day)) || [];
  if (!items.length) return "";
  return `
    <div class="period-daylist" aria-label="${escapeAttr(`Sessions of ${formatDate(day)}`)}">
      <p class="period-daylist-title">${escapeHtml(formatDate(day))}</p>
      <ul>
        ${items.map(({ c, chip }) => `<li><button type="button" class="plain-button gpexe-button period-daylist-open" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(c.id)}"><span>${escapeHtml(`${nameOf(c)} · ${timeOf(c.sessionStartedAt)}`)}</span>${chip ? `<span class="period-chip is-${chip.cls}" aria-hidden="true">${chip.glyph}</span><span class="period-daylist-state">${escapeHtml(chip.word)}</span>` : `<span class="period-daylist-state muted">stays out</span>`}</button></li>`).join("")}
      </ul>
    </div>
  `;
}

// The panel under the banner. `running` turns every search button off (one search at a time).
export function renderPeriodHtml(gx, status, { nameOf, timeOf, running = false, now = new Date() } = {}) {
  if (!periodOf(gx).open) return "";
  const byDay = sessionsByDay(gx);
  const missing = missingWindow(status, now);
  const range = periodRange(gx);
  const off = running ? "disabled" : "";
  // One main action: the chosen days' Search once days are chosen, otherwise "Search what's missing".
  const lead = range ? "plain-button" : "primary-button";
  const first = missing
    ? `<button type="button" class="${lead} gpexe-button period-missing" data-action="training-load-gpexe-check" data-from="${escapeAttr(missing.from)}" data-to="${escapeAttr(missing.to)}" ${off}>${escapeHtml(`Search what's missing · ${periodText(missing.from, missing.to, now)}`)}</button>${missing.clipped ? `<p class="muted period-hint">The latest ${PERIOD_MAX_DAYS} days; pick earlier days below to search them too.</p>` : ""}`
    : `<button type="button" class="${lead} gpexe-button period-missing" data-action="training-load-gpexe-check" ${off}>Search the last 14 days</button>`;
  return `
    <section class="gpexe-panel imports-period" id="imports-period" aria-label="Find new sessions">
      <div class="period-first">${first}</div>
      ${gridHtml(gx, byDay, now)}
      <ul class="period-legend" aria-hidden="true">
        <li><i class="period-chip is-needs">!</i> needs you</li>
        <li><i class="period-chip is-ready">→</i> ready</li>
        <li><i class="period-chip is-done">✓</i> imported</li>
      </ul>
      <p class="muted period-note">Tap the first and the last day, or drag across them; at most ${PERIOD_MAX_DAYS} days. Days without a mark may not have been searched yet. Searching only reads GPEXE; nothing is imported until you import it.</p>
      ${range ? `
        <div class="period-range" role="group" aria-label="Chosen days">
          ${periodOf(gx).note ? `<p class="period-range-note">${escapeHtml(periodOf(gx).note)}</p>` : ""}
          <span class="period-range-text">${escapeHtml(`${periodText(range.from, range.to, now)} · ${plural(range.days, "day", "days")}`)}</span>
          <span class="period-range-actions">
            <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-period-clear">Clear</button>
            <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-check" data-from="${escapeAttr(range.from)}" data-to="${escapeAttr(range.to)}" ${off}>${escapeHtml(`Search ${periodText(range.from, range.to, now)}`)}</button>
          </span>
        </div>` : ""}
      ${dayListHtml(gx, byDay, nameOf, timeOf)}
    </section>
  `;
}
