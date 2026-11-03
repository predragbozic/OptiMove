import { state } from "./state.js";

// Which text of an exercise a screen shows (owner, 2026-11-03: "po jeziku
// korisnika"). A user who reads exercises in English (Account -> Exercise
// language, /api/auth/me's contentLanguage) sees an exercise's English name
// or instruction when it has one; otherwise, and for everyone who reads in
// Serbian, the Serbian text. Interface labels are not translated.
//
// It reads the CURRENT exercise row: the library's list rows carry name_en /
// instruction_en, the exercise detail and the editor nameEn / instructionEn.
// A plan item keeps its own title, written when the exercise was added, and
// is shown as it is.
//
// state.js imports exercise-editor.js and exercise-view-modes.js, so neither
// of them (nor anything they import) may import this module: state.js would
// then run before them and read their constants too early.
const ENGLISH_KEYS = {
  name: ["name_en", "nameEn"],
  instruction: ["instruction_en", "instructionEn"],
};

export function readsEnglish(user = state.currentUser) {
  return user?.contentLanguage === "en";
}

function englishOf(exercise, field) {
  for (const key of ENGLISH_KEYS[field] || []) {
    const value = exercise?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

// field: "name" or "instruction".
export function exerciseText(exercise, field, user = state.currentUser) {
  return (readsEnglish(user) && englishOf(exercise, field)) || exercise?.[field] || "";
}

// The line under a library card's name: the English instruction for an
// English reader when the exercise has one, otherwise the execution notes,
// else the instruction (the Serbian card as before).
export function exerciseCardDescription(exercise, user = state.currentUser) {
  return (readsEnglish(user) && englishOf(exercise, "instruction"))
    || exercise?.execution_notes || exercise?.instruction || "";
}
