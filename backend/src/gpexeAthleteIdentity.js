// The GPEXE athlete identity rules (owner decisions 2026-10-06,
// docs/ai/gpexe-rest-v1-compatibility.md section 4b): from one confirmed
// rest/v1/athlete/<id>/ answer to the only two facts OptiMove keeps — a
// sanitized display name and a normalized date of birth — and nothing else.
//
// Pure functions, no I/O. What never leaves this module: a raw name part, a
// short_name, the raw date value or a reason that carries a value. The
// callers get a display name or null, a date or null, and one boolean that a
// date was present in a form that is not accepted (counted in the load's own
// answer only, never stored per athlete).

// The longest display name kept, in Unicode code points (a first and last
// name together, or the `name` fallback). A longer value is refused whole,
// never cut.
export const DISPLAY_NAME_MAX_LENGTH = 120;

// A value with any of these is refused whole: controls (C0, C1, DEL), format
// characters (bidi controls and isolates, zero-width characters, the soft
// hyphen, the word joiner, the BOM and the Mongolian vowel separator are all
// Cf), line and paragraph separators, private-use and unassigned code points,
// lone surrogates, and the Hangul fillers that are letters by category but
// render blank.
const REFUSED = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/u;
const LETTER = /\p{L}/u;
// Runs of space separators (U+0020, NBSP, the en / em spaces, …) collapse to
// one space; a tab or a line break is a control and refuses the value.
const SPACE_RUN = /\p{Zs}+/gu;

// One name part (first_name, last_name or name) as a display text, or null.
// Unicode NFC, trimmed, space runs collapsed; refused whole when it carries a
// refused character, has no letter, or is longer than the maximum.
export function normalizeNamePart(value) {
  if (typeof value !== "string") return null;
  if (REFUSED.test(value)) return null;
  let text;
  try {
    text = value.normalize("NFC");
  } catch {
    return null;
  }
  if (REFUSED.test(text)) return null;
  text = text.replace(SPACE_RUN, " ").trim();
  if (!text || !LETTER.test(text)) return null;
  if ([...text].length > DISPLAY_NAME_MAX_LENGTH) return null;
  return text;
}

// The display name: first_name + last_name when both are usable, otherwise a
// usable `name`, otherwise null ("Name not provided"). short_name and every
// other field are never read.
export function displayNameOf({ first_name: first, last_name: last, name } = {}) {
  const f = normalizeNamePart(first);
  const l = normalizeNamePart(last);
  if (f !== null && l !== null) {
    const both = `${f} ${l}`;
    if ([...both].length <= DISPLAY_NAME_MAX_LENGTH) return both;
  }
  return normalizeNamePart(name);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// A valid ISO 8601 date-time in its extended form: a calendar date, "T", hours
// and minutes, optional seconds with an optional fraction, an optional "Z" or
// numeric offset of at most +-14:00 (the range real UTC offsets use). Its
// calendar date is the first ten characters, taken as
// written: never shifted by the offset or by a time zone.
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):?[0-5]\d|14:?00))?$/;
export const BIRTH_YEAR_MIN = 1900;

function calendarDate(text, today) {
  const m = DAY.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < BIRTH_YEAR_MIN || month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  // A date of birth after today (UTC) is not a date of birth.
  if (text > today) return null;
  return text;
}

// The date of birth as YYYY-MM-DD, or null. `unrecognised` is true when a
// value was there (not null, not an empty text) but was not accepted: another
// form, an impossible date, a year before 1900 or a date in the future. The
// raw value is never returned.
export function parseBirthDate(value, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  if (value === null || value === undefined) return { birthDate: null, unrecognised: false };
  if (typeof value !== "string") return { birthDate: null, unrecognised: true };
  if (value === "" || value.trim() === "") return { birthDate: null, unrecognised: false };
  if (DAY.test(value)) {
    const date = calendarDate(value, today);
    return { birthDate: date, unrecognised: date === null };
  }
  const dt = DATE_TIME.exec(value);
  if (dt) {
    const date = calendarDate(dt[1], today);
    return { birthDate: date, unrecognised: date === null };
  }
  return { birthDate: null, unrecognised: true };
}

// "Born DD.MM.YYYY" from a stored YYYY-MM-DD (the UI's own copy of this rule
// is in frontend/gpexe-import-view.js).
export function formatBirthDate(date) {
  const m = typeof date === "string" ? DAY.exec(date) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

// From one parsed answer body to the identity, or a refusal. Reads exactly
// five keys of the object; the answer's own `id` must be the canonical id
// that was asked for.
const ATHLETE_ID = /^(0|[1-9][0-9]{0,11})$/;
const canonical = (value) => {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return text !== null && ATHLETE_ID.test(text) ? text : null;
};
export function identityFromAnswer(body, askedId, now = new Date()) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "not_an_object" };
  const own = (key) => (Object.prototype.hasOwnProperty.call(body, key) ? body[key] : undefined);
  const id = canonical(own("id"));
  if (id === null || id !== askedId) return { ok: false, reason: "id_mismatch" };
  const { birthDate, unrecognised } = parseBirthDate(own("birthdate"), now);
  return {
    ok: true,
    identity: {
      gpexeAthleteId: id,
      displayName: displayNameOf({ first_name: own("first_name"), last_name: own("last_name"), name: own("name") }),
      birthDate,
    },
    birthDateUnrecognised: unrecognised,
  };
}
