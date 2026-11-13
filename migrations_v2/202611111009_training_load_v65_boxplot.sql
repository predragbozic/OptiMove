-- S6f Box plot: distributions of returned athlete aggregates; no widget row rewrite.

create or replace function training_load.dashboard_presentation_valid(p_config jsonb)
returns boolean language plpgsql immutable parallel safe as $$
declare
  interactions jsonb;
  section jsonb;
  component jsonb;
begin
  if p_config is null then return true; end if;
  if jsonb_typeof(p_config) <> 'object'
    or jsonb_typeof(p_config -> 'schemaVersion') is distinct from 'number' then return false; end if;
  if (p_config ->> 'schemaVersion')::numeric < 1
    or trunc((p_config ->> 'schemaVersion')::numeric) <> (p_config ->> 'schemaVersion')::numeric
    or (p_config ->> 'schemaVersion')::numeric > 9007199254740991 then return false; end if;
  if (p_config ->> 'schemaVersion')::numeric <> 1 then return true; end if;
  if not training_load.dashboard_simple_object(p_config,
    array['schemaVersion','chartVariant','chartComposition','chartInteractions','tableFormatting','stackDefinition'], array['schemaVersion']) then return false; end if;
  if p_config ? 'chartVariant' and (p_config -> 'chartVariant' not in ('"area"'::jsonb,'"horizontal-bar"'::jsonb,'"combined"'::jsonb,'"heatmap"'::jsonb,'"scatter"'::jsonb,'"stacked"'::jsonb,'"boxplot"'::jsonb) or not p_config ? 'chartInteractions') then return false; end if;
  if p_config ? 'chartComposition' and p_config -> 'chartComposition' not in ('"athletes-v1"'::jsonb,'"metrics-v1"'::jsonb,'"matrix-v1"'::jsonb,'"pairs-v1"'::jsonb,'"components-v1"'::jsonb,'"distribution-v1"'::jsonb) then return false; end if;
  if coalesce(p_config -> 'chartVariant' = '"combined"'::jsonb,false) <> coalesce(p_config -> 'chartComposition' = '"metrics-v1"'::jsonb,false) then return false; end if;
  if p_config ->> 'chartVariant' = 'combined' and p_config #>> '{chartInteractions,yAxis,mode}' = 'fixed' then return false; end if;
  if coalesce(p_config ->> 'chartVariant' = 'boxplot',false) <> coalesce(p_config ->> 'chartComposition' = 'distribution-v1',false) then return false; end if;
  if p_config ->> 'chartVariant' = 'boxplot' and p_config #>> '{chartInteractions,yAxis,mode}' = 'fixed' then return false; end if;
  if coalesce(p_config ->> 'chartVariant' = 'heatmap',false) <> coalesce(p_config ->> 'chartComposition' = 'matrix-v1',false) then return false; end if;
  if p_config ->> 'chartVariant' = 'heatmap' and p_config #>> '{chartInteractions,yAxis,mode}' = 'fixed' then return false; end if;
  if coalesce(p_config ->> 'chartVariant' = 'scatter',false) <> coalesce(p_config ->> 'chartComposition' = 'pairs-v1',false) then return false; end if;
  if p_config ->> 'chartVariant' = 'scatter' and (p_config #>> '{chartInteractions,yAxis,mode}' = 'fixed' or p_config #>> '{chartInteractions,zoom,mode}' = 'local' or p_config #> '{chartInteractions,zoom,applyPeriodAction}' = 'true'::jsonb) then return false; end if;
  if coalesce(p_config ->> 'chartVariant' = 'stacked',false) <> coalesce(p_config ->> 'chartComposition' = 'components-v1',false)
    or coalesce(p_config ->> 'chartVariant' = 'stacked',false) <> (p_config ? 'stackDefinition') then return false; end if;
  if p_config ->> 'chartVariant' = 'stacked' then
    if p_config #>> '{chartInteractions,yAxis,mode}' = 'fixed' then return false; end if;
    section := p_config -> 'stackDefinition';
    if not training_load.dashboard_simple_object(section,array['schemaVersion','semantics','unit','components'],array['schemaVersion','semantics','unit','components'])
      or section -> 'schemaVersion' <> '1'::jsonb or section -> 'semantics' is distinct from '"non-overlapping-additive"'::jsonb
      or jsonb_typeof(section -> 'unit') is distinct from 'string' or length(section ->> 'unit') not between 1 and 100
      or (section ->> 'unit') ~ '^[[:space:]]|[[:space:]]$' or jsonb_typeof(section -> 'components') is distinct from 'array' then return false; end if;
    if jsonb_array_length(section -> 'components') not between 2 and 8 then return false; end if;
    for component in select value from jsonb_array_elements(section -> 'components') loop
      if jsonb_typeof(component) is distinct from 'string' or (component #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
    end loop;
    if (select count(distinct lower(value #>> '{}')) from jsonb_array_elements(section -> 'components')) <> jsonb_array_length(section -> 'components') then return false; end if;
  end if;
  if p_config ? 'tableFormatting' then
    if p_config ?| array['chartComposition','chartInteractions','chartVariant'] then return false; end if;
    section := p_config -> 'tableFormatting';
    if not training_load.dashboard_simple_object(section, array['evaluationVersion','rules'], array['evaluationVersion','rules'])
      or section -> 'evaluationVersion' <> '1'::jsonb
      or jsonb_typeof(section -> 'rules') is distinct from 'array' then return false; end if;
    if jsonb_array_length(section -> 'rules') <> 0 then return false; end if;
  end if;
  if p_config ? 'chartInteractions' then
    interactions := p_config -> 'chartInteractions';
    if not training_load.dashboard_simple_object(interactions,
      array['tooltip','legend','zoom','pointSelection','yAxis']) then return false; end if;
    if interactions ? 'tooltip' then
      section := interactions -> 'tooltip';
      if not training_load.dashboard_simple_object(section, array['mode'], array['mode'])
        or not (section -> 'mode' = any(array['"exact"'::jsonb,'"formatted"'::jsonb])) then return false; end if;
    end if;
    if interactions ? 'legend' then
      section := interactions -> 'legend';
      if not training_load.dashboard_simple_object(section, array['toggle'], array['toggle'])
        or jsonb_typeof(section -> 'toggle') is distinct from 'boolean' then return false; end if;
    end if;
    if interactions ? 'zoom' then
      section := interactions -> 'zoom';
      if not training_load.dashboard_simple_object(section, array['mode','applyPeriodAction'], array['mode','applyPeriodAction'])
        or not (section -> 'mode' = any(array['"disabled"'::jsonb,'"local"'::jsonb]))
        or jsonb_typeof(section -> 'applyPeriodAction') is distinct from 'boolean' then return false; end if;
    end if;
    if interactions ? 'pointSelection' then
      section := interactions -> 'pointSelection';
      if not training_load.dashboard_simple_object(section, array['mode'], array['mode'])
        or not (section -> 'mode' = any(array['"disabled"'::jsonb,'"details"'::jsonb])) then return false; end if;
    end if;
    if interactions ? 'yAxis' then
      section := interactions -> 'yAxis';
      if section -> 'mode' = '"auto"'::jsonb then
        if not training_load.dashboard_simple_object(section, array['mode'], array['mode']) then return false; end if;
      elsif section -> 'mode' = '"fixed"'::jsonb then
        if not training_load.dashboard_simple_object(section, array['mode','min','max'], array['mode','min','max'])
          or jsonb_typeof(section -> 'min') is distinct from 'number'
          or jsonb_typeof(section -> 'max') is distinct from 'number' then return false; end if;
        if (section ->> 'min')::numeric >= (section ->> 'max')::numeric
          or abs((section ->> 'min')::numeric) > 1.7976931348623157e308::numeric
          or abs((section ->> 'max')::numeric) > 1.7976931348623157e308::numeric then return false; end if;
      else return false;
      end if;
    end if;
  end if;
  return true;
end;
$$;

create or replace function training_load.dashboard_presentation_assert_compatible(
  p_config jsonb, p_widget_type text, p_group_by text
) returns void language plpgsql as $$
begin
  if not training_load.dashboard_presentation_valid(p_config) then
    raise exception 'invalidPresentation' using errcode = 'S2C02';
  end if;
  if p_config is null or training_load.dashboard_presentation_opaque(p_config) then return; end if;
  if (p_config ?| array['chartComposition','chartInteractions','chartVariant']) and p_widget_type not in ('line_chart','bar_chart')
    or p_config -> 'chartVariant' = '"area"'::jsonb and p_widget_type <> 'line_chart'
    or p_config -> 'chartVariant' = '"horizontal-bar"'::jsonb and p_widget_type <> 'bar_chart'
    or p_config ->> 'chartVariant' = 'combined' and (p_widget_type <> 'line_chart' or p_group_by not in ('day','week'))
    or p_config ->> 'chartVariant' = 'boxplot' and (p_widget_type <> 'bar_chart' or p_group_by not in ('day','week'))
    or p_config ->> 'chartVariant' = 'heatmap' and (p_widget_type <> 'bar_chart' or p_group_by not in ('day','week'))
    or p_config ->> 'chartVariant' = 'scatter' and (p_widget_type <> 'line_chart' or p_group_by not in ('day','week'))
    or p_config ->> 'chartVariant' = 'stacked' and (p_widget_type <> 'bar_chart' or p_group_by not in ('day','week'))
    or p_config ? 'tableFormatting' and p_widget_type <> 'table'
    or p_config ? 'chartComposition' and p_group_by not in ('day','week','athlete')
    or p_group_by not in ('day','week') and (
      p_config #> '{chartInteractions,zoom,mode}' = '"local"'::jsonb
      or p_config #> '{chartInteractions,zoom,applyPeriodAction}' = 'true'::jsonb
    ) then
    raise exception 'incompatiblePresentation' using errcode = 'S2C02';
  end if;
end;
$$;

create or replace function training_load.dashboard_boxplot_v1() returns boolean language sql immutable parallel safe as $$ select true; $$;
-- Deferred checks allow the sanctioned create-widget/add-series sequence while
-- enforcing the final shape on every widget or series write, including deletes.
create or replace function training_load.dashboard_boxplot_guard_series()
returns trigger language plpgsql as $$
declare
  parent_id uuid;
  parent_widget training_load.dashboard_widgets%rowtype;
  attached_series training_load.dashboard_widget_series%rowtype;
begin
  if tg_table_name = 'dashboard_widgets' then
    parent_id := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    parent_id := case when tg_op = 'DELETE' then old.widget_id else new.widget_id end;
  end if;
  select widget.* into parent_widget from training_load.dashboard_widgets widget where widget.id=parent_id for update;
  if not found then return null; end if;
  if parent_widget.presentation_config -> 'schemaVersion' is distinct from '1'::jsonb
    or parent_widget.presentation_config ->> 'chartVariant' is distinct from 'boxplot' then return null; end if;
  perform training_load.dashboard_presentation_assert_compatible(
    parent_widget.presentation_config, parent_widget.widget_type, parent_widget.group_by);
  if (select count(*) from training_load.dashboard_widget_series where widget_id=parent_id) <> 1 then
    raise exception 'boxplotSinglePrimaryRequired' using errcode = 'S2C02';
  end if;
  select series.* into attached_series from training_load.dashboard_widget_series series where series.widget_id=parent_id for share;
  if attached_series.axis is distinct from 'primary' or attached_series.comparison_period is not null then
    raise exception 'boxplotSinglePrimaryRequired' using errcode = 'S2C02';
  end if;
  perform training_load.dashboard_presentation_assert_series(parent_widget.presentation_config, parent_widget.widget_type,
    attached_series.metric_definition_id, attached_series.built_in_series_key, attached_series.resolution_status);
  return null;
end;
$$;

create constraint trigger dashboard_boxplot_widget_series_check
  after insert or update on training_load.dashboard_widgets
  deferrable initially deferred for each row execute function training_load.dashboard_boxplot_guard_series();

create constraint trigger dashboard_boxplot_series_check
  after insert or update or delete on training_load.dashboard_widget_series
  deferrable initially deferred for each row execute function training_load.dashboard_boxplot_guard_series();

-- HTTP Advanced writes must surface deterministic constraint errors before
-- entering COMMIT recovery, where only an uncertain transport outcome belongs.
create function training_load.dashboard_boxplot_flush_checks()
returns void language plpgsql as $$
begin
  set constraints training_load.dashboard_boxplot_widget_series_check, training_load.dashboard_boxplot_series_check immediate;
  set constraints training_load.dashboard_boxplot_widget_series_check, training_load.dashboard_boxplot_series_check deferred;
end;
$$;
