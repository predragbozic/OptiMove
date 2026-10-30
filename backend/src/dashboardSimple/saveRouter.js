import { Router, json } from 'express';
import { captureSimplePreviewRequestBytes, simpleRequestByteLength } from './previewRouter.js';
import { SIMPLE_SAVE_BODY_BYTES } from './saveRequest.js';

export function createSimpleSaveRouter({ service }) {
  if (!service || typeof service.save !== 'function' || typeof service.status !== 'function') throw new TypeError('Save service required');
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => req.user?.id ? next() : res.status(401).json({ error: 'unauthorized' }));
  router.use(json({ limit: SIMPLE_SAVE_BODY_BYTES, strict: true, verify: captureSimplePreviewRequestBytes }));
  router.use((req, res, next) => {
    const bytes = simpleRequestByteLength(req);
    if (req.body !== undefined && bytes === undefined) return res.status(503).json({ error: 'saveParserRequired' });
    if (bytes > SIMPLE_SAVE_BODY_BYTES) return res.status(413).json({ error: 'payloadTooLarge' });
    next();
  });
  for (const [method, path, action] of [['post', '/widgets', 'save'], ['put', '/widgets/:widgetId', 'save'], ['post', '/requests/status', 'status']]) {
    router[method](path, async (req, res) => {
      try {
        const result = await service[action]({ req, dashboardId: req.params.dashboardId, widgetId: req.params.widgetId ?? null, body: req.body });
        if (!res.destroyed) res.json(result);
      } catch (error) {
        const permitted = ['notFound', 'invalidRequest', 'invalidDraft', 'payloadTooLarge', 'workspaceSelectionRequired', 'dashboardArchived', 'templateRequiresClone', 'staleRevision', 'idempotencyConflict', 'requestInProgress', 'requestExpired', 'previewRequired', 'catalogChanged', 'advancedRequired', 'pagesClientRequired', 'saveUnavailable', 'saveBusy', 'saveTimeout', 'saveFailed', 'outcomeUnknown'];
        const code = permitted.includes(error?.code) ? error.code : 'saveFailed';
        const body = { error: code };
        if (code === 'outcomeUnknown') body.requestId = req.body?.requestId;
        if (code === 'previewRequired' && ['keyUnavailable', 'requestTimeChanged', 'effectivePeriodChanged', 'bindingChanged', 'tokenExpired', 'invalidToken', 'clockChanged', 'tokenNotYetValid'].includes(error.reason)) body.reason = error.reason;
        if (code === 'invalidDraft' && Array.isArray(error.issues)) body.issues = error.issues.map(issue => ({ code: issue.code, path: issue.path }));
        if (!res.destroyed) res.status(code === 'saveFailed' ? 503 : error.status ?? 503).json(body);
      }
    });
  }
  router.use((error, req, res, next) => res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: error?.type === 'entity.too.large' ? 'payloadTooLarge' : 'invalidRequest' }));
  return router;
}
