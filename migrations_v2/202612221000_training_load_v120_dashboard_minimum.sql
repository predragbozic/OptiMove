-- Minimum is an analytical aggregation on dashboard series. The metric
-- catalog's own daily reduction and the series type guard keep their rules.
set local lock_timeout = '5s';

alter table training_load.dashboard_widget_series
  drop constraint dashboard_widget_series_analytical_aggregation_check,
  add constraint dashboard_widget_series_analytical_aggregation_check
    check (analytical_aggregation in ('sum', 'avg', 'min', 'max', 'last', 'none', 'ratio'));
