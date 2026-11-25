// Pure calculations over already authorized, query-resolved values. This module
// never fetches athletes or expands a query's data_workspace/shell cohort.
const unavailable = (reason) => ({ status: "unavailable", reason, value: null });

export function teamAverageReference({ rosterAthleteIds, athleteValues, unit, calculated = false }) {
  if (calculated) return unavailable("calculatedMetric");
  const roster = new Set(rosterAthleteIds);
  const values = new Map();
  const seen = new Set();
  for (const row of athleteValues) {
    if (!roster.has(row.athleteId)) continue;
    // The query must supply one period aggregate per athlete, not occasions.
    if (seen.has(row.athleteId)) return unavailable("duplicateAthlete");
    seen.add(row.athleteId);
    if (row.status !== "ok" || row.unit !== unit || typeof row.value !== "number" || !Number.isFinite(row.value)) continue;
    values.set(row.athleteId, row.value);
  }
  const includedAthletes = values.size;
  const leftOutAthletes = roster.size - includedAthletes;
  if (includedAthletes < 3) return { ...unavailable("tooFewAthletes"), includedAthletes, leftOutAthletes };
  const mean = [...values.values()].reduce((sum, value) => sum + value / includedAthletes, 0);
  if (!Number.isFinite(mean)) return unavailable("invalidValue");
  const rounded = Number(mean.toFixed(3));
  return { status: "ok", value: rounded, unit, includedAthletes, leftOutAthletes };
}

export function radarReferenceAxis({ actual, anchor, references = [] }) {
  if (typeof anchor !== "number" || !Number.isFinite(anchor) || anchor <= 0) return unavailable("invalidAnchor");
  if (typeof actual !== "number" || !Number.isFinite(actual) || actual < 0) return unavailable("invalidActual");
  const normalized = actual / anchor * 100;
  if (!Number.isFinite(normalized)) return unavailable("invalidValue");
  const projected = references.map(({ key, value }) => ({
    key,
    ...(typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isFinite(value / anchor * 100)
      ? { status: "ok", value, normalized: value / anchor * 100 }
      : unavailable("missingReference")),
  }));
  return { status: "ok", value: actual, normalized, anchor, references: projected };
}

export function referenceBand(lower, upper) {
  if (typeof lower !== "number" || typeof upper !== "number" || !Number.isFinite(lower) || !Number.isFinite(upper)) return unavailable("missingReference");
  if (lower > upper) return unavailable("invalidBand");
  return { status: "ok", lower, upper };
}
