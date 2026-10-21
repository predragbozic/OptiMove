import {MediaStorageError,uuid} from './mediaStorage.js';

// Internal/admin inspection only. No new HTTP endpoint, hold-release or GC operation.
export function createMediaReferenceService(pool) {
  return {
    async inspect(req,assetId) {
      if(!req?.user)throw new MediaStorageError(401,'authentication_required');
      if(!req.authz?.platformRoles?.includes('platform_admin'))throw new MediaStorageError(403,'operation_not_allowed');
      const result=await pool.query(`select a.id,a.kind,a.status,a.storage_account_id,a.size_bytes,
        coalesce((select jsonb_agg(to_jsonb(r)) from media.asset_reference_matrix r where r.asset_id=a.id),'[]'::jsonb) as references,
        coalesce((select jsonb_agg(to_jsonb(h)) from media.retention_holds h where exists
          (select 1 from media.hold_assets ha where ha.hold_id=h.id and ha.asset_id=a.id)),'[]'::jsonb) as holds
        from media.assets a where a.id=$1`,[uuid(assetId)]);
      if(!result.rows[0])throw new MediaStorageError(404,'resource_not_found');
      const row=result.rows[0];
      return {mediaId:row.id,kind:row.kind,status:row.status,storageAccountId:row.storage_account_id,sizeBytes:row.size_bytes,
        protected:row.references.some(r=>r.protects_retention),references:row.references,holds:row.holds};
    },
  };
}
export function mediaRetentionDatabaseError(error) {
  const codes={P7501:'media_reference_unavailable',P7502:'media_retention_protected',P7503:'media_retention_isolation_required'};
  return codes[error?.code]?new MediaStorageError(409,codes[error.code]):null;
}
