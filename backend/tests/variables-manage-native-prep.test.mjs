
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import pg from "pg";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

const path = "/api/training-load/sources/metrics/variables";
const manage = "variables.manage";

async function reviseFixtureRole(client, word, add, roleId = ROLE_IDS.club_admin) {
  const migration = "fixtures/variables-manage-" + key() + ".sql";
  const { rows: [{ revision }] } = await client.query(
    "update public.permission_roles set revision=revision+1, updated_at=now() where id=$1 returning revision", [roleId],
  );
  const column = add ? "items_added" : "items_removed";
  await client.query(
    "insert into public.permission_role_changes(role_id,revision_after,kind,migration_name," + column + ")"
    + " values($1,$2,'migration',$3,array[$4]::text[])", [roleId, revision, migration, word],
  );
  await client.query(add
    ? "insert into public.permission_role_items (role_id,permission_word) values($1,$2)"
    : "delete from public.permission_role_items where role_id=$1 and permission_word=$2", [roleId, word]);
  await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')", [migration]);
}

async function takeFixtureCeilings(client) {
  await client.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
}

test("native variable create and version need the staged Manage right; a queued request rechecks the grant", async () => {
  const fixture = await createPagesDatabase({ through: "202612141000", label: "variable_manage" });
  const { client } = fixture;
  const blocker = new pg.Client({ connectionString: fixture.url });
  let server;
  const editRole = async (word, add, roleId) => {
    await client.query("begin");
    try {
      await takeFixtureCeilings(client);
      await reviseFixtureRole(client, word, add, roleId);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  };
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

    const { rows: [{ evaluator }] } = await client.query(
      "select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) as evaluator",
    );
    const stage = evaluator.replace("'variables.view'", "'variables.view', 'variables.manage'");
    assert.notEqual(stage, evaluator);
    await client.query(stage);
    denied(await post(aCookie, path, create));
    await editRole(manage, true);
    denied(await post(coachCookie, path, createInput("Not a club administrator")));
    const made = await post(aCookie, path, create);
    assert.equal(made.status, 201, made.text);
    assert.equal(await receipts(create.requestKey), 1);
    assert.equal((await post(aCookie, path, create)).body.replayed, true);

    const definitionId = made.body.variable.id;
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
    const mapping = await import("../src/sourceMetricMappingService.js");
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
