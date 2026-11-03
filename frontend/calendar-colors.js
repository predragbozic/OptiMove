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
// workspace's order ({ teamId, colorKey }), in two passes. First, a team keeps
// the colour its club chose, and a team without one keeps its colour of
// before K2b-1c - automatic colour N mod 8 at position N - when no team chose
// that colour and no earlier team kept it. Then each team that lost its
// colour takes the first automatic colour that is still free, or, when none
// is left and its own colour was chosen by another team, the first free one
// of the other four; otherwise it keeps its own colour and shares it, as more
// than eight teams did before. So with no choice made every team wears
// exactly the colour it wore before, and one team's choice moves only the
// team whose colour it took.
const resolved = new WeakMap();
const AUTO_KEYS = CALENDAR_COLOR_KEYS.slice(0, CALENDAR_AUTO_COLOR_COUNT);
const OTHER_KEYS = CALENDAR_COLOR_KEYS.slice(CALENDAR_AUTO_COLOR_COUNT);

export function calendarTeamColorIndexes(teams) {
  const list = Array.isArray(teams) ? teams : [];
  const cached = resolved.get(list);
  if (cached) return cached;
  const chosen = new Set(list.map((team) => team?.colorKey).filter(isCalendarColorKey));
  const taken = new Set();
  const keys = [];
  const displaced = [];
  list.forEach((team, position) => {
    if (isCalendarColorKey(team?.colorKey)) {
      keys[position] = team.colorKey;
      return;
    }
    const own = AUTO_KEYS[position % CALENDAR_AUTO_COLOR_COUNT];
    if (chosen.has(own) || taken.has(own)) {
      displaced.push(position);
      return;
    }
    taken.add(own);
    keys[position] = own;
  });
  const free = (key) => !chosen.has(key) && !taken.has(key);
  for (const position of displaced) {
    const own = AUTO_KEYS[position % CALENDAR_AUTO_COLOR_COUNT];
    const key = AUTO_KEYS.find(free) ?? (chosen.has(own) ? OTHER_KEYS.find(free) : undefined) ?? own;
    taken.add(key);
    keys[position] = key;
  }
  const out = new Map();
  list.forEach((team, position) => {
    if (team?.teamId !== undefined && !out.has(team.teamId)) out.set(team.teamId, calendarColorIndex(keys[position]));
  });
  resolved.set(list, out);
  return out;
}
