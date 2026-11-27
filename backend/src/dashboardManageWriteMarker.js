export const DASHBOARD_MANAGE_WRITE_MARKER_SQL = "update training_load.dashboards_manage_v105_use set first_checked_write_at = clock_timestamp() where singleton and first_checked_write_at is null";
