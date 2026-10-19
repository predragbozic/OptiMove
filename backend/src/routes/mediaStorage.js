import { Router } from 'express';
import { MediaStorageError, uuid } from '../mediaStorage.js';
import { isPlatformAdministrator } from '../authz.js';

// Service injection keeps HTTP authorization tests independent of R2 credentials.
export function createMediaStorageRouter({ service, uploads, enabled = () => process.env.MEDIA_STORAGE_ENABLED === 'true', admin = false }) {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({error:'Authentication required.',code:'authentication_required',retryable:false,details:{}});
    if (!enabled()) return res.status(503).json({error:'Media storage is disabled.',code:'media_storage_disabled',retryable:false,details:{}});
    if (admin && !isPlatformAdministrator(req.authz || {platformRoles:[]})) {
      return res.status(403).json({error:'Operation not allowed.',code:'operation_not_allowed',retryable:false,details:{}});
    }
    next();
  });
  const handle = work => async (req,res,next) => { try { await work(req,res); } catch(e) { next(e); } };
  if (admin) {
    router.get('/storage-policy',handle(async (_req,res) => res.json(await service.getPolicy())));
    router.patch('/storage-policy',handle(async (req,res) => res.json(await service.updatePolicy(req.user.id,req.body))));
    router.get('/storage-accounts',handle(async (req,res) => res.json(await service.listAccounts(req.query))));
    // Allows an admin to allocate space before the account's first upload/usage read.
    router.post('/storage-accounts',handle(async (req,res) => {
      const id = await service.ensureAccount(req.body?.owner);
      res.status(200).json(await service.getAccount(id));
    }));
    router.get('/storage-accounts/:id',handle(async (req,res) => res.json(await service.getAccount(uuid(req.params.id)))));
    router.patch('/storage-accounts/:id/limit',handle(async (req,res) => res.json(await service.updateLimit(req.user.id,uuid(req.params.id),req.body))));
    router.get('/storage-limit-audit',handle(async (req,res) => res.json(await service.listAudit(req.query))));
  } else {
    if (uploads) {
      router.post('/uploads',handle(async(req,res)=>res.status(201).json(await uploads.initiate(req,req.body,req.get('Idempotency-Key')))));
      router.get('/uploads/:id',handle(async(req,res)=>res.json(await uploads.status(req,req.params.id))));
      router.post('/uploads/:id/renew',handle(async(req,res)=>res.json(await uploads.renew(req,req.params.id))));
      router.post('/uploads/:id/complete',handle(async(req,res)=>{const r=await uploads.complete(req,req.params.id);res.status(r.httpStatus).json(r.body);}));
      router.delete('/uploads/:id',handle(async(req,res)=>{const r=await uploads.cancel(req,req.params.id);res.status(r.httpStatus).json(r.body);}));
    }
    router.get('/storage',handle(async (req,res) => {
      if (!req.authz?.capabilities?.coachWorkspace) throw new MediaStorageError(403,'operation_not_allowed');
      if (req.query.exerciseId !== undefined) {
        if (!uploads) throw new MediaStorageError(503,'media_storage_unavailable');
        return res.json(await uploads.usageForExercise(req,req.query.exerciseId));
      }
      // A workspace preference/role_hint never grants rights. Own private quota
      // and clubs actually administered by this actor are the only usage scopes.
      const owners = [{type:'user',id:req.user.id}];
      for (const role of req.authz.clubRoles || []) if (role.role==='club_admin') owners.push({type:'club',id:role.clubId});
      res.json(await service.getUsage(owners));
    }));
  }
  router.use((error,_req,res,next) => {
    if (error instanceof MediaStorageError) return res.status(error.status).json({error:error.code,code:error.code,retryable:Boolean(error.retryable),details:error.details});
    if (['55P03','57014','40001','40P01'].includes(error.code)) return res.status(503).json({error:'Storage is busy.',code:'media_storage_busy',retryable:true,details:{}});
    if (error.code==='23503') return res.status(404).json({error:'Resource not found.',code:'resource_not_found',retryable:false,details:{}});
    console.error('[media] operation failed', {code: typeof error.code==='string' ? error.code : 'unexpected_error'});
    return res.status(503).json({error:'Media storage is unavailable.',code:'media_storage_unavailable',retryable:true,details:{}});
  });
  return router;
}
