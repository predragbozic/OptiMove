
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import pg from "pg";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";
import { VARIABLE_MANAGE as manage, editVariablesManageTestRole, reviseFixtureRole, stageVariablesManageForTest, takeFixtureCeilings } from "./support/variables-manage-grants.mjs";

const path = "/api/training-load/sources/metrics/variables";

test("native variable create and version need the staged Manage right; a queued request rechecks the grant", async () => {
  const fixture = await createPagesDatabase({ through: "202612141000", label: "variable_manage" });
  const { client } = fixture;
  const blocker = new pg.Client({ connectionString: fixture.url });
  let server;
  const editRole = (word, add, roleId) => editVariablesManageTestRole(client, word, add, roleId);
  try {
    await blocker.connect();
    const f = fixtures(client);
    const clubA = await f.club("Native Variables A");
    const clubB = await f.club("Native Variables B");
    const teamA = await f.team(clubA);
    const a = await f.user("Admin A");
    const b = await f.user("Admin B");
    const coach = await f.user("Team coach");
    const platform = await f.user("Platform admin");
    await f.grantClub(a, clubA);
    await f.grantClub(b, clubB);
    await f.grantTeam(coach, teamA);
    await f.grantPlatform(platform);
    await client.query(
      "insert into public.user_workspace_preferences(user_id,workspace_type,scope_id)"
      + " values($1,'club',$2),($3,'club',$4),($5,'team',$6),($7,'platform',null)",
      [a, clubA, b, clubB, coach, teamA, platform],
    );
    server = await startServer(fixture.url);
    const [aCookie, bCookie, coachCookie, platformCookie] = await Promise.all(
      [a, b, coach, platform].map(server.cookieFor),
    );
    const post = (cookie, endpoint, body) => server.api(cookie, endpoint, { method: "POST", body });
    const createInput = label => ({ requestKey: key(), label, unit: "m", levels: ["session"], dailyAggregationMethod: "sum" });
    const denied = answer => assert.deepEqual([answer.status, answer.body], [404, { error: "notFound" }]);
    const receipts = async requestKey => (await client.query(
      "select 1 from training_load.metric_variable_requests where request_key=$1", [requestKey],
    )).rowCount;

    const create = createInput("Owner variable");
    denied(await post(aCookie, path, create));
    assert.equal(await receipts(create.requestKey), 0);
    const system = await post(platformCookie, path, createInput("System variable"));
    assert.equal(system.status, 201, system.text);

    await stageVariablesManageForTest(client);
    const firstUse = async (narrow = false) => (await client.query(
      narrow
        ? "select first_checked_write_at from training_load.variable_rename_archive_v112_use"
        : "select first_checked_write_at from training_load.variables_manage_v113_use",
    )).rows[0].first_checked_write_at;
    assert.equal(await firstUse(), null);
    const callRename = (variableId, body) => post(aCookie, path + "/" + variableId + "/rename", body);
    denied(await post(aCookie, path, create));
    await editRole(manage, true);
    denied(await post(coachCookie, path, createInput("Not a club administrator")));
    const noop = await post(aCookie, path + "/" + system.body.variable.id + "/show", { requestKey: key() });
    assert.equal(noop.status, 200, noop.text);
    assert.equal(noop.body.idempotent, true);
    assert.equal(await firstUse(), null, "a fresh no-op is not first use");
    const platformWhileStaged = await post(platformCookie, path, createInput("Another system variable"));
    assert.equal(platformWhileStaged.status, 201, platformWhileStaged.text);
    assert.equal(await firstUse(), null, "existing platform writes do not stamp native use");
    const mapping = await import("../src/sourceMetricMappingService.js");
    mapping.setMappingCommitForTests({ fault: async transaction => {
      mapping.setMappingCommitForTests();
      await transaction.query("rollback");
      throw new Error("Commit not confirmed");
    } });
    const rolledBack = await post(aCookie, path, create);
    assert.deepEqual([rolledBack.status, rolledBack.body.error], [503, "outcome_unknown"]);
    assert.equal(await firstUse(), null);
    assert.equal(await receipts(create.requestKey), 0);
    const made = await post(aCookie, path, create);
    assert.equal(made.status, 201, made.text);
    assert.equal(await receipts(create.requestKey), 1);
    assert.equal((await post(aCookie, path, create)).body.replayed, true);

    const marked = await firstUse();
    assert.ok(marked instanceof Date);
    assert.equal(await firstUse(true), null);
    const definitionId = made.body.variable.id;
    const rename = async label => {
      const current = await server.api(aCookie, path + "/" + definitionId);
      assert.equal(current.status, 200, current.text);
      return { requestKey: key(), labelsToken: current.body.variable.labelsToken, label };
    };
    const narrowRename = await rename("Narrow preferred");
    const renamed = await callRename(definitionId, narrowRename);
    assert.equal(renamed.status, 200, renamed.text);
    const narrowMarked = await firstUse(true);
    assert.ok(narrowMarked instanceof Date);
    await editRole("variables.rename_archive", false);
    const fullOnly = await callRename(definitionId, await rename("Full permission alternative"));
    assert.equal(fullOnly.status, 200, fullOnly.text);
    assert.deepEqual(await firstUse(), marked);
    assert.deepEqual(await firstUse(true), narrowMarked);
    assert.equal((await callRename(definitionId, narrowRename)).body.replayed, true);
    const hideNoop = await post(aCookie, path + "/" + system.body.variable.id + "/show", { requestKey: key() });
    assert.equal(hideNoop.status, 200, hideNoop.text);
    assert.equal(hideNoop.body.idempotent, true);
    assert.deepEqual(await firstUse(), marked);
    const endpoint = path + "/" + definitionId + "/versions";
    const versionId = (await client.query(
      "select current_version_id from training_load.metric_definitions where id=$1", [definitionId],
    )).rows[0].current_version_id;
    const version = { requestKey: key(), expectedCurrentVersionId: versionId, unit: "m", dailyAggregationMethod: "sum", minValue: "1" };
    denied(await post(bCookie, endpoint, version));
    denied(await post(aCookie, path + "/" + key() + "/versions", version));

    await blocker.query("begin");
    const blockedCreate = createInput("Would be created");
    let pending;
    try {
      await takeFixtureCeilings(blocker);
      pending = Promise.all([post(aCookie, path, blockedCreate), post(aCookie, endpoint, version)]);
      const deadline = Date.now() + 4000;
      while (true) {
        const waiting = await client.query(
          "select 1 from pg_stat_activity where datname=current_database()"
          + " and wait_event='advisory' and query like 'select public.lock_club_ceiling%' and pid<>pg_backend_pid()",
        );
        if (waiting.rowCount) break;
        if (Date.now() >= deadline) assert.fail("a native Variables write did not wait on the club ceiling");
        await delay(25);
      }
      await reviseFixtureRole(blocker, manage, false);
      await blocker.query("commit");
    } finally {
      await blocker.query("rollback");
    }
    for (const reply of await pending) denied(reply);
    assert.equal(await receipts(blockedCreate.requestKey), 0);
    assert.equal(await receipts(version.requestKey), 0);
    assert.equal((await client.query("select current_version_id from training_load.metric_definitions where id=$1", [definitionId])).rows[0].current_version_id, versionId);

    denied(await post(aCookie, path, create));
    const visible = await server.api(aCookie, path + "/" + definitionId);
    assert.equal(visible.status, 200, visible.text);
    await editRole(manage, true);
    const saved = await post(aCookie, endpoint, version);
    assert.equal(saved.status, 201, saved.text);
    assert.equal(await receipts(version.requestKey), 1);
    await editRole("variables.view", false, ROLE_IDS.team_coach);
    await editRole("variables.view", false);
    denied(await post(aCookie, endpoint, version));
    denied(await post(aCookie, path, createInput("View required")));
    assert.equal(await receipts(version.requestKey), 1);
    await editRole("variables.view", true);
    await editRole("variables.view", true, ROLE_IDS.team_coach);
    const replay = await post(aCookie, endpoint, version);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.replayed, true);
    assert.equal(await receipts(version.requestKey), 1);
    // An old create hash did not encode the workspace. A genuinely different
    // club's committed row cannot confirm the first rolled-back transaction.
    await f.grantClub(a, clubB);
    const uncertain = createInput("Same submitted input in two clubs");
    const selectClub = async scopeId => {
      const selected = await server.api(aCookie, "/api/auth/workspace", {
        method: "PUT", body: { type: "club", scopeId },
      });
      assert.equal(selected.status, 200, selected.text);
    };
    mapping.setMappingCommitForTests({ fault: async transaction => {
      mapping.setMappingCommitForTests();
      await transaction.query("rollback");
      await selectClub(clubB);
      assert.equal((await post(aCookie, path, uncertain)).status, 201);
      await selectClub(clubA);
      throw new Error("Original commit could not be confirmed");
    } });
    try {
      const result = await post(aCookie, path, uncertain);
      assert.deepEqual([result.status, result.body.error, result.body.variableId], [503, "outcome_unknown", undefined]);
      assert.deepEqual((await client.query(
        "select owner_club_id from training_load.metric_variable_requests where request_key=$1", [uncertain.requestKey],
      )).rows, [{ owner_club_id: clubB }]);
    } finally {
      mapping.setMappingCommitForTests();
    }

  } finally {
    try {
      await blocker.end();
      await server?.stop();
    } finally {
      await fixture.drop();
    }
  }
});
