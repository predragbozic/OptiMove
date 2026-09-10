-- ============================================================
-- OPTIMOVE — Training Load 3B2: Analysis Dashboard v18 — seed data for
-- the widget type and built-in series catalogs finalized by the design
-- proof (DASHBOARD_MODEL_REPORT.md / DASHBOARD_UX_SPEC.md, Round 6).
-- Migration 4 of 4 — depends on v15 (the two catalog tables). A future
-- new widget type or built-in series is always a further additive INSERT
-- migration, never a rewrite of this one.
-- ============================================================

insert into training_load.dashboard_widget_types
  (key, label, min_width, max_width, min_height, max_height, default_width, default_height, max_series, has_shared_axis, supports_comparison_period) values
  ('kpi',        'KPI',        2, 4,  2, 3,  3, 2, 1,  false, true),
  ('table',      'Table',      3, 12, 3, 12, 6, 4, 12, false, false),
  ('line_chart', 'Line chart', 3, 12, 3, 8,  6, 4, 8,  true,  false),
  ('bar_chart',  'Bar chart',  3, 12, 3, 8,  6, 4, 8,  true,  false);

insert into training_load.dashboard_builtin_series (key, label, unit, value_type, default_analytical_aggregation, fixed_data_scope_level) values
  ('rpe', 'RPE', null, 'numeric', 'avg', 'session'),
  ('srpe', 'sRPE', 'AU', 'numeric', 'sum', 'session'),
  ('duration_minutes', 'Duration', 'min', 'numeric', 'sum', 'session'),
  -- Both are query-engine rollups over training.activity_participants /
  -- canonical activity results, never over metric_values or
  -- session_feedback.
  ('session_count', 'Sessions', null, 'numeric', 'sum', 'day'),
  ('last_session_date', 'Last session', null, 'text', 'last', 'day');
