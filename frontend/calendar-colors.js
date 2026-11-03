// The closed palette of the central calendar (K2b-1, D38; plan
// docs/ai/central-calendar-k2b-plan.md section 2.5): the same twelve keys as
// backend/src/calendarColors.js and calendar.color_key_ok() in migration v51 -
// a test proves the lists agree. A key's place in this list is its colour
// token, --cc-team-<index> (frontend/styles.css): the first eight are the
// calendar's automatic team colours, in their order since K1b.
export const CALENDAR_COLOR_KEYS = Object.freeze([
  "teal", "rust", "indigo", "plum", "green", "amber", "rose", "sky", "slate", "olive", "coral", "violet",
]);
export const CALENDAR_AUTO_COLOR_COUNT = 8;
export const CALENDAR_COLOR_LABELS = Object.freeze({
  teal: "Teal", rust: "Rust", indigo: "Indigo", plum: "Plum", green: "Green", amber: "Amber", rose: "Rose", sky: "Sky",
  slate: "Slate", olive: "Olive", coral: "Coral", violet: "Violet",
});

export const isCalendarColorKey = (value) => typeof value === "string" && CALENDAR_COLOR_KEYS.includes(value);
export const calendarColorIndex = (key) => CALENDAR_COLOR_KEYS.indexOf(key);

// Each team's colour, as its palette index, for a list of teams in the
// workspace's order ({ teamId, colorKey }). A team keeps the colour its club
// chose. A team without one keeps its colour of before K2b-1c - automatic
// colour N mod 8 at position N - unless another team chose that colour or an
// earlier team without a choice already took it: then it takes the next
// automatic colour that is neither, and when none is left and its own colour
// was chosen by another team, the first of the other four that is neither.
// Otherwise it keeps its own colour and shares it, as more than eight teams
// did before. So with no choice made every team wears exactly the colour it
// wore before, and one team's choice never moves the colours of the others
// unless it takes theirs.
const resolved = new WeakMap();
const AUTO_KEYS = CALENDAR_COLOR_KEYS.slice(0, CALENDAR_AUTO_COLOR_COUNT);
const OTHER_KEYS = CALENDAR_COLOR_KEYS.slice(CALENDAR_AUTO_COLOR_COUNT);

export function calendarTeamColorIndexes(teams) {
  const list = Array.isArray(teams) ? teams : [];
  const cached = resolved.get(list);
  if (cached) return cached;
  const chosen = new Set(list.map((team) => team?.colorKey).filter(isCalendarColorKey));
  const taken = new Set();
  const free = (key) => !chosen.has(key) && !taken.has(key);
  const out = new Map();
  list.forEach((team, position) => {
    let key = team?.colorKey;
    if (!isCalendarColorKey(key)) {
      const own = position % CALENDAR_AUTO_COLOR_COUNT;
      key = [...AUTO_KEYS.slice(own), ...AUTO_KEYS.slice(0, own)].find(free)
        ?? (chosen.has(AUTO_KEYS[own]) ? OTHER_KEYS.find(free) : undefined)
        ?? AUTO_KEYS[own];
      taken.add(key);
    }
    if (team?.teamId !== undefined && !out.has(team.teamId)) out.set(team.teamId, calendarColorIndex(key));
  });
  resolved.set(list, out);
  return out;
}
