// G2 (docs/ai/gpexe-field-inventory-plan.md, section 9): the pinned set - the GPEXE field names whose values a check
// keeps in the stored snapshot besides the importer's own consumed fields. It is read from the database (T2a), never
// from a GPEXE answer: the gpexe / rest_v1 source fields whose key is a generic plain one, `athlete_session.<name>` (a
// row number) or `details.players.<name>` (a details {unit, value}). Since v74 such a row exists only through route C
// (created by a platform admin, from a name the inventory observed) or as a seed; a seeded name is already in the
// adapter's own lists and the union changes nothing for it.
//
// Only active (not retired) fields with an active revision are pinned. A stored key whose name is not an identifier or is a dangerous key is
// left out of the set (and counted in a log line, never named): one bad row never fails every team's check. More
// than PINNED_FIELDS_MAX names for one endpoint (route C refuses the 65th) stops the check with a stable code, and a
// retention run then keeps only the consumed fields. Nothing is kept that was not named here.

export const PINNED_FIELDS_MAX = 64;
export const PINNED_PREFIXES = Object.freeze({ athleteSession: "athlete_session.", details: "details.players." });
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// The one list of names no generic field may carry (route C, the inventory, the extractor registry and this set).
export const DANGEROUS_FIELD_NAMES = Object.freeze(new Set(["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"]));
const DANGEROUS = DANGEROUS_FIELD_NAMES;

export class PinnedFieldsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinnedFieldsError";
    this.code = code;
  }
}

export const EMPTY_PINNED_FIELDS = Object.freeze({ athleteSession: Object.freeze([]), details: Object.freeze([]) });

// One read of T2a; at most PINNED_FIELDS_MAX + 1 per endpoint is enough to know the bound was passed.
export const PINNED_FIELDS_SQL = `
  select source_metric_key from (
    select source_metric_key, row_number() over (partition by split_part(source_metric_key, '.', 1) order by source_metric_key) as n
      from training_load.source_metric_definitions d
     where source_system = 'gpexe' and api_family = 'rest_v1' and state = 'active'
       and (starts_with(source_metric_key, 'athlete_session.') or starts_with(source_metric_key, 'details.players.'))
       -- G1b-1 (the Rukovodilac's remedy (i)): a field with no active revision is not kept; retiring the field's active
       -- revision (L5) is how a platform admin stops every check from keeping it.
       and exists (select 1 from training_load.source_metric_definition_versions r
                     where r.source_metric_definition_id = d.id and r.state = 'active')
  ) k where n <= ${PINNED_FIELDS_MAX + 1} order by source_metric_key`;

const validName = (name) => typeof name === "string" && NAME.test(name) && !DANGEROUS.has(name);

// The pinned set from T2a keys: { athleteSession: [...], details: [...] }, sorted, unique and frozen.
// A key that is not text, or whose name is not one a check can keep, is left out (never named in the log).
export function pinnedFieldsFromKeys(keys, { log = console } = {}) {
  const sets = { athleteSession: new Set(), details: new Set() };
  let skipped = 0;
  for (const key of keys ?? []) {
    if (typeof key !== "string") { skipped += 1; continue; }
    const endpoint = Object.keys(PINNED_PREFIXES).find((e) => key.startsWith(PINNED_PREFIXES[e]));
    if (!endpoint) continue;
    const name = key.slice(PINNED_PREFIXES[endpoint].length);
    if (!validName(name)) { skipped += 1; continue; }
    sets[endpoint].add(name);
  }
  if (skipped > 0) log?.warn?.(`[gpexe] pinned set: ${skipped} source field key(s) left out (pinned_field_invalid)`);
  return checkedPinnedFields({ athleteSession: [...sets.athleteSession], details: [...sets.details] });
}

// A pinned set given to the adapter or a projection, checked again (pure): two arrays of valid names, each within the bound.
export function checkedPinnedFields(pinned) {
  if (pinned === null || pinned === undefined) return EMPTY_PINNED_FIELDS;
  if (typeof pinned !== "object" || Array.isArray(pinned)) throw new PinnedFieldsError("pinned_field_invalid", "The pinned set is not an object.");
  for (const key of Object.keys(pinned)) {
    if (!Object.hasOwn(PINNED_PREFIXES, key)) throw new PinnedFieldsError("pinned_field_invalid", "The pinned set names an endpoint a check does not keep.");
  }
  const out = {};
  for (const endpoint of Object.keys(PINNED_PREFIXES)) {
    const list = pinned[endpoint] ?? [];
    if (!Array.isArray(list)) throw new PinnedFieldsError("pinned_field_invalid", "The pinned set is not a list of names.");
    const names = [...new Set(list)];
    if (!names.every(validName)) throw new PinnedFieldsError("pinned_field_invalid", "A source field's name is not one a check can keep.");
    if (names.length > PINNED_FIELDS_MAX) {
      throw new PinnedFieldsError("pinned_fields_too_many", `More than ${PINNED_FIELDS_MAX} source fields of one kind would be kept by a check.`);
    }
    out[endpoint] = Object.freeze(names.sort());
  }
  return Object.freeze(out);
}

// Reads the pinned set with the caller's executor (a pool, a client or a query function).
export async function readPinnedFields(executor) {
  const run = typeof executor === "function" ? executor : (text, values) => executor.query(text, values);
  const rows = (await run(PINNED_FIELDS_SQL, [])).rows;
  return pinnedFieldsFromKeys(rows.map((r) => r.source_metric_key));
}
