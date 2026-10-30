import { Router, json } from 'express';

const originalRequestBytes = new WeakMap();

export function captureSimplePreviewRequestBytes(req, res, buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Original JSON bytes required');
  originalRequestBytes.set(req, buffer.byteLength);
}

export const simpleRequestByteLength = req => originalRequestBytes.get(req);

export function createSimplePreviewRouter({ service }) {
  if (!service || !['capabilities', 'validate', 'preview'].every(method => typeof service[method] === 'function')) throw new TypeError('Preview service required');
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => /^\/(capabilities|validate|preview)\/?$/.test(req.path) ? next() : next('router'));
  router.use((req, res, next) => req.user?.id ? next() : res.status(401).json({ error: 'unauthorized' }));
  const parseJson = json({ limit: 65536, strict: true, verify: captureSimplePreviewRequestBytes });
  router.use((req, res, next) => req.method === 'POST' ? parseJson(req, res, next) : next());
  router.use((req, res, next) => {
    if (req.method === 'POST' && req.body !== undefined) {
      const originalBytes = originalRequestBytes.get(req);
      if (originalBytes === undefined) return res.status(503).json({ error: 'previewParserRequired' });
      if (originalBytes > 65536 || Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 65536) return res.status(413).json({ error: 'payloadTooLarge' });
    }
    next();
  });
  for (const [method, route, action] of [['get', '/capabilities', 'capabilities'], ['post', '/validate', 'validate'], ['post', '/preview', 'preview']]) {
    router[method](route, async (req, res) => {
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      req.once('aborted', abort);
      res.once('close', abort);
      try {
        const result = await service[action]({ req, dashboardId: req.params.dashboardId, envelope: req.body, signal: controller.signal });
        if (!res.destroyed) res.json(result);
      } catch (error) {
        const code = ['notFound', 'workspaceSelectionRequired', 'dashboardArchived', 'templateRequiresClone', 'staleRevision', 'pagesClientRequired', 'catalogChanged', 'previewUnavailable', 'previewBusy', 'previewTimeout', 'previewTooLarge', 'previewQueryFailed', 'previewAborted', 'previewReadOnlyViolation', 'previewCleanupFailed'].includes(error?.code) ? error.code : 'previewFailed';
        if (!res.destroyed) {
          if (code === 'previewBusy') res.set('Retry-After', '1');
          res.status(code === 'previewFailed' ? 503 : error.status ?? 503).json({ error: code });
        }
      } finally {
        req.removeListener('aborted', abort);
        res.removeListener('close', abort);
      }
    });
  }
  router.use((error, req, res, next) => res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: error?.type === 'entity.too.large' ? 'payloadTooLarge' : 'invalidRequest' }));
  return router;
}
