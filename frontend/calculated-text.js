// Calculated variables (J21): the sentences every screen says about them, in one place, so the Variables screen and the
// results a coach reads use the same words (the Rukovodilac's condition of 2026-11-19: never an unexplained blank).
export const CALCULATED_TEXT = Object.freeze({
  // C144: from now on, no backfill.
  fromNow: "Calculated for sessions imported after this variable was made. Sessions imported earlier stay without it.",
  // C141: no switch per team.
  perTeam: "OptiMove calculates it for a team once every variable it adds up is switched on for that team.",
  // C142 and C145.
  missing: "If one of them has no value in a session, this variable has no value there either (zero is a value; missing is not).",
  // The overlap is not checked in step 1 (J21).
  overlap: "OptiMove does not check whether two of them count the same thing (for example zone 3 and \"above 25 W/kg\"): choose variables that do not overlap.",
  // C147.
  athletes: "Athletes do not see calculated variables.",
  dayRule: "A day's values are added up (Sum). A calculated variable has no allowed values.",
  // An empty cell of a calculated variable in a session's results.
  emptyCell: "Not calculated: one of the variables it adds up has no value for this athlete here.",
});

// Whether a coach's fact (the canonical read) is OptiMove's calculated value: derived, naming its formula version.
export const isCalculatedFact = (fact) => fact?.factKind === "metric_value" && fact.detail?.isDerived === true
  && typeof fact.detail?.computedByRef?.formulaVersionId === "string";
