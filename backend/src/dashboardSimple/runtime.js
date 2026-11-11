import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { readSimpleRuntimeConfig, SimpleRuntimeConfigurationError } from './runtimeConfig.js';
import { createPreviewTokenService } from './previewTokens.js';
import { createPreviewAdmission } from './previewAdmission.js';
import { createPostgresPreviewCoordinator } from './postgresAdmission.js';
import { createSimplePreviewService } from './previewService.js';
import { createSimpleSaveService } from './saveService.js';
import { createSimplePreviewRouter } from './previewRouter.js';
import { createSimpleSaveRouter } from './saveRouter.js';
import { withPreviewTransaction } from './previewTransaction.js';

export const SIMPLE_RUNTIME_PATH = '/api/training-load/dashboards/:dashboardId/simple';
export const SIMPLE_MIGRATION_NAME = 'migrations_v2/202611111100_training_load_v62_dashboard_simple_atomic_save.sql';
export const SIMPLE_MIGRATION_SHA256 = '73a85c31070d90244942ce0300edc6c88706cae4b1dc3bada28754fc7c57c5c2';

async function assertSchema(pool) {
  try {
    await withPreviewTransaction({ pool, checkoutTimeoutMs: 1000, transactionTimeoutMs: 2000, statementTimeoutMs: 1000 }, async query => {
      const ledger = (await query("select migration_name, checksum from public.schema_migrations where migration_name like '%dashboard_simple_atomic_save.sql'", [])).rows;
      if (ledger.length !== 1 || ledger[0].migration_name !== SIMPLE_MIGRATION_NAME || ledger[0].checksum !== SIMPLE_MIGRATION_SHA256) throw new Error();
      const shape = (await query(`select
        exists(select 1 from information_schema.columns where table_schema='training_load' and table_name='dashboard_widgets' and column_name='presentation_config' and data_type='jsonb' and is_nullable='YES') as presentation,
        to_regclass('training_load.dashboard_simple_requests') is not null as receipts,
        to_regprocedure('training_load.save_simple_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb)') is not null as writer`, [])).rows[0];
      if (shape?.presentation !== true || shape.receipts !== true || shape.writer !== true) throw new Error();
    });
  } catch { throw new SimpleRuntimeConfigurationError('S2c schema verification'); }
}

export async function createSimpleRuntime({ env = process.env, pool, poolMax, queryDashboard, now = () => Date.now(), processId = `simple-${randomUUID()}` } = {}) {
  const config = readSimpleRuntimeConfig(env);
  if (config.mode === 'off') return Object.freeze({ mode: 'off', router: null });
  if (!pool || typeof pool.connect !== 'function' || !Number.isSafeInteger(poolMax) || poolMax < 3 || typeof queryDashboard !== 'function') throw new SimpleRuntimeConfigurationError('server dependencies');
  let tokenService, admission;
  if (config.mode !== 'drain') {
    try {
      const raw = pool.options?.connectionString;
      const address = raw === undefined ? null : new URL(raw);
      const port = Number(address?.searchParams.get('port') || address?.port || pool.options?.port || 5432);
      if (port === 6543 || address?.searchParams.get('pgbouncer') === 'true') throw new Error();
    } catch { throw new SimpleRuntimeConfigurationError('session-affine PostgreSQL connection required'); }
    try { tokenService = createPreviewTokenService({ keyId: config.keyId, key: config.key, verificationKeys: config.verificationKeys, now }); }
    catch { throw new SimpleRuntimeConfigurationError('signing key configuration'); }
    const coordinator = createPostgresPreviewCoordinator({ pool, processId, maxActiveDeployment: config.maxActiveDeployment });
    admission = createPreviewAdmission({ coordinator, processId, poolMax });
  }
  await assertSchema(pool);
  const preview = createSimplePreviewService({ pool, queryDashboard, admission, tokenService, now, activation: { coordinatedAdmissionVerified: config.mode !== 'drain', deploymentBudgetVerified: config.mode !== 'drain', atomicSaveVerified: config.mode === 'enabled' } });
  const save = createSimpleSaveService({ pool, tokenService, now, activation: { atomicSaveVerified: config.mode === 'enabled' } });
  const router = Router({ mergeParams: true });
  router.use(createSimplePreviewRouter({ service: preview }));
  router.use(createSimpleSaveRouter({ service: save }));
  return Object.freeze({ mode: config.mode, router });
}
