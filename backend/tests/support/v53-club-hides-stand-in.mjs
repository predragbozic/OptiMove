// v53's club hides table, as an empty stand-in, for the suites whose schema is
// a fixed, older list of migrations (training-load-dashboard: v1-v19;
// training-load-metrics and training-activity: the metrics catalog and the
// activity core). The older catalog's definitions list and the dashboard
// template resolver read `training_load.metric_definition_club_hides` (J15
// section 4.4) whenever the request's workspace may hide a system variable, so
// on such a schema the read needs the table to exist. Only the columns those
// readers use are created; no club hides anything there, and every expectation
// of those suites is the one before v53. v53 itself, the hides it writes and
// the readers' rules over real hides are tested in
// source-metric-variables-club-7i.test.mjs (tests 8, 9 and 23).
export async function createClubHidesStandIn(client) {
  await client.query(`create table training_load.metric_definition_club_hides (
    club_id uuid not null,
    metric_definition_id uuid not null references training_load.metric_definitions(id),
    shown_at timestamptz
  )`);
}
