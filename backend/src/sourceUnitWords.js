// GPEXE's unit words (docs/ai/gpexe-field-inventory-plan.md, section 8.10; v74's seed-only table
// training_load.source_unit_words): each word GPEXE sends with a details value is a quantity kind, mapped to the unit
// token the raw value is in and the board's display rule. G1b-2 reads them in two places:
//   - the importer's plan, the 7e preview and the club board, once per plan, only when a generic details field is read
//     (rule (b): the extractor takes exactly the words whose token is the version's proven source unit);
//   - routes 8 and O, the platform's comparison of a generic field.
// The table is seed-only (a tenth word is a migration), so a plain read without a lock is enough.
import { isGenericDetailsKey } from "./sourceMetricExtractors.js";

const UNIT_WORDS_SQL = `select word, source_unit, display_rule from training_load.source_unit_words
                         where source_system = $1 and api_family = $2 order by word`;

// word -> { sourceUnit, displayRule }, for one source family.
export async function readUnitWordRows(executor, { sourceSystem, apiFamily }) {
  const rows = (await executor.query(UNIT_WORDS_SQL, [sourceSystem, apiFamily])).rows;
  return new Map(rows.map((r) => [r.word, Object.freeze({ sourceUnit: r.source_unit, displayRule: r.display_rule })]));
}

// word -> unit token: the extractor's context (sourceMetricExtractors.js, unitWordFits).
export async function readUnitWords(executor, family) {
  return new Map([...(await readUnitWordRows(executor, family))].map(([word, row]) => [word, row.sourceUnit]));
}

// The words for a plan of these fields, or an empty map when none of them is a generic details field (the table is
// then not read at all: a seeded field never needs it).
export async function unitWordsFor(executor, fields) {
  const generic = fields.find((f) => isGenericDetailsKey(f));
  if (!generic) return new Map();
  return readUnitWords(executor, { sourceSystem: generic.sourceSystem, apiFamily: generic.apiFamily });
}

// G1b-3 (the Rukovodilac's decision on the Independent's LOW-1): a revision proven through route O carries the exact
// word GPEXE sent (T9i.source_unit_word of its unit observation, final in v74); the importer takes that word only. Two
// seeded pairs share a token (energy / energy_std -> J/kg, time / duration -> s), so a change of word inside a pair may
// be a change of quantity. `rev` is the SQL alias of a T2b row (training_load.source_metric_definition_versions).
export const provenWordSql = (rev) => `(select i.source_unit_word from training_load.source_metric_confirmation_items i
   where i.confirmation_id = ${rev}.unit_observation_id and i.item_kind = 'field_unit' and i.source_unit_word is not null)`;

// The proven word of each of these revisions (id -> word; a revision without one is absent). Read only for a generic
// details field, like the words: a database before v74 (no comparison tables) is never asked.
export async function provenWordsOf(executor, revisionIds) {
  if (revisionIds.length === 0) return new Map();
  const rows = (await executor.query(
    `select r.id::text as id, ${provenWordSql("r")} as word from training_load.source_metric_definition_versions r where r.id = any($1::uuid[])`,
    [revisionIds],
  )).rows;
  return new Map(rows.filter((r) => r.word !== null).map((r) => [r.id, r.word]));
}

// The importer's form: the proven word of each generic details row of a plan (sourceMetricVersionId -> word); a plan
// without one asks nothing.
export async function provenWordsFor(executor, rows) {
  const generic = rows.filter((r) => isGenericDetailsKey(r));
  return provenWordsOf(executor, generic.map((r) => String(r.sourceMetricVersionId)));
}

// The words whose token is this unit.
export function wordsOfUnit(unitWords, sourceUnit) {
  return [...unitWords].filter(([, token]) => token === sourceUnit).map(([word]) => word).sort();
}

// Why a created details field cannot be read in this unit, or null. With a proven word: that word, and its token is the
// unit. Without one (a document proof): the unit has exactly one seeded word - a shared token is refused, since a
// document cannot tell which GPEXE word the unit is.
export function unitWordCodeOf({ unitWords, sourceUnit, provenWord = null }) {
  if (typeof provenWord === "string") return unitWords.get(provenWord) === sourceUnit ? null : "unit_word_missing";
  const words = wordsOfUnit(unitWords, sourceUnit);
  if (words.length === 0) return "unit_word_missing";
  return words.length === 1 ? null : "unit_word_ambiguous";
}
