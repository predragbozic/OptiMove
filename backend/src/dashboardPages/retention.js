export async function purgeDashboardPageRequests(executor) {
  const { rows } = await executor.query("select to_regprocedure('training_load.cleanup_dashboard_page_requests(integer)') is not null as installed");
  if (!rows[0]?.installed) return;
  for (let batch = 0; batch < 5; batch += 1) {
    const result = await executor.query('select training_load.cleanup_dashboard_page_requests(100) as deleted');
    if (result.rows[0].deleted < 100) break;
  }
}
