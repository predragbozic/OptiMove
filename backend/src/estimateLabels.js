// 6b-C1: the label of an estimated value (contract docs/ai/phase5b-estimates-contract.md rule 10, section 8):
// method, basis, author and date, read from training_load.metric_value_estimates for the estimate occasions a
// reader already returns. Closed fields only: never a user id, an athlete id or the raw basis.
//
// The copy source is named only when the reader passes its name: each reader names the source only if that athlete
// is already named in the same answer (the roster's athletes; the activity facts the caller may see). So an athlete
// reading their own results learns the method, never whose values were copied.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function finite(value) {
  // A missing basis field is no number (never "0 minutes").
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// occasionIds: the estimate occasions of the answer. Returns Map(occasionId -> { label, sourceAthleteId }), where
// sourceAthleteId is for the reader's own visibility check and never leaves the server.
export async function readEstimateLabels(executor, occasionIds) {
  const ids = [...new Set((occasionIds || []).map(String).filter((id) => UUID.test(id)))];
  if (!ids.length) return new Map();
  const rows = (await executor.query(
    `select e.occasion_id, e.method, e.basis, e.estimated_at,
            coalesce(nullif(u.display_name, ''), u.full_name) as author
       from training_load.metric_value_estimates e
       join public.users u on u.id = e.estimated_by_user_id
      where e.occasion_id = any($1::uuid[])`,
    [ids],
  )).rows;
  const out = new Map();
  for (const r of rows) {
    const basis = r.basis && typeof r.basis === "object" ? r.basis : {};
    const label = { method: r.method, estimatedBy: r.author ?? null, estimatedAt: r.estimated_at ? new Date(r.estimated_at).toISOString() : null };
    let sourceAthleteId = null;
    if (r.method === "proportional") {
      label.minutes = finite(basis.minutes);
      label.sessionCount = finite(basis.sessions);
    } else if (r.method === "team_average") {
      label.athleteCount = finite(basis.athletes);
    } else if (r.method === "scale_recording") {
      label.recordedMinutes = finite(basis.recordedMinutes);
      label.targetMinutes = finite(basis.targetMinutes);
    } else if (r.method === "copy_athlete") {
      sourceAthleteId = typeof basis.sourceAthleteId === "string" ? basis.sourceAthleteId.toLowerCase() : null;
    }
    out.set(String(r.occasion_id), { label, sourceAthleteId });
  }
  return out;
}

// The label a reader returns: the copy source's name only when nameOf(sourceAthleteId) gives one (the athlete is
// already named in the same answer); otherwise no name at all.
export function estimateLabelFor(entry, nameOf) {
  if (!entry) return null;
  const label = { ...entry.label };
  if (label.method === "copy_athlete" && entry.sourceAthleteId) {
    const name = nameOf(entry.sourceAthleteId);
    if (typeof name === "string" && name) label.sourceAthleteName = name;
  }
  return label;
}
