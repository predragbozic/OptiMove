import assert from "node:assert/strict";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

import { writeRevision } from "./support/source-revisions.mjs";
import { allowSyntheticTestFields } from "./support/test-extractors.mjs";

allowSyntheticTestFields();

const route = "/api/training-load/sources/metrics";
async function stage(client) {
  const { rows: [{ prosrc }] } = await client.query("select prosrc from pg_proc where oid='public.permission_word_honoured(text)'::regprocedure");
  const body = prosrc.trim() + " or p_word='mappings.manage'";
  await client.query("begin");
  try {
    await client.query("create or replace function public.permission_word_honoured(p_word text) returns boolean language sql immutable set search_path=pg_catalog, public as $fixture$ " + body + " $fixture$");
    // Seed the permission word on the disposable fixture only.
    await client.query("alter table public.permission_role_items disable trigger user");
    await client.query("insert into public.permission_role_items(role_id,permission_word) values($1,'mappings.manage')", [ROLE_IDS.club_admin]);
    await client.query("alter table public.permission_role_items enable trigger user");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

test("native create, version and submit require Mappings Manage in the owning workspace", async () => {
  const db = await createPagesDatabase({ through: "202612141000", label: "mappings_native" });
  const { client } = db;
  const f = fixtures(client);
  let server;
  try {
    const clubA = await f.club("Mappings A"), clubB = await f.club("Mappings B");
    const native = await f.user("Mapping native"), platform = await f.user("Mapping operator");
    await f.grantClub(native, clubA);
    await f.grantClub(native, clubB);
    await f.grantPlatform(platform);
    await f.grantClub(platform, clubA);
    await f.grantClub(platform, clubB);
    await client.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'club',$3),($2,'club',$3)", [native, platform, clubA]);
    server = await startServer(db.url);
    const cookie = await server.cookieFor(native), operator = await server.cookieFor(platform);
    const post = (who, path, body) => server.api(who, route + path, { method: "POST", body });
    const variable = async (label) => {
      const response = await post(operator, "/variables", { requestKey: key(), label, unit: "s", levels: ["session"], dailyAggregationMethod: "sum" });
      assert.equal(response.status, 201, response.text);
      return response.body.variable.id;
    };
    const own = await variable("Own mapping");
    const move = user => client.query("update public.user_workspace_preferences set workspace_type='club',scope_id=$1 where user_id=$2", [clubB, user]);
    await move(platform);
    const foreign = await variable("Foreign mapping");
    const { rows: [field] } = await client.query("insert into training_load.source_metric_definitions (source_system,api_family,source_metric_key,source_label,created_by_user_id)"
      + " values ('gpexe','rest_v1',$1,'Fixture mapping field',$2) returning id", ["m2.test.f" + Date.now(), platform]);
    const evidenceRef = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
    field.revision = await writeRevision(client, {
      fieldId: field.id, by: platform, evidenceRef, unit: "s", unitRef: evidenceRef, meaning: true, meaningRef: evidenceRef,
    });
    const input = { requestKey: key(), sourceMetricId: field.id, metricDefinitionId: own };
    const digest = async () => (await client.query("select (select count(*) from training_load.source_metric_mappings) as mappings,"
      + " (select count(*) from training_load.source_metric_mapping_versions) as versions,"
      + " (select count(*) from training_load.source_metric_audit) as receipts")).rows[0];
    const before = await digest();
    const deny = async (path, body) => {
      const result = await post(cookie, path, body);
      assert.deepEqual([result.status, result.body], [404, { error: "notFound" }]);
    };
    await deny("/mappings", input);
    assert.deepEqual(await digest(), before);
    await stage(client);
    await deny("/mappings", { ...input, metricDefinitionId: foreign });
    await deny("/mappings", { ...input, metricDefinitionId: key() });
    const created = await post(cookie, "/mappings", input);
    assert.equal(created.status, 201, created.text);
    const versionPath = "/mappings/" + created.body.mapping.id + "/versions";
    const versionInput = { requestKey: key(), sourceRevisionId: field.revision, appliesToSession: true, appliesToDrill: false };
    const version = await post(cookie, versionPath, versionInput);
    assert.equal(version.status, 201, version.text);
    const submitPath = versionPath + "/" + version.body.version.id + "/submit";
    const submitInput = { requestKey: key() };
    const service = await import("../src/sourceMetricMappingService.js");
    service.setMappingCommitForTests({
      fault: async tx => {
        await tx.query("commit");
        throw Object.assign(new Error("reply lost"), { code: "ECONNRESET" });
      },
      checkFault: () => move(native),
    });
    try {
      await deny(submitPath, submitInput);
    } finally {
      service.setMappingCommitForTests();
    }
    await client.query("update public.user_workspace_preferences set scope_id=$1 where user_id=$2", [clubA, native]);
    const submitted = await post(cookie, submitPath, submitInput);
    assert.equal(submitted.status, 200, submitted.text);
    assert.equal(submitted.body.version.status, "needs_review");
    assert.equal(submitted.body.replayed, true);
    const checked = await digest();
    await move(native);
    await deny("/mappings", input);
    await deny(versionPath, versionInput);
    await deny(submitPath, submitInput);
    assert.deepEqual(await digest(), checked);
    await client.query("update public.user_workspace_preferences set scope_id=$1 where user_id=$2", [clubA, native]);
    const { rows: [{ pid }] } = await client.query("select pg_backend_pid() as pid");
    await client.query("begin");
    let pending;
    try {
      await client.query("select id from training_load.source_metric_definitions where id=$1 for update", [field.id]);
      pending = post(cookie, "/mappings", { ...input, requestKey: key() });
      const deadline = Date.now() + 1500;
      let queued = false;
      while (!queued && Date.now() < deadline) {
        const { rows: [row] } = await client.query("select exists(select 1 from pg_locks where not granted and $1=any(pg_blocking_pids(pid))) as waiting", [pid]);
        queued = row.waiting;
        if (!queued) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(queued, true, "writer queued at its original field lock");
      await move(native);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      await pending;
      throw error;
    }
    const switched = await pending;
    assert.deepEqual([switched.status, switched.body], [404, { error: "notFound" }]);
    assert.deepEqual(await digest(), checked);
  } finally {
    try { await server?.stop(); } finally { await db.drop(); }
  }
});
