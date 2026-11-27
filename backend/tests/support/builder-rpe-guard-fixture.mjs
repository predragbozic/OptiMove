import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSession } from "../../src/auth.js";
import { createPagesDatabase } from "./dashboard-pages-db.mjs";
import { previousDashboardServer } from "./dashboard-pages-old-server.mjs";
import { fixtures } from "./permission-roles-world.mjs";

export const PRE_V106_BUILD = "4d7d0ced4f9f2eb5f2eb8d9b726295282d7e0555";

export async function builderRpeFixtureApi(server, cookie, path, { method = "GET", body } = {}) {
  const response = await fetch(server.baseUrl + path, {
    method,
    headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const expect = ({ status, body }, expected) => {
  assert.equal(status, expected, JSON.stringify(body));
  return body;
};

export async function createBuilderRpeFixtureDraft(api, athleteCode, weekStart, { enable = false } = {}) {
  let draft = expect(await api("/api/builder/plans", {
    method: "POST", body: { planType: "weekly", weekStart, athleteIds: [athleteCode], name: "RPE rollout fixture" },
  }), 201);
  const id = draft.plan.id;
  draft = expect(await api(`/api/builder/blocks/${draft.blocks[0].id}/sessions`, {
    method: "POST", body: { name: "Fixture session", bta: "T" },
  }), 201);
  const sessionId = draft.blocks[0].sessions[0].id;
  expect(await api(`/api/builder/sessions/${sessionId}/nodes`, {
    method: "POST", body: { nodeType: "domain", name: "Retained training content" },
  }), 201);
  if (enable) await enableBuilderRpeFixtureDraft(api, id, sessionId);
  return { id, sessionId };
}

// This is an explicit settings request in the fixture. It does not infer or reset a stored value.
export async function enableBuilderRpeFixtureDraft(api, planId, sessionId) {
  expect(await api(`/api/builder/plans/${planId}/training-load-settings`, {
    method: "PATCH", body: { trackTrainingLoadDefault: true, requestRpeDefault: true },
  }), 200);
  expect(await api(`/api/builder/sessions/${sessionId}`, {
    method: "PATCH", body: { trackingEnabled: true, rpeEnabled: true },
  }), 200);
}

export async function snapshotBuilderRpeFixture(client, planIds, athleteUserId) {
  const { rows: [snapshot] } = await client.query(`
    select
      (select coalesce(jsonb_agg(p order by p.id),'[]') from plans.plans p where p.id=any($1::uuid[])) as plans,
      (select coalesce(jsonb_agg(d order by d.id),'[]') from plans.plan_days d where d.plan_id=any($1::uuid[])) as days,
      (select coalesce(jsonb_agg(s order by s.id),'[]') from plans.plan_sessions s join plans.plan_days d on d.id=s.plan_day_id where d.plan_id=any($1::uuid[])) as sessions,
      (select coalesce(jsonb_agg(n order by n.id),'[]') from plans.plan_nodes n join plans.plan_sessions s on s.id=n.plan_session_id join plans.plan_days d on d.id=s.plan_day_id where d.plan_id=any($1::uuid[])) as nodes,
      (select coalesce(jsonb_agg(i order by i.id),'[]') from plans.plan_items i join plans.plan_sessions s on s.id=i.plan_session_id join plans.plan_days d on d.id=s.plan_day_id where d.plan_id=any($1::uuid[])) as items,
      (select coalesce(jsonb_agg(o order by o.plan_id),'[]') from training_load.plan_workspace_ownership o where o.plan_id=any($1::uuid[])) as owners,
      (select coalesce(jsonb_agg(b order by b.plan_id),'[]') from training_load.builder_rpe_plan_baselines b where b.plan_id=any($1::uuid[])) as plan_baselines,
      (select coalesce(jsonb_agg(b order by b.plan_id,b.session_id),'[]') from training_load.builder_rpe_session_baselines b where b.plan_id=any($1::uuid[])) as session_baselines,
      (select coalesce(jsonb_agg(e order by e.plan_id),'[]') from training_load.builder_rpe_plan_effects e where e.plan_id=any($1::uuid[])) as plan_effects,
      (select coalesce(jsonb_agg(e order by e.plan_id,e.session_id),'[]') from training_load.builder_rpe_session_effects e where e.plan_id=any($1::uuid[])) as session_effects,
      (select coalesce(jsonb_agg(u order by u.singleton),'[]') from training_load.builder_rpe_provenance_use u) as first_use,
      (select coalesce(jsonb_agg(n order by n.id),'[]') from public.app_notifications n where n.recipient_user_id=$2) as notifications
  `, [planIds, athleteUserId]);
  return snapshot;
}

export async function withBuilderRpeGuardFixture(exercise, { predecessor = PRE_V106_BUILD } = {}) {
  const db = await createPagesDatabase({ through: "202612071000", label: "builder_rpe_guard" });
  const { client } = db;
  let old;
  try {
    const f = fixtures(client);
    const club = await f.club("Guard fixture club");
    const team = await f.team(club, "Owning team");
    const otherTeam = await f.team(club, "Other team");
    const owner = await f.user("Owning coach");
    const otherCoach = await f.user("Other coach");
    const platform = await f.user("Guard fixture admin");
    const athleteUser = await f.user("Guard fixture athlete");
    await f.grantTeam(owner, team);
    await f.grantTeam(otherCoach, otherTeam);
    await f.grantPlatform(platform);
    await client.query(`insert into public.user_workspace_preferences(user_id,workspace_type,scope_id)
      values($1,'team',$2),($3,'team',$4),($5,'platform',null)`, [owner, team, otherCoach, otherTeam, platform]);

    const athleteCode = "rg" + randomUUID().replaceAll("-", "");
    const { rows: [athlete] } = await client.query(`insert into public.athletes
      (user_id,athlete_id,source_external_id,first_name,last_name,full_name,display_name,is_active)
      values($1,$2,$2,'Guard','Athlete','Guard Athlete','Guard Athlete',true) returning id`, [athleteUser, athleteCode]);
    await client.query(`insert into public.athlete_memberships(athlete_id,membership_type,club_id,team_id,status)
      values($1,'club',$2,null,'active'),($1,'team',$2,$3,'active')`, [athlete.id, club, team]);

    const cookie = async (id) => `optimove_session=${await createSession(id, client)}`;
    const cookies = { owner: await cookie(owner), otherCoach: await cookie(otherCoach), platform: await cookie(platform) };
    old = await previousDashboardServer(db.url, {}, predecessor);
    assert.equal(old.commit, predecessor);
    const oldApi = (path, options) => builderRpeFixtureApi(old, cookies.owner, path, options);
    const before = await createBuilderRpeFixtureDraft(oldApi, athleteCode, "2027-04-05", { enable: true });
    const saved = await createBuilderRpeFixtureDraft(oldApi, athleteCode, "2027-04-12");
    expect(await oldApi(`/api/builder/plans/${saved.id}/submit`, { method: "POST" }), 200);

    await db.applyThrough("202612081000");
    const during = await createBuilderRpeFixtureDraft(oldApi, athleteCode, "2027-04-19", { enable: true });
    const off = await createBuilderRpeFixtureDraft(oldApi, athleteCode, "2027-04-26");
    const edit = expect(await oldApi(`/api/builder/plans/${saved.id}/edit`, { method: "POST" }), 200);
    const editDraft = { id: edit.plan.id, sessionId: edit.blocks[0].sessions[0].id };
    await enableBuilderRpeFixtureDraft(oldApi, editDraft.id, editDraft.sessionId);

    const stopPrevious = async () => {
      if (!old) return;
      await old.stop();
      old = null;
    };
    return await exercise({
      db, oldApi, stopPrevious, predecessor, club, team, otherTeam, owner, athleteCode, athleteId: athlete.id, cookies,
      cases: { before, during, off, saved, editDraft },
      snapshot: (ids) => snapshotBuilderRpeFixture(client, ids, athleteUser),
    });
  } finally {
    try { await old?.stop(); } finally { await db.drop(); }
  }
}
