export function localDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Local calendar date in a SPECIFIC IANA timezone (e.g. a schedule's own
// chosen timezone) - unlike localDateIso() above (the machine/browser's OWN
// local date), this is what a "today"/"past date" check must use once a
// timezone has actually been chosen, so a coach in one timezone scheduling
// for a schedule in another never sees the wrong calendar day near
// midnight. Built from Intl.DateTimeFormat's own timezone-aware components,
// never `date.toISOString()` (always UTC, regardless of `timeZone`).
export function localDateIsoInTimeZone(timeZone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const map = {};
    for (const part of parts) map[part.type] = part.value;
    if (map.year && map.month && map.day) return `${map.year}-${map.month}-${map.day}`;
  } catch {
    // Invalid/unsupported timeZone string - fall through to the browser's
    // own local date rather than throwing mid-render.
  }
  return localDateIso(date);
}

export function localMonthIsoInTimeZone(timeZone, date = new Date()) {
  return localDateIsoInTimeZone(timeZone, date).slice(0, 7);
}

export function weekMondayIso(value) {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return localDateIso();
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDateIso(date);
}

export function weekDayName(value) {
  const date = new Date(`${String(value || "").slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "Day";
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
}

export function monthStartIso(value) {
  return `${String(value).slice(0, 7)}-01`;
}

export function addMonthsIso(value, amount) {
  const date = new Date(`${value}T12:00:00`);
  date.setMonth(date.getMonth() + amount, 1);
  return localDateIso(date);
}

export function addDaysIso(value, amount) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return localDateIso(date);
}

export function startOfWeekIso(value) {
  const date = new Date(`${value}T12:00:00`);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return localDateIso(date);
}

export function endOfWeekIso(value) {
  return addDaysIso(startOfWeekIso(value), 6);
}

export function monthLabel(value) {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

export function dateValue(value) {
  if (!value) return 0;
  return new Date(`${value}T12:00:00`).getTime();
}

export function countLabel(items) {
  const count = (items || []).length;
  return `${count} ${count === 1 ? "item" : "items"}`;
}

export function orderedUnique(items, field) {
  const seen = new Set();
  const names = [];
  items.forEach((item) => {
    const name = clean(item[field]);
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  return names;
}

export function groupBy(items, labelFn) {
  const map = new Map();
  items.forEach((item) => {
    const label = labelFn(item);
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(item);
  });
  return Array.from(map, ([label, groupItemsValue]) => ({ label, items: groupItemsValue }));
}

export function clean(value) {
  return String(value || "").trim();
}

export function truncate(value, maxLength) {
  const text = clean(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

export function initialsFor(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function programInitials(name = "") {
  const words = clean(name).split(/\s+/).filter(Boolean);
  if (!words.length) return "PL";
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

export function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return day && month && year ? `${day}.${month}.${year}` : String(value);
}

export function formatWeekday(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(new Date(`${String(value).slice(0, 10)}T12:00:00`));
}

export function formatDayMonth(value) {
  if (!value) return "";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return day && month && year ? `${day}.${month}` : String(value);
}

export function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

export function renderOption(value, label, selectedValue) {
  return `<option value="${escapeAttr(value)}" ${String(selectedValue || "") === String(value) ? "selected" : ""}>${escapeHtml(label)}</option>`;
}
