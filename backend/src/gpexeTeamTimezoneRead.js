// v62 (mixed_timezones (b)): the importer's read of a team's session time zone. Kept apart from the service
// (gpexeTeamTimezone.js), which imports the app's pool: the writer and the preview take a client and never import db.js.

// An IANA zone name ("Europe/Sarajevo", "UTC"), as Node's Intl knows it. The database checks pg_timezone_names as well.
export function validIanaZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// The team's zone for the importer, or null. `client` may be inside the caller's transaction (which holds the team lock).
export async function teamSessionTimezone(client, teamId) {
  const row = (await client.query(
    `select timezone from training_load.gpexe_team_session_timezones where owner_team_id = $1`,
    [teamId],
  )).rows[0];
  return row?.timezone ?? null;
}
