// English for plan items (owner, 2026-11-03: a coach who reads exercises in
// English sees them in English in the Builder and in programs too, unless an
// exercise has only its Serbian text). An item keeps its own title and
// instruction, copied from the exercise when it was added. While they still
// equal that exercise's current Serbian name and instruction (whitespace
// aside), the item also carries the exercise's English (title_en,
// description_en); an item a coach rewrote, a free item and an exercise
// without English carry none. The server sends both texts; the frontend picks
// by the reader's language (frontend/exercise-text.js, planItemText). Nothing
// is written: the stored text stays as it is.
const normalized = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const englishWhileSame = (stored, serbian, english) =>
  (english && normalized(stored) && normalized(stored) === normalized(serbian) ? english : null);

// rows: anything with exercise_id, title and description (a view row, a
// Builder row). One query for all of them, none when no row names an
// exercise, and only the five columns of the exercises the rows already
// reference. The English is a display extra: should the lookup fail, the
// rows carry none and show their stored text, and the read (or the answer to
// a save that already went through) does not fail with it.
export async function decoratePlanItemEnglish(rows, runQuery) {
  const ids = [...new Set(rows.map((row) => row.exercise_id).filter(Boolean))];
  const byId = new Map();
  if (ids.length) {
    try {
      const found = await runQuery(
        "select id, name, instruction, name_en, instruction_en from library.exercises where id = any($1::uuid[])",
        [ids],
      );
      for (const exercise of found.rows) byId.set(exercise.id, exercise);
    } catch {
      byId.clear();
    }
  }
  for (const row of rows) {
    const exercise = row.exercise_id ? byId.get(row.exercise_id) : null;
    row.title_en = exercise ? englishWhileSame(row.title, exercise.name, exercise.name_en) : null;
    row.description_en = exercise ? englishWhileSame(row.description, exercise.instruction, exercise.instruction_en) : null;
  }
  return rows;
}
