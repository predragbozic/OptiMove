import { createHash, randomUUID } from 'node:crypto';
import { validateContract, isUuid } from './schema.js';
import { compileSimpleDraft, canonicalKey } from './compiler.js';
import { createSimpleCapabilityReader } from './capabilities.js';
import { canManageDashboardRow, dataWorkspaceMatches } from '../trainingLoadDashboardAccess.js';
import { authorizePreviewTarget, loadPreviewContext, loadPreviewExisting } from './previewContext.js';
import { previewError, withPreviewTransaction } from './previewTransaction.js';

const hash = value => createHash('sha256').update(canonicalKey(value)).digest('hex');
const responseLimit = 2 * 1024 * 1024;
const issueResult = (status, code, path) => ({ status, issues: [{ code, path, severity: 'error' }] });

export function createSimplePreviewService({ pool, queryDashboard, admission, tokenService, activation = {}, now = () => Date.now(), transactionOptions = {} }) {
  if (!pool || typeof queryDashboard !== 'function') throw new TypeError('Server-owned preview dependencies required');
  const previewEnabled = Boolean(admission && tokenService && activation.coordinatedAdmissionVerified === true && activation.deploymentBudgetVerified === true);
  async function execute(kind, { req, dashboardId, envelope, signal }) {
    if (!req?.user?.id) throw previewError('notFound', 404);
    if (kind === 'preview' && !previewEnabled) throw previewError('previewUnavailable');
    let lease;
    if (kind === 'preview') lease = await admission.tryAcquire({ userId: req.user.id });
    return withPreviewTransaction({ ...transactionOptions, pool, signal, onReleased: () => lease?.release() }, async queryRunner => {
      const target = await authorizePreviewTarget(queryRunner, req, dashboardId);
      if (kind === 'capabilities') {
        const widgetTypes = (await queryRunner('select * from training_load.dashboard_widget_types where is_active=true order by key')).rows;
        const builtins = (await queryRunner('select * from training_load.dashboard_builtin_series where is_active=true order by key')).rows.map(row => ({ ...row, allowed_aggregations: row.value_type === 'numeric' ? ['sum', 'avg', 'max', 'last', 'none'] : ['last', 'none'], source_policy: 'not_applicable' }));
        return { contractVersion: 1, widgetTypes, builtins, capabilities: { preview: previewEnabled, pages: false, presentationAnnotations: false, backendReference: false, referencePercent: false, maxChartAthletes: 20 }, limits: { debounceMs: 350, statementTimeoutMs: 3000, transactionTimeoutMs: 5000, requestBytes: 65536, responseBytes: responseLimit } };
      }
      let existing = null;
      if (envelope?.editTarget != null) {
        if (!isUuid(envelope.editTarget.widgetId)) throw previewError('notFound', 404);
        existing = await loadPreviewExisting(queryRunner, dashboardId, envelope.editTarget);
      }
      const structural = validateContract('envelope', envelope);
      if (!structural.valid) return { status: 'invalid', issues: structural.issues.map(issue => ({ ...issue, severity: 'error' })) };
      if (envelope.context.kind !== 'legacyDashboard') throw previewError('pagesClientRequired', 409);
      if (existing && existing.revision !== envelope.editTarget.expectedWidgetRevision) throw previewError('staleRevision', 409);
      const reader = createSimpleCapabilityReader({ query: queryRunner, canManageDashboardRow, dataWorkspaceMatches });
      const snapshot = await reader.load({ req: target.req, dataWorkspace: target.workspace, dashboardId, metricRef: envelope.draft.metricRef, sourceConnectionId: existing?.series[0]?.source_connection_id ?? null });
      const evaluatedAt = new Date(now()).toISOString();
      const context = await loadPreviewContext(queryRunner, target, envelope, existing, evaluatedAt);
      const compiled = compileSimpleDraft(envelope.draft, snapshot, context, existing);
      if (compiled.status !== 'valid') return { ...compiled, issues: compiled.issues.map(issue => ({ ...issue, severity: 'error' })) };
      if (envelope.expectedCatalogToken && envelope.expectedCatalogToken !== compiled.catalogToken) throw previewError('catalogChanged', 409);
      if (compiled.widget.presentation_config?.tableFormatting?.rules?.length) return issueResult('invalid', 'unsupportedCapability', '$.draft.presentation.tableFormatting');
      const contextFingerprint = hash({ workspace: target.workspace, defaultFilter: target.dashboard.default_filter, runtimeFilter: envelope.context.runtimeFilter ?? {}, effectiveFilter: compiled.effectiveFilter, resolvedPeriod: compiled.resolvedPeriod });
      const draftHash = hash(envelope.draft);
      const common = {
        contractVersion: 1, status: 'valid', issues: [], draftId: envelope.draft.draftId, draftVersion: envelope.draft.draftVersion,
        draftHash, contextFingerprint, catalogToken: compiled.catalogToken, evaluatedAt, resolvedPeriod: compiled.resolvedPeriod,
        effectiveFilterSummary: compiled.effectiveFilter, dashboardRevision: target.dashboard.revision,
        ...(existing ? { widgetRevision: existing.revision } : {}), normalizedWidget: compiled.widget,
        capabilities: { preview: previewEnabled, pages: false, presentationAnnotations: false, backendReference: false, referencePercent: false },
        suggestion: { type: compiled.widget.widget_type, confidence: 'configurationOnly', reasonCode: 'resultProofRequired' },
      };
      if (kind === 'validate') return common;
      if (signal?.aborted) throw previewError('previewAborted', 499);
      const queryWidget = { ...compiled.widget, local_filter_override: compiled.effectiveFilter };
      const results = compiled.effectiveFilter.athleteIds.length
        ? await queryDashboard(target.workspace, [queryWidget], compiled.resolvedPeriod, { queryRunner })
        : [{ widgetId: queryWidget.id, series: [{ widgetId: queryWidget.id, seriesId: queryWidget.series[0].id, status: 'ok', data: { current: [], comparison: null, comparisonRange: null } }] }];
      const widgetResult = results[0];
      if (!widgetResult || widgetResult.series?.length !== 1 || widgetResult.series.some(series => series.status !== 'ok')) throw previewError('previewQueryFailed');
      const current = widgetResult.series[0].data?.current;
      const comparison = widgetResult.series[0].data?.comparison;
      if (!Array.isArray(current) || comparison != null && !Array.isArray(comparison)) throw previewError('previewQueryFailed');
      const allRows = [...current, ...(comparison ?? [])];
      if (allRows.some(row => row?.error)) throw previewError('previewQueryFailed');
      if (compiled.widget.widget_type === 'kpi' && (current.length > 1 || current.some(row => Array.isArray(row.value)))) return issueResult('requiresChoice', 'scalarKpiRequired', '$.draft.view.type');
      if (['line_chart', 'bar_chart'].includes(compiled.widget.widget_type) && allRows.some(row => row.value != null && (typeof row.value !== 'number' || !Number.isFinite(row.value)))) return issueResult('requiresChoice', 'numericChartRequired', '$.draft.view.type');
      const warnings = [];
      if (!current.length) warnings.push({ code: 'emptyPreview' });
      if (allRows.some(row => row.conflict || row.typeConflict || row.semanticConflict || row.unitConflict)) warnings.push({ code: 'problemData' });
      const binding = {
        userId: target.req.user.id, workspace: target.workspace,
        target: { dashboardId, widgetId: existing?.id ?? null, widgetRevision: existing?.revision ?? null },
        draftHash, catalogToken: compiled.catalogToken, semanticFingerprint: compiled.semanticBinding.fingerprint,
        contextFingerprint, periodIntent: envelope.draft.periodIntent, resolvedPeriod: compiled.resolvedPeriod, evaluatedAt,
      };
      const response = { ...common, queryId: randomUUID(), widgetResult, presentationAnnotations: [], warnings, ...tokenService.issue(binding) };
      const encoded = JSON.stringify(response, (key, value) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw previewError('previewQueryFailed');
        return value;
      });
      if (Buffer.byteLength(encoded, 'utf8') > responseLimit) throw previewError('previewTooLarge', 413);
      return response;
    });
  }
  return {
    capabilities: options => execute('capabilities', options),
    validate: options => execute('validate', options),
    preview: options => execute('preview', options),
  };
}
