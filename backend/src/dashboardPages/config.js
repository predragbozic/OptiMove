// Pages require both the explicit server setting and the persistent DB activation.
// The environment alone can never reopen an old-server deploy gap.
export function pagesEnabled(env = process.env) {
  const value = env.DASHBOARD_PAGES_ENABLED ?? 'false';
  if (!['false', 'true'].includes(value)) throw new Error('Invalid DASHBOARD_PAGES_ENABLED');
  return value === 'true';
}
export async function pageDatabaseEnabled(queryRunner) {
  const installed = (await queryRunner("select to_regclass('training_load.dashboard_pages_activation') is not null installed")).rows[0]?.installed;
  if (!installed) return false;
  return (await queryRunner('select enabled from training_load.dashboard_pages_activation where singleton')).rows[0]?.enabled === true;
}

export async function pageSchemaInstalled(queryRunner) {
  return (await queryRunner("select to_regclass('training_load.dashboard_pages') is not null as installed")).rows[0]?.installed === true;
}
