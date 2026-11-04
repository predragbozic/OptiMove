const copy = value => structuredClone(value);
const locked = model => ['saving', 'unknown'].includes(model?.saveState);
export const simpleSaveIsPending = locked;

export function simpleDraftFromWidget(widget, uuid) {
  const series = widget?.series?.[0];
  if (widget && (widget.series?.length !== 1 || series.resolution_status !== 'resolved'
    || series.template_metric_key_hints || series.template_resolution_candidates
    || Object.keys(widget.local_filter_override ?? {}).some(key => !['athleteIds', 'activityId', 'componentId'].includes(key)))) return null;
  const filter = widget?.local_filter_override ?? {};
  const selection = key => !Object.hasOwn(filter, key) ? { mode: 'inherit' } : filter[key] == null ? { mode: 'clear' } : { mode: 'selected', id: filter[key] };
  return {
    contractVersion: 1, draftId: uuid(), draftVersion: 1, title: widget?.title ?? '',
    ...(series ? { metricRef: series.built_in_series_key ? { kind: 'builtin', key: series.built_in_series_key } : { kind: 'metric', metricDefinitionId: series.metric_definition_id } } : {}),
    athleteSelection: !Object.hasOwn(filter, 'athleteIds') ? { mode: 'inherit' } : filter.athleteIds?.length ? { mode: 'selected', athleteIds: copy(filter.athleteIds) } : { mode: 'allAuthorized' },
    advancedFilter: { activity: selection('activityId'), component: selection('componentId') }, periodIntent: { mode: 'inherit' },
    view: widget ? { type: widget.widget_type, groupBy: widget.group_by, dataScopeLevel: series.data_scope_level, analyticalAggregation: series.analytical_aggregation } : { type: 'table', groupBy: 'day' },
    ...(widget ? { display: { mode: 'preserve' }, presentation: { mode: 'preserve' } } : {}),
  };
}

export function createSimpleEditorController({ request, getContext, paint = () => {}, saved = async () => {}, uuid = () => crypto.randomUUID(), schedule = setTimeout, cancel = clearTimeout }) {
  let model = null, generation = 0, timer, previewInFlight = false, queuedPreview = false, searchGeneration = 0;
  const contextKey = context => JSON.stringify([context.identity, context.dashboardId, context.period, context.runtimeFilter]);
  const identityKey = context => JSON.stringify([context.identity, context.dashboardId]);
  const currentTarget = (target, run) => model === target && generation === run && identityKey(getContext()) === identityKey(target.context);
  const current = (target, run) => currentTarget(target, run) && contextKey(getContext()) === target.contextKey;
  const base = target => `/api/training-load/dashboards/${encodeURIComponent(target.context.dashboardId)}/simple`;
  const redraw = () => { if (model) model.canSave = Boolean(contextKey(getContext()) === model.contextKey && model.saveState === 'idle' && !model.stale && model.preview?.status === 'valid' && model.preview.previewToken && model.capabilities?.capabilities?.atomicSave && !model.previewLoading && !locked(model)); paint(model); };
  const fail = error => ({ staleRevision: 'This widget changed. Reopen it before saving.', catalogChanged: 'The metric changed. Select it again and preview.', previewRequired: 'Preview again before saving.', previewBusy: 'Another preview is running. Try again shortly.', notFound: 'This dashboard or metric is no longer available.', previewTooLarge: 'Choose fewer athletes or a shorter period.', saveUnavailable: 'Saving is temporarily unavailable.' }[error?.data?.error ?? error?.message] ?? 'The request could not be completed. Please try again.');
  function input(target) {
    return { contractVersion: 1, context: { kind: 'legacyDashboard', period: copy(target.context.period), runtimeFilter: copy(target.context.runtimeFilter ?? {}) },
      draftRef: { draftId: target.draft.draftId, draftVersion: target.draft.draftVersion }, draft: copy(target.draft),
      editTarget: target.widgetId ? { widgetId: target.widgetId, expectedWidgetRevision: target.widgetRevision } : null };
  }
  async function metrics(append = false) {
    const target = model, run = generation, searchRun = ++searchGeneration;
    if (!target || locked(target)) return;
    target.loading = true; target.error = ''; redraw();
    const params = new URLSearchParams({ search: target.search, limit: '100' });
    if (append && target.nextCursor) params.set('afterId', target.nextCursor);
    try {
      const result = await request(`${base(target)}/metrics?${params}`);
      if (!current(target, run) || searchRun !== searchGeneration) return;
      target.metrics = append ? [...new Map([...target.metrics, ...result.metrics].map(row => [row.id, row])).values()] : result.metrics;
      target.nextCursor = result.nextCursor;
      selectMetadata(target);
    } catch (error) { if (current(target, run) && searchRun === searchGeneration) target.error = fail(error); }
    finally { if (current(target, run) && searchRun === searchGeneration) { target.loading = false; redraw(); } }
  }
  function selectMetadata(target) {
    const ref = target.draft.metricRef;
    target.selectedMetric = ref?.kind === 'builtin' ? target.capabilities?.builtins?.find(row => row.key === ref.key) : target.metrics.find(row => row.id === ref?.metricDefinitionId);
  }
  async function open(widget = null) {
    if (locked(model)) return true;
    cancel(timer); generation += 1;
    const context = copy(getContext()), run = generation;
    const draft = simpleDraftFromWidget(widget, uuid);
    model = { open: true, step: 1, context, contextKey: contextKey(context), periodDraft: copy(context.period), draft, widgetId: widget?.id ?? null, widgetRevision: widget?.revision,
      advancedRequired: !draft, canUpgradeChart:Boolean(widget && widget.presentation_config == null), metrics: [], search: '', loading: true, previewLoading: false, saveState: 'idle', error: '', saveError: '', canSave: false, athletes: context.athletes ?? [] };
    const target = model; redraw();
    try {
      const capabilities = await request(`${base(target)}/capabilities`);
      if (!current(target, run)) return true;
      target.capabilities = capabilities;
      if (!target.capabilities.capabilities.preview) { target.error = 'Live preview is currently unavailable. Advanced settings are available.'; target.loading = false; redraw(); return true; }
      if (draft) {
        await metrics();
        if (current(target, run) && draft.metricRef?.kind === 'metric' && !target.selectedMetric) {
          const result = await request(`${base(target)}/metrics?${new URLSearchParams({ metricDefinitionId: draft.metricRef.metricDefinitionId })}`);
          if (!current(target, run)) return true;
          target.metrics = [...new Map([...target.metrics, ...result.metrics].map(row => [row.id, row])).values()];
          selectMetadata(target);
        }
      }
    } catch (error) {
      if (current(target, run)) { target.error = fail(error); target.unavailable = error.status === 404; }
    } finally { if (current(target, run)) { target.loading = false; redraw(); } }
    return true;
  }
  function change(mutator, { render = true } = {}) {
    if (!model?.draft || locked(model) || model.saveState === 'recorded' || model.stale) return;
    const before = JSON.stringify(model.draft);
    mutator(model.draft, model);
    if (before === JSON.stringify(model.draft)) return;
    model.draft.draftVersion += 1; model.preview = null; model.previewInput = null; model.pending = null; model.canSave = false; model.saveError = ''; model.error = '';
    model.advancedRequired = false;
    cancel(timer); queuedPreview = false;
    if (model.step === 3) timer = schedule(() => void preview(), 350);
    if (render) redraw();
  }
  async function preview() {
    cancel(timer);
    const target = model, run = generation;
    if (!target?.draft?.metricRef || locked(target) || !target.capabilities?.capabilities?.preview) return;
    if (!current(target, run)) { target.error = 'Dashboard filters changed. Reopen the editor before previewing or saving.'; redraw(); return; }
    if (previewInFlight) { queuedPreview = true; return; }
    const envelope = input(target), version = target.draft.draftVersion;
    previewInFlight = true; target.previewLoading = true; target.preview = null; target.error = ''; redraw();
    try {
      const result = await request(`${base(target)}/preview`, { method: 'POST', body: JSON.stringify(envelope) });
      if (!current(target, run) || target.draft.draftVersion !== version) return;
      target.preview = result; target.previewInput = envelope;
      target.advancedRequired = result.status === 'advancedRequired';
    } catch (error) { if (current(target, run) && target.draft.draftVersion === version) target.error = fail(error); }
    finally {
      previewInFlight = false;
      if (model === target) target.previewLoading = false;
      redraw();
      if (queuedPreview) { queuedPreview = false; timer = schedule(() => void preview(), 350); }
    }
  }
  async function complete(target, result, run) {
    if (!currentTarget(target, run)) return;
    target.saveState = 'recorded'; target.receipt = result; target.saveError = ''; redraw();
    try { await saved(result, target); }
    catch { target.saveError = 'Saved successfully. Reload the dashboard to see the latest result.'; }
    redraw();
  }
  async function save(retry = false) {
    const target = model, run = generation;
    if (!target || target.saveState === 'saving' || target.checkingStatus || target.stale) return;
    if (!(retry ? currentTarget(target, run) : current(target, run))) { target.saveError = 'Dashboard filters changed. Reopen the editor before saving.'; redraw(); return; }
    if (!retry && (!target.canSave || target.saveState !== 'idle')) return;
    if (retry && (target.saveState !== 'unknown' || !target.pending)) return;
    if (!target.pending) {
      target.pending = { requestId: uuid(), requestIssuedAt: target.preview.requestIssuedAt, resolvedPeriod: copy(target.preview.resolvedPeriod), previewToken: target.preview.previewToken, input: copy(target.previewInput) };
      target.pendingBody = JSON.stringify(target.pending);
    }
    target.saveState = 'saving'; target.saveError = ''; redraw();
    try {
      const result = await request(`${base(target)}/widgets${target.widgetId ? `/${encodeURIComponent(target.widgetId)}` : ''}`, { method: target.widgetId ? 'PUT' : 'POST', body: target.pendingBody });
      await complete(target, result, run);
    } catch (error) {
      if (!currentTarget(target, run)) return;
      const definiteRejection = error.status >= 400 && error.status < 500 && ['invalidRequest', 'invalidDraft', 'payloadTooLarge', 'staleRevision', 'previewRequired', 'catalogChanged', 'advancedRequired', 'pagesClientRequired', 'dashboardArchived', 'templateRequiresClone'].includes(error?.data?.error);
      if (!definiteRejection) {
        target.saveState = 'unknown'; target.saveError = 'The save outcome is not confirmed. Keep this screen open and check status or retry the same request.';
      } else if (retry) {
        target.saveState = 'unknown'; target.saveError = 'The earlier save is still unconfirmed. Check its status before taking another action.';
      } else {
        target.saveState = 'idle'; target.pending = null; target.pendingBody = null; target.preview = null; target.saveError = fail(error);
        if ((error.data?.error ?? error.message) === 'staleRevision') target.stale = true;
      }
      redraw();
    }
  }
  async function status() {
    const target = model, run = generation;
    if (target?.saveState !== 'unknown' || !target.pending || target.checkingStatus) return;
    target.checkingStatus = true; redraw();
    try {
      const result = await request(`${base(target)}/requests/status`, { method: 'POST', body: JSON.stringify({ requestId: target.pending.requestId }) });
      if (!currentTarget(target, run)) return;
      if (result.status === 'recorded') await complete(target, result.receipt, run);
      else target.saveError = 'No receipt is recorded yet. This does not confirm rollback. Retry the same request or check again.';
    } catch { if (currentTarget(target, run)) target.saveError = 'Status could not be confirmed. Keep this screen open and try again.'; }
    finally { if (model === target) { target.checkingStatus = false; redraw(); } }
  }
  function close() { if (locked(model)) return false; cancel(timer); generation += 1; model = null; paint(null); return true; }
  return { open, close, change, preview, save, status, metrics, get model() { return model; }, get pending() { return locked(model); },
    next() { if (!model?.draft || locked(model)) return; if (model.step === 1 && !model.draft.metricRef) return; if (model.step === 2 && model.draft.athleteSelection.mode === 'selected' && !model.draft.athleteSelection.athleteIds.length) { model.error = 'Choose at least one athlete or use dashboard athletes.'; redraw(); return; } model.error = ''; model.step = Math.min(3, model.step + 1); redraw(); if (model.step === 3) timer = schedule(() => void preview(), 350); },
    back() { if (!model || locked(model)) return; model.step = Math.max(1, model.step - 1); redraw(); },
    selectMetric(kind, id) { const ref = model?.draft?.metricRef; if (ref?.kind === kind && (kind === 'builtin' ? ref.key : ref.metricDefinitionId) === id) return; change((draft, target) => { draft.metricRef = kind === 'builtin' ? { kind, key: id } : { kind: 'metric', metricDefinitionId: id }; selectMetadata(target); const metric = target.selectedMetric; draft.view = { type: 'table', groupBy: 'day' }; if(target.canUpgradeChart)draft.presentation={mode:'preserve'}; if (metric?.fixed_data_scope_level) { draft.view.dataScopeLevel = metric.fixed_data_scope_level; draft.view.analyticalAggregation = metric.default_analytical_aggregation; } else if (metric?.scope_capabilities?.length === 1) draft.view.dataScopeLevel = metric.scope_capabilities[0]; if (!draft.title.trim()) draft.title = metric?.label ?? ''; }); },
    search(value) { if (!model || locked(model)) return; model.search = value; cancel(timer); timer = schedule(() => void metrics(), 350); },
  };
}
