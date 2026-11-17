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
