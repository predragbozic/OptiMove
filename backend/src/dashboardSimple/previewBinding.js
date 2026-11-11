import { createHash } from 'node:crypto';
import { canonicalKey } from './compiler.js';

export const simpleFingerprint = value => createHash('sha256').update(canonicalKey(value)).digest('hex');

export function buildSimplePreviewBinding({ target, envelope, existing, compiled, context, evaluatedAt }) {
  return {
    userId: target.req.user.id, workspace: target.workspace,
    target: { dashboardId: target.dashboard.id, widgetId: existing?.id ?? null, widgetRevision: existing?.revision ?? null, ...(target.page ? { pageId: target.page.id } : {}) },
    draftHash: simpleFingerprint(envelope.draft), catalogToken: compiled.catalogToken,
    semanticFingerprint: compiled.semanticBinding.fingerprint,
    contextFingerprint: simpleFingerprint({ workspace: target.workspace, defaultFilter: target.dashboard.default_filter, ...(target.page ? { pageId: target.page.id, pageDefaultsRevision: target.page.defaults_revision, pageDefaultFilter: target.page.default_filter, pagePeriodConfig: target.page.period_config, pagePeriodOrigin: target.page.period_origin } : {}), runtimeFilter: context.runtimeFilter ?? {}, effectiveFilter: compiled.effectiveFilter, resolvedPeriod: compiled.resolvedPeriod }),
    periodIntent: envelope.draft.periodIntent, resolvedPeriod: compiled.resolvedPeriod, evaluatedAt,
  };
}
