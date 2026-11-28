import { randomBytes } from "node:crypto";
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
    await client.query("create table training_load.mappings_manage_bridge_use (singleton boolean primary key, first_checked_write_at timestamptz)");
    await client.query("insert into training_load.mappings_manage_bridge_use(singleton) values(true)");
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
    const usedAt = async () => (await client.query("select first_checked_write_at from training_load.mappings_manage_bridge_use")).rows[0].first_checked_write_at;
    await deny("/mappings", { ...input, metricDefinitionId: foreign });
    await deny("/mappings", { ...input, metricDefinitionId: key() });
    assert.equal(await usedAt(), null);
    // The normal mapping and ledger insert run; a deferred test guard then
    // makes PostgreSQL itself reject COMMIT, including the first-use marker.
    await client.query("create function training_load.fixture_fail_mapping_commit() returns trigger language plpgsql as $body$"
      + " begin raise exception 'fixture deferred mapping failure' using errcode='23514'; end $body$");
    await client.query("create constraint trigger fixture_fail_mapping_commit after insert on training_load.source_metric_audit"
      + " deferrable initially deferred for each row execute function training_load.fixture_fail_mapping_commit()");
    try {
      const failed = await post(cookie, "/mappings", input);
      assert.ok(failed.status >= 400, failed.text);
      assert.deepEqual(await digest(), before);
      assert.equal(await usedAt(), null);
    } finally {
      await client.query("drop trigger fixture_fail_mapping_commit on training_load.source_metric_audit");
      await client.query("drop function training_load.fixture_fail_mapping_commit()");
    }
    const created = await post(cookie, "/mappings", input);
    assert.equal(created.status, 201, created.text);
    const firstUsed = await usedAt();
    assert.ok(firstUsed instanceof Date);
    const mappingReplay = await post(cookie, "/mappings", input);
    assert.equal(mappingReplay.body.replayed, true);
    assert.deepEqual(await usedAt(), firstUsed);
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

    await client.query("update public.user_workspace_preferences set workspace_type='club',scope_id=$1 where user_id=any($2::uuid[])", [clubA, [native, platform]]);
    const binding = async (club, sourceTeam) => {
      const team = await f.team(club);
      const { rows: [connection] } = await client.query("insert into training_load.source_credential_connections"
        + " (source_system,owner_scope,owner_club_id,host_key,account_label,credential_kind,created_by_user_id,state,"
        + " credential_ciphertext,credential_nonce,credential_auth_tag,credential_key_version,last_verified_at)"
        + " values ('gpexe','club',$1,'server3','Fixture','exchanged_token',$2,'verified',$3,$4,$5,1,now()) returning id",
      [club, platform, randomBytes(24), randomBytes(12), randomBytes(16)]);
      await client.query("insert into training_load.gpexe_team_settings (owner_team_id,gpexe_team_id,configured_by_user_id) values ($1,$2,$3)", [team, sourceTeam, platform]);
      const { rows: [saved] } = await client.query("insert into training_load.source_team_bindings"
        + " (team_id,connection_id,source_system,source_team_id,bound_by_user_id,legacy_gpexe_settings_team_id)"
        + " values ($1,$2,'gpexe',$3,$4,$1) returning id", [team, connection.id, sourceTeam, platform]);
      return saved.id;
    };
    const ownBinding = await binding(clubA, "960101"), foreignBinding = await binding(clubB, "960102");
    const versionResource = versionPath + "/" + version.body.version.id;
    const activationRequest = { requestKey: key(), expectedActiveVersionId: null };
    const nativeAttempt = await post(cookie, versionResource + "/activate", activationRequest);
    assert.deepEqual([nativeAttempt.status, nativeAttempt.body.error], [409, "confirmation_required"]);
    const platformActivated = await post(operator, versionResource + "/activate", activationRequest);
    assert.equal(platformActivated.status, 200, platformActivated.text);
    const start = (bindingId, requestKey = key()) => ({
      requestKey, mappingId: created.body.mapping.id, versionId: version.body.version.id,
      bindings: [{ bindingId, requirement: "required" }], reason: "Fixture start.",
    });
    const beforeActivations = await digest();
    await deny("/activations", start(foreignBinding));
    await deny("/activations", start(key()));
    assert.deepEqual(await digest(), beforeActivations);
    const startInput = start(ownBinding);
    const started = await post(cookie, "/activations", startInput);
    assert.equal(started.status, 201, started.text);
    const activation = started.body.activations[0];
    assert.equal(activation.bindingId, ownBinding);
    await move(native);
    const endBody = { requestKey: key(), expectedState: "open", reason: "Fixture end." };
    const endPath = "/activations/" + activation.id + "/end";
    await deny("/activations", startInput);
    await deny(endPath, endBody);
    await deny("/activations/" + key() + "/end", endBody);
    const switchInput = { ...endBody, requestKey: key(), toVersionId: version.body.version.id };
    await deny("/activations/" + activation.id + "/switch-to-copy", switchInput);
    await deny("/activations/" + key() + "/switch-to-copy", switchInput);
    await client.query("update public.user_workspace_preferences set scope_id=$1 where user_id=$2", [clubA, native]);
    const beforeRevocation = await digest();
    await client.query("begin");
    try {
      await client.query("select id from training_load.source_metric_mapping_activations where id=$1 for update", [activation.id]);
      pending = post(cookie, endPath, endBody);
      const deadline = Date.now() + 1500;
      let queued = false;
      while (!queued && Date.now() < deadline) {
        const { rows: [row] } = await client.query("select exists(select 1 from pg_locks where not granted and $1=any(pg_blocking_pids(pid))) as waiting", [pid]);
        queued = row.waiting;
        if (!queued) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(queued, true, "end queued at the activation before checking live club authority");
      await client.query("update public.user_club_roles set is_active=false where user_id=$1 and club_id=$2", [native, clubA]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      await pending;
      throw error;
    }
    const revoked = await pending;
    assert.deepEqual([revoked.status, revoked.body], [404, { error: "notFound" }]);
    assert.deepEqual(await digest(), beforeRevocation);
    await client.query("update public.user_club_roles set is_active=true where user_id=$1 and club_id=$2", [native, clubA]);
    const ended = await post(cookie, endPath, endBody);
    assert.equal(ended.status, 200, ended.text);
    assert.equal(ended.body.activation.id, activation.id);
    assert.ok(ended.body.activation.endedAt);
    assert.equal((await post(cookie, endPath, endBody)).body.replayed, true);
    const disabled = await post(cookie, versionResource + "/disable", { requestKey: key(), expectedStatus: "active", reason: "Fixture disable." });
    assert.equal(disabled.status, 200, disabled.text);
    assert.equal(disabled.body.version.status, "disabled");

    await client.query("update public.user_workspace_preferences set workspace_type='platform',scope_id=null where user_id=$1", [platform]);
    const systemVariable = await variable("System switch metric");
    const systemMapping = await post(operator, "/mappings", { ...input, requestKey: key(), metricDefinitionId: systemVariable });
    assert.equal(systemMapping.status, 201, systemMapping.text);
    const systemMappingId = systemMapping.body.mapping.id;
    const systemVersions = "/mappings/" + systemMappingId + "/versions";
    const systemDraft = await post(operator, systemVersions, { ...versionInput, requestKey: key() });
    assert.equal(systemDraft.status, 201, systemDraft.text);
    const systemVersionId = systemDraft.body.version.id;
    const systemVersionPath = systemVersions + "/" + systemVersionId;
    const reviewed = await post(operator, systemVersionPath + "/submit", { requestKey: key() });
    assert.equal(reviewed.status, 200, reviewed.text);
    const activated = await post(operator, systemVersionPath + "/activate", { ...activationRequest, requestKey: key() });
    assert.equal(activated.status, 200, activated.text);
    const systemStart = bindingId => ({ ...start(bindingId), mappingId: systemMappingId, versionId: systemVersionId });
    await deny("/activations", systemStart(foreignBinding));
    await deny("/activations", systemStart(key()));
    const systemStarted = await post(cookie, "/activations", systemStart(ownBinding));
    assert.equal(systemStarted.status, 201, systemStarted.text);
    assert.equal(systemStarted.body.activations[0].bindingId, ownBinding);
    await client.query("update public.user_workspace_preferences set workspace_type='club',scope_id=$1 where user_id=$2", [clubA, platform]);
    const { rows: [{ current_version_id }] } = await client.query("select current_version_id from training_load.metric_definitions where id=$1", [systemVariable]);
    const copied = await post(operator, "/variables/" + systemVariable + "/copy", { requestKey: key(), expectedSourceVersionId: current_version_id });
    assert.equal(copied.status, 201, copied.text);
    const { rows: [draft] } = await client.query("select l.club_version_id,v.mapping_id from training_load.source_metric_mapping_version_copies l"
      + " join training_load.source_metric_mapping_versions v on v.id=l.club_version_id where v.metric_definition_id=$1", [copied.body.variable.id]);
    const copiedPath = "/mappings/" + draft.mapping_id + "/versions/" + draft.club_version_id;
    const copySubmitted = await post(operator, copiedPath + "/submit", { requestKey: key() });
    assert.equal(copySubmitted.status, 200, copySubmitted.text);
    const copyActivated = await post(operator, copiedPath + "/activate", { ...activationRequest, requestKey: key() });
    assert.equal(copyActivated.status, 200, copyActivated.text);
    const ownSwitchPath = "/activations/" + systemStarted.body.activations[0].id + "/switch-to-copy";
    const ownSwitchBody = { ...endBody, requestKey: key(), toVersionId: draft.club_version_id };
    const switchedToCopy = await post(cookie, ownSwitchPath, ownSwitchBody);
    assert.equal(switchedToCopy.status, 200, switchedToCopy.text);
    assert.equal(switchedToCopy.body.activation.bindingId, ownBinding);
    assert.equal(switchedToCopy.body.activation.versionId, draft.club_version_id);
    assert.equal(switchedToCopy.body.ended.id, systemStarted.body.activations[0].id);
    assert.equal((await post(cookie, ownSwitchPath, ownSwitchBody)).body.replayed, true);
    await move(native);
    await deny(ownSwitchPath, ownSwitchBody);
    assert.deepEqual(await usedAt(), firstUsed);
  } finally {
    try { await server?.stop(); } finally { await db.drop(); }
  }
});
