// ST-2 (docs/ai/session-type-plan.md section 4): which session type an import of one source session writes.
//
// OptiMove decides the type, not the source. The order, first match wins:
//   1. the session is already imported: its activity keeps its type (a re-import never touches it) - "imported_session";
//   2. the approver's choice, when it is offered to the team now - "choice";
//   3. the team's suggestion for the source's category (training_load.source_session_types, v85; a team without a row
//      takes the built-in pair below, which is exactly what v85 seeded for the teams bound then) - "team_suggestion";
//   4. nothing: the candidate waits with the blocker session_type_required - "none".
// Every type is checked through training.session_type_offered(key, club, true), which locks the type row FOR SHARE: an
// archive (FOR UPDATE of that row) waits for a transaction that read it here, and a type archived or not the club's is
// never used. The caller holds the team's import lock; the type row is the last lock this read takes.
//
// No database pool here: every read runs on the caller's client, inside its transaction (the preview and the writer
// import this module and take no connection of their own). The suggestion's write is gpexeSessionTypeSuggestion.js.

export const SESSION_TYPE_SOURCE_SYSTEM = "gpexe";
// The pair the importer had in code before ST-2, and v85's seed.
export const DEFAULT_TYPE_BY_CATEGORY = new Map([["FULL TRAINING", "training_session"]]);
// The shape of a key (system, generated system and generated club keys of v85); what it names is decided under the lock.
export const SESSION_TYPE_KEY = /^[a-z][a-z0-9_]{1,60}$/;
export const CATEGORY_NAME_MAX = 80;

export function isSessionTypeKey(value) {
  return typeof value === "string" && SESSION_TYPE_KEY.test(value);
}

// A category the suggestion table can hold (its CHECK refuses the rest); anything else has no suggestion.
export function usableCategory(categoryName) {
  return typeof categoryName === "string" && categoryName.trim() !== "" && categoryName.length <= CATEGORY_NAME_MAX ? categoryName : null;
}

// Whether v85 is installed on this database (its suggestion table; every v85 object comes and goes together). Without it
// a type has no owner and no team has a suggestion of its own: the built-in pair is the suggestion and a type is any
// active row of training.activity_types - what the importer did before ST-2, without the category refusal. The
// precedent of v72's field inventory and v80's condition match (sourceConditionMatch.js). Asked once per resolve.
export async function sessionTypesInstalled(client) {
  return (await client.query(`select to_regclass('training_load.source_session_types') is not null as ok`)).rows[0].ok === true;
}

async function offered(client, key, clubId, installed) {
  if (!installed) {
    return (await client.query(`select 1 from training.activity_types where key = $1 and is_active = true for share`, [key])).rowCount === 1;
  }
  return (await client.query(`select training.session_type_offered($1, $2, true) as ok`, [key, clubId])).rows[0].ok === true;
}

// Returns { activityTypeKey, source, refusal }:
//   source  - "imported_session" | "choice" | "team_suggestion" | "none";
//   refusal - null, "session_type_not_offered" (the chosen type is unknown, another club's or archived: one answer for
//             all three, ADR-006) or "session_type_fixed" (the session is already imported with another type; its type
//             changes on the session, not through an import). With a refusal the other two fields say what the import
//             would do WITHOUT the choice; the caller writes nothing.
// chosenKey: undefined (no choice) or a key already checked with isSessionTypeKey.
export async function resolveSessionType(client, { ownerTeamId, categoryName, sourceExternalId, chosenKey = undefined }) {
  const category = usableCategory(categoryName);
  const installed = await sessionTypesInstalled(client);
  const suggestedSql = installed
    ? `(select s.activity_type_key from training_load.source_session_types s
              where s.owner_team_id = t.id and s.source_system = $3 and s.category_name = $4)`
    : `(select null::text where $4::text is null)`;
  const row = (await client.query(
    `select t.club_id,
            ${suggestedSql} as suggested,
            x.activity_id, x.activity_type_key
       from public.teams t
       left join lateral (
         select a.id as activity_id, a.activity_type_key
           from training_load.metric_source_connections c
           join training_load.metric_events e on e.source_connection_id = c.id
           join training.activity_metric_event_links l on l.metric_event_id = e.id and l.link_status = 'confirmed'
           join training.activities a on a.id = training.resolve_canonical_activity_id(l.activity_id)
          where c.source_system = $3 and c.owner_scope = 'team' and c.owner_team_id = t.id and c.state = 'active'
            and e.source_external_id = $2
          order by e.id
          limit 1
       ) x on true
      where t.id = $1`,
    [ownerTeamId, sourceExternalId, SESSION_TYPE_SOURCE_SYSTEM, category],
  )).rows[0];
  if (!row) return { activityTypeKey: null, source: "none", refusal: chosenKey === undefined ? null : "session_type_not_offered" };
  if (row.activity_id) {
    const current = row.activity_type_key ?? null;
    return { activityTypeKey: current, source: "imported_session", refusal: chosenKey !== undefined && chosenKey !== current ? "session_type_fixed" : null };
  }
  const suggestedKey = row.suggested ?? (category ? DEFAULT_TYPE_BY_CATEGORY.get(category) ?? null : null);
  const suggestion = suggestedKey && await offered(client, suggestedKey, row.club_id, installed)
    ? { activityTypeKey: suggestedKey, source: "team_suggestion" }
    : { activityTypeKey: null, source: "none" };
  if (chosenKey === undefined) return { ...suggestion, refusal: null };
  // The suggestion chosen again is the suggestion: one preview, one hash.
  if (chosenKey === suggestedKey) return { ...suggestion, refusal: suggestion.source === "none" ? "session_type_not_offered" : null };
  if (!(await offered(client, chosenKey, row.club_id, installed))) return { ...suggestion, refusal: "session_type_not_offered" };
  return { activityTypeKey: chosenKey, source: "choice", refusal: null };
}
