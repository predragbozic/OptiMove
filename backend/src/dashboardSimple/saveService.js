import { createHash } from 'node:crypto';
import { isUuid } from './schema.js';
import { canonicalKey, compileSimpleDraft } from './compiler.js';
import { createSimpleCapabilityReader } from './capabilities.js';
import { authorizePreviewTarget, loadPreviewExisting, loadPreviewContext } from './previewContext.js';
import { buildSimplePreviewBinding } from './previewBinding.js';
import { canManageDashboardRow, dataWorkspaceMatches } from '../trainingLoadDashboardAccess.js';
import { withPreviewTransaction, previewError } from './previewTransaction.js';
import { runSimpleSaveTransaction } from './saveTransaction.js';
import { validateSimpleSaveRequest, simpleSavePayloadHash, SIMPLE_REQUEST_WINDOW_MS } from './saveRequest.js';

async function lockActor(queryRunner, req) {
  const userId = req.user.id;
  await queryRunner('select id from public.users where id=$1 for share', [userId]);
  if (req.sessionToken) await queryRunner('select user_id from public.auth_sessions where user_id=$1 and token_hash=$2 for share', [userId, createHash('sha256').update(String(req.sessionToken)).digest('base64url')]);
  for (const table of ['user_global_roles', 'user_club_roles', 'user_team_roles', 'user_workspace_preferences']) {
    await queryRunner(`select user_id from public.${table} where user_id=$1 for share`, [userId]);
  }
}

async function authorizeSaveTarget(queryRunner, req, dashboardId) {
  try { return await authorizePreviewTarget(queryRunner, req, dashboardId, { requireWritable: false }); }
  catch (error) { if (error?.code === 'workspaceSelectionRequired') throw previewError('notFound', 404); throw error; }
}

async function lockCatalog(queryRunner, envelope, existing) {
  const metricIds = [...new Set([envelope.draft.metricRef.metricDefinitionId, ...((existing?.series ?? []).map(series => series.metric_definition_id))].filter(Boolean))].sort();
  if (metricIds.length) {
    await queryRunner('select id from training_load.metric_definitions where id=any($1::uuid[]) order by id for share', [metricIds]);
    await queryRunner('select version.id from training_load.metric_definition_versions version join training_load.metric_definitions metric on metric.current_version_id=version.id where metric.id=any($1::uuid[]) order by version.id for share of version', [metricIds]);
  }
  const sourceIds = [...new Set((existing?.series ?? []).map(series => series.source_connection_id).filter(Boolean))].sort();
  if (sourceIds.length) await queryRunner('select id from training_load.metric_source_connections where id=any($1::uuid[]) order by id for share', [sourceIds]);
  await queryRunner('select key from training_load.dashboard_widget_types where key=$1 for share', [envelope.draft.view.type]);
  if (envelope.draft.metricRef.kind === 'builtin') await queryRunner('select key from training_load.dashboard_builtin_series where key=$1 for share', [envelope.draft.metricRef.key]);
}

function stableSaveError(error) {
  const codes = { S2C01: ['idempotencyConflict', 409], S2C02: ['invalidDraft', 400], S2C03: ['advancedRequired', 409], S2C04: ['advancedRequired', 409], S2C05: ['invalidRequest', 400], S2C06: ['requestExpired', 409], S2C07: ['notFound', 404], '40001': ['staleRevision', 409], '40002': ['dashboardArchived', 409], '23514': ['catalogChanged', 409], '23503': ['catalogChanged', 409] };
  return codes[error?.code] ? previewError(...codes[error.code]) : error;
}

export function createSimpleSaveService({ pool, tokenService, now = () => Date.now(), activation = {}, transactionOptions = {} }) {
  if (!pool || typeof pool.connect !== 'function' || typeof now !== 'function') throw new TypeError('Server-owned save dependencies required');
  const currentTime = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw previewError('saveUnavailable');
    return value;
  };
  async function recorded(queryRunner, target, requestId, payloadHash) {
    const row = (await queryRunner('select * from training_load.dashboard_simple_requests where initiator_user_id=$1 and request_id=$2', [target.req.user.id, requestId])).rows[0];
    if (!row) return null;
    if (row.dashboard_id !== target.dashboard.id || canonicalKey(row.workspace) !== canonicalKey(target.workspace) || payloadHash && row.payload_hash !== payloadHash) {
      throw previewError(payloadHash ? 'idempotencyConflict' : 'notFound', payloadHash ? 409 : 404);
    }
    if (currentTime() > new Date(row.retain_until).getTime()) throw previewError('requestExpired', 409);
    const widgetId = row.receipt?.widgetId;
    if (!isUuid(widgetId) || !(await queryRunner('select id from training_load.dashboard_widgets where id=$1 and dashboard_id=$2', [widgetId, target.dashboard.id])).rows.length) throw previewError('notFound', 404);
    return row.receipt;
  }
  const readOnly = (operation, budget = 5000) => {
    const checkout = Math.min(1000, Math.max(1, Math.floor(budget / 4)));
    return withPreviewTransaction({ pool, checkoutTimeoutMs: checkout, transactionTimeoutMs: Math.max(1, budget - checkout - 500), statementTimeoutMs: Math.min(3000, Math.max(1, budget - checkout - 500)) }, operation);
  };
  async function status({ req, dashboardId, body }) {
    if (!isUuid(req?.user?.id) || !isUuid(dashboardId)) throw previewError('notFound', 404);
    return readOnly(async queryRunner => {
      const target = await authorizeSaveTarget(queryRunner, req, dashboardId);
      if (!body || Object.keys(body).length !== 1 || !isUuid(body.requestId)) throw previewError('invalidRequest', 400);
      const receipt = await recorded(queryRunner, target, body.requestId);
      return receipt ? { status: 'recorded', requestId: body.requestId, receipt } : { status: 'notRecorded', requestId: body.requestId, retrySameRequest: true };
    });
  }
  async function save({ req, dashboardId, widgetId = null, body }) {
    if (!isUuid(req?.user?.id) || !isUuid(dashboardId)) throw previewError('notFound', 404);
    if (!isUuid(body?.requestId)) throw previewError('invalidRequest', 400);
    let payloadHash;
    const verify = () => readOnly(async queryRunner => {
      const target = await authorizeSaveTarget(queryRunner, req, dashboardId);
      return recorded(queryRunner, target, body.requestId, payloadHash);
    }, transactionOptions.recoveryTimeoutMs ?? 5000);
    try {
      return await runSimpleSaveTransaction({ ...transactionOptions, pool, requestId: body.requestId, verify, write: async queryRunner => {
        await queryRunner('select pg_advisory_xact_lock(hashtextextended($1,0))', [`dashboard-simple:${req.user.id.toLowerCase()}:${body.requestId.toLowerCase()}`]);
        await lockActor(queryRunner, req);
        await authorizeSaveTarget(queryRunner, req, dashboardId);
        await queryRunner('select id from training_load.dashboards where id=$1 for update', [dashboardId]);
        const target = await authorizeSaveTarget(queryRunner, req, dashboardId);
        const editTarget = body.input?.editTarget;
        for (const candidate of [...new Set([widgetId, editTarget?.widgetId].filter(value => value != null))]) {
          if (!isUuid(candidate)) throw previewError('notFound', 404);
          if (!(await queryRunner('select id from training_load.dashboard_widgets where id=$1 and dashboard_id=$2 for update', [candidate, dashboardId])).rows.length) throw previewError('notFound', 404);
        }
        validateSimpleSaveRequest(body);
        if ((widgetId?.toLowerCase() ?? null) !== (editTarget?.widgetId?.toLowerCase() ?? null)) throw previewError('invalidRequest', 400);
        payloadHash = simpleSavePayloadHash({ userId: req.user.id, dashboardId, body });
        const receipt = await recorded(queryRunner, target, body.requestId, payloadHash);
        if (receipt) return { receipt, replayed: true };
        if (activation.atomicSaveVerified !== true) throw previewError('saveUnavailable');
        if (target.dashboard.status !== 'active') throw previewError('dashboardArchived', 409);
        if (target.dashboard.is_template) throw previewError('templateRequiresClone', 409);
        const age = currentTime() - Date.parse(body.requestIssuedAt);
        if (age > SIMPLE_REQUEST_WINDOW_MS) throw previewError('requestExpired', 409);
        if (age < -1000) throw previewError('invalidRequest', 400);
        if (!tokenService || typeof tokenService.verifyEnvelope !== 'function') throw previewError('previewRequired', 409, 'keyUnavailable');
        const signed = tokenService.verifyEnvelope(body.previewToken);
        if (body.requestIssuedAt !== signed.requestIssuedAt) throw previewError('previewRequired', 409, 'requestTimeChanged');
        if (canonicalKey(body.resolvedPeriod) !== canonicalKey(signed.binding.resolvedPeriod)) throw previewError('previewRequired', 409, 'effectivePeriodChanged');
        if (body.input.context.kind !== 'legacyDashboard') throw previewError('pagesClientRequired', 409);
        if (widgetId) await queryRunner('select id from training_load.dashboard_widget_series where widget_id=$1 order by id for update', [widgetId]);
        const existing = await loadPreviewExisting(queryRunner, dashboardId, editTarget);
        if (existing && existing.revision !== editTarget.expectedWidgetRevision) throw previewError('staleRevision', 409);
        await lockCatalog(queryRunner, body.input, existing);
        const reader = createSimpleCapabilityReader({ query: queryRunner, canManageDashboardRow, dataWorkspaceMatches });
        const snapshot = await reader.load({ req: target.req, dataWorkspace: target.workspace, dashboardId, metricRef: body.input.draft.metricRef, sourceConnectionId: existing?.series[0]?.source_connection_id ?? null });
        const context = await loadPreviewContext(queryRunner, target, body.input, existing, new Date(currentTime()).toISOString());
        const compiled = compileSimpleDraft(body.input.draft, snapshot, context, existing);
        if (compiled.status !== 'valid') throw Object.assign(previewError(compiled.status === 'advancedRequired' ? 'advancedRequired' : 'invalidDraft', compiled.status === 'advancedRequired' ? 409 : 400), { issues: compiled.issues });
        if (compiled.widget.presentation_config?.tableFormatting?.rules?.length) throw previewError('invalidDraft', 400);
        if (body.input.expectedCatalogToken && body.input.expectedCatalogToken !== compiled.catalogToken) throw previewError('catalogChanged', 409);
        const binding = buildSimplePreviewBinding({ target, envelope: body.input, existing, compiled, context, evaluatedAt: signed.binding.evaluatedAt });
        tokenService.verify(body.previewToken, binding);
        const result = await queryRunner('select training_load.save_simple_widget($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::uuid,$6::uuid,$7::integer,$8::jsonb,$9::jsonb,$10::jsonb) as receipt', [req.user.id, body.requestId, payloadHash, body.requestIssuedAt, dashboardId, widgetId, editTarget?.expectedWidgetRevision ?? null, JSON.stringify(compiled.widget), JSON.stringify(compiled.resolvedPeriod), JSON.stringify(target.workspace)]);
        if (!result.rows[0]?.receipt) throw previewError('saveFailed');
        return { receipt: result.rows[0].receipt, replayed: false };
      } });
    } catch (error) { throw stableSaveError(error); }
  }
  return { save, status };
}
