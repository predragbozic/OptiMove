import { Router, json } from 'express';

const allowedErrors = new Set(['invalidRequest', 'notFound', 'workspaceSelectionRequired', 'dashboardArchived', 'templateRequiresClone', 'pagesUnavailable', 'stalePageRevision', 'stalePagesRevision', 'stalePageDefaultsRevision', 'lastPageRequired', 'pageNotEmpty', 'pageLimitReached', 'idempotencyConflict', 'outcomeUnknown', 'pagesClientRequired', 'pageTooLarge', 'pagePeriodRequired', 'invalidPageDefaults', 'pageResponseTooLarge', 'saveBusy', 'saveTimeout', 'saveFailed', 'previewBusy', 'previewTimeout', 'previewCleanupFailed', 'previewAborted']);
const sqlErrors = Object.freeze({ P4P01: ['pagesClientRequired',409], P4P02: ['stalePageRevision',409], P4P03: ['stalePagesRevision',409], P4P04: ['stalePageDefaultsRevision',409], P4P05: ['lastPageRequired',409], P4P06: ['pageNotEmpty',409], P4P07: ['pageLimitReached',409], P4P08: ['idempotencyConflict',409], P4P09: ['invalidRequest',400], P4P10: ['notFound',404], '40002': ['dashboardArchived',409] });

export function createPagesRouter({ service }) {
  if (!service || !['list', 'detail', 'query', 'mutate', 'status'].every(name => typeof service[name] === 'function')) throw new TypeError('Pages service required');
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => req.user?.id ? next() : res.status(401).json({ error: 'unauthorized' }));
  router.use(json({ limit: 65536, strict: true }));
  const handle = (action, options = {}) => async (req, res) => {
    try {
      const result = await service[action]({ req, dashboardId: req.params.dashboardId, pageId: req.params.pageId, requestId: req.params.requestId, body: req.body, ...options });
      res.status(options.operation === 'create' || options.operation === 'duplicate' ? 201 : 200).json(result);
    } catch (error) {
      const mapped = sqlErrors[error?.code];
      const code = mapped?.[0] ?? (allowedErrors.has(error?.code) ? error.code : 'pagesUnavailable');
      if (['saveBusy', 'previewBusy'].includes(code)) res.set('Retry-After', '1');
      res.status(mapped?.[1] ?? (code === 'pagesUnavailable' ? 503 : error.status ?? 503)).json({ error: code, ...(code === 'outcomeUnknown' ? { requestId: req.body?.requestId } : {}) });
    }
  };
  router.get('/', handle('list'));
  router.get('/requests/:requestId', handle('status'));
  router.post('/', handle('mutate', { operation: 'create' }));
  router.put('/order', handle('mutate', { operation: 'reorder' }));
  router.get('/:pageId', handle('detail'));
  router.patch('/:pageId', handle('mutate', { operation: 'rename' }));
  router.patch('/:pageId/defaults', handle('mutate', { operation: 'defaults' }));
  router.post('/:pageId/duplicate', handle('mutate', { operation: 'duplicate' }));
  router.delete('/:pageId', handle('mutate', { operation: 'delete' }));
  router.post('/:pageId/query', handle('query'));
  router.use((error, req, res, next) => res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: error?.type === 'entity.too.large' ? 'payloadTooLarge' : 'invalidRequest' }));
  return router;
}
