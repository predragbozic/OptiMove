import assert from "node:assert/strict";
import { DISPOSABLE_DATABASE_NAME_PATTERN } from "./disposable-db.mjs";

// The migration seeded these words; vary only the evaluator in this disposable fixture.
export async function prepareProgramAssignmentWords(sql, grantedWords) {
  assert.match((await sql.query("select current_database() name")).rows[0].name, DISPOSABLE_DATABASE_NAME_PATTERN);
  const { body: definition } = (await sql.query("select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) body")).rows[0];
  const body = definition.replace(", 'programs.edit', 'programs.assign', 'programs.publish'", "");
  assert.notEqual(body, definition, "the exact v110 evaluator is installed");
  return async words => {
    assert.ok(words.every(word => grantedWords.includes(word)));
    const withWords = body.replace("'programs.view'", ["programs.view", ...words].map(word => "'" + word + "'").join(", "));
    await sql.query(withWords);
  };
}
