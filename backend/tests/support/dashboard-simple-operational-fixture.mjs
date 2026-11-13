import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { createSimpleV50Database } from './dashboard-simple-backup-fixture.mjs';

export async function operationalFixture(t, { pages = false } = {}) {
  const originalUrl = process.env.DATABASE_URL;
  const originalMax = process.env.PG_POOL_MAX;
  const db = await createSimpleV50Database(originalUrl);
  let pool, server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end();
    process.env.DATABASE_URL = originalUrl;
    if (originalMax === undefined) delete process.env.PG_POOL_MAX;
    else process.env.PG_POOL_MAX = originalMax;
    await db.drop();
  });
  process.env.DATABASE_URL = db.url;
  process.env.PG_POOL_MAX = '5';
  ({ pool } = await import('../../src/db.js'));
  assert.equal((await pool.query('select current_database() as name')).rows[0].name, db.name);
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
  const local = express();
  server = http.createServer(local);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const user = await one("insert into public.users(email, first_name, last_name, full_name, display_name) values ($1,'Simple','Local','Simple v50','Simple v50') returning id", [`simple-${crypto.randomUUID()}@test.local`]);
  await pool.query("insert into public.user_global_roles(user_id,role) values ($1,'platform_admin')", [user.id]);
  await pool.query("insert into public.user_workspace_preferences(user_id,workspace_type) values ($1,'platform')", [user.id]);
  const club = await one("insert into public.clubs(name) values ('Simple v50') returning id");
  const team = await one("insert into public.teams(club_id,name) values ($1,'Simple v50') returning id", [club.id]);
  await pool.query("insert into public.user_team_roles(user_id,team_id,role) values ($1,$2,'team_coach')", [user.id, team.id]);
  const { createSession } = await import('../../src/auth.js');
  const dashboard = await one("select * from training_load.create_dashboard('S7b synthetic',null,'team',null,null,$1,'team',$1,false,$2)", [team.id, user.id]);
  const athlete = await one("insert into public.athletes(athlete_id,first_name,last_name,full_name,display_name) values ('S2C-LOCAL-ONLY','Historical','Local','Historical','Historical') returning id");
  await pool.query("insert into public.athlete_memberships(athlete_id,club_id,team_id,membership_type) values ($1,$2,$3,'team')", [athlete.id, club.id, team.id]);
  const activity = await one("insert into training.activities(activity_type_key,name,occurred_local_date,started_at,timezone_snapshot,owner_scope,owner_team_id,origin,lifecycle_state,created_by_user_id) values ('training_session','Historical','2026-10-28','2026-10-28T09:00:00Z','Europe/Belgrade','team',$1,'manual','confirmed',$2) returning id", [team.id, user.id]);
  await pool.query("insert into training.activity_participants(activity_id,athlete_id,local_date,timezone_snapshot,participation_status) values ($1,$2,'2026-10-28','Europe/Belgrade','participated')", [activity.id, athlete.id]);
  const coach = await one("insert into public.users(email,first_name,last_name,full_name) values ($1,'Operational','Coach','Operational Coach') returning id", [`operational-${crypto.randomUUID()}@test.local`]);
  await pool.query("insert into public.user_team_roles(user_id,team_id,role) values ($1,$2,'team_coach')", [coach.id, team.id]);
  await pool.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values ($1,'team',$2)", [coach.id, team.id]);
  const coachCookie = `optimove_session=${await createSession(coach.id)}`;
  const { authMiddleware, attachAuthorizationContext, requireAuth } = await import('../../src/auth.js');
  const { queryDashboard } = await import('../../src/trainingLoadDashboardQuery.js');
  const { createSimplePreviewService } = await import('../../src/dashboardSimple/previewService.js');
  const { createSimpleSaveService } = await import('../../src/dashboardSimple/saveService.js');
  const { createPreviewTokenService } = await import('../../src/dashboardSimple/previewTokens.js');
  const { createPreviewAdmission, createPreviewAdmissionCoordinator } = await import('../../src/dashboardSimple/previewAdmission.js');
  const { createSimplePreviewRouter } = await import('../../src/dashboardSimple/previewRouter.js');
  const { createSimpleSaveRouter } = await import('../../src/dashboardSimple/saveRouter.js');
  const admission = createPreviewAdmission({ coordinator: createPreviewAdmissionCoordinator({ maxActiveDeployment: 2 }), processId: 'operational', poolMax: 5 });
  let preview, save;
  const key = crypto.randomBytes(32);
  function restart(config = { keyId: 'old', key }) {
    const tokenService = createPreviewTokenService(config);
    preview = createSimplePreviewService({ pool, queryDashboard, admission, tokenService, activation: { coordinatedAdmissionVerified: true, deploymentBudgetVerified: true, atomicSaveVerified: true } });
    save = createSimpleSaveService({ pool, tokenService, activation: { atomicSaveVerified: true } });
    return tokenService;
  }
  restart();
  const forward = (get, methods) => Object.fromEntries(methods.map(method => [method, (...args) => get()[method](...args)]));
  local.use('/operational/:dashboardId', authMiddleware, attachAuthorizationContext, requireAuth,
    createSimplePreviewRouter({ service: forward(() => preview, ['capabilities','metrics','validate','preview']) }),
    createSimpleSaveRouter({ service: forward(() => save, ['save','status']) }));
  const pagesBase = `/pages/${dashboard.id}`;
  if (pages) {
    const { authorizePages: authorize, assertPageFilterVisible: assertFilterVisible } = await import('../../src/dashboardPages/access.js');
    const { createPagesService } = await import('../../src/dashboardPages/service.js');
    const { createPagesRouter } = await import('../../src/dashboardPages/router.js');
    const { createPageAdvancedService } = await import('../../src/dashboardPages/advancedService.js');
    const { createPageAdvancedRouter } = await import('../../src/dashboardPages/advancedRouter.js');
    const auth = [authMiddleware, attachAuthorizationContext, requireAuth];
    local.use('/pages/:dashboardId/:pageId/advanced', ...auth,
      createPageAdvancedRouter({ service: createPageAdvancedService({ pool, authorize, assertFilterVisible }) }));
    local.use('/pages/:dashboardId', ...auth,
      createPagesRouter({ service: createPagesService({ pool, authorize, queryDashboard, assertFilterVisible }) }));
  }
  const period = { dateFrom: '2026-10-22', dateTo: '2026-10-29', timeZone: 'Europe/Belgrade' };
  async function request(route, body, method = 'POST', selectedCookie = coachCookie) {
    const res = await fetch(`${origin}${route}`, { method, signal: AbortSignal.timeout(12000), headers: { Cookie: selectedCookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json(), retryAfter: res.headers.get('retry-after') };
  }
  const base = `/operational/${dashboard.id}`;
  return { pool, one, team, athlete, coach, base, pagesBase, request, period };
}
