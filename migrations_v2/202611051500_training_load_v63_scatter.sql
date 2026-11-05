-- S6d.2 Scatter: server-confirmed pairs, automatic numeric axes, no time zoom.

create or replace function training_load.dashboard_presentation_valid(p_config jsonb)
returns boolean language plpgsql immutable parallel safe as $$
declare
  interactions jsonb;
  section jsonb;
begin
  if p_config is null then return true; end if;
  if jsonb_typeof(p_config) <> 'object'
    or jsonb_typeof(p_config -> 'schemaVersion') is distinct from 'number' then return false; end if;
  if (p_config ->> 'schemaVersion')::numeric < 1
    or trunc((p_config ->> 'schemaVersion')::numeric) <> (p_config ->> 'schemaVersion')::numeric
    or (p_config ->> 'schemaVersion')::numeric > 9007199254740991 then return false; end if;
  if (p_config ->> 'schemaVersion')::numeric <> 1 then return true; end if;
  if not training_load.dashboard_simple_object(p_config,
    array['schemaVersion','chartVariant','chartComposition','chartInteractions','tableFormatting'], array['schemaVersion']) then return false; end if;
  if p_config ? 'chartVariant' and (p_config -> 'chartVariant' not in ('"area"'::jsonb,'"horizontal-bar"'::jsonb,'"combined"'::jsonb,'"heatmap"'::jsonb,'"scatter"'::jsonb) or not p_config ? 'chartInteractions') then return false; end if;
  if p_config ? 'chartComposition' and p_config -> 'chartComposition' not in ('"athletes-v1"'::jsonb,'"metrics-v1"'::jsonb,'"matrix-v1"'::jsonb,'"pairs-v1"'::jsonb) then return false; end if;
  if coalesce(p_config -> 'chartVariant' = '"combined"'::jsonb,false) <> coalesce(p_config -> 'chartComposition' = '"metrics-v1"'::jsonb,false) then return false; end if;
  if p_config ->> 'chartVariant' = 'combined' and p_config #>> '{chartInteractions,yAxis,mode}' = 'fixed' then return false; end if;
  if coalesce(p_config ->> 'chartVariant' = 'heatmap',false) <> coalesce(p_config ->> 'chartComposition' = 'matrix-v1',false) then return false; end if;
  if p_config ->> 'chartVariant' = 'heatmap' and p_config #>> '{chartInteractions,yAxis,mode}' = 'fixed' then return false; end if;
  if coalesce(p_config ->> 'chartVariant' = 'scatter',false) <> coalesce(p_config ->> 'chartComposition' = 'pairs-v1',false) then return false; end if;
  if p_config ->> 'chartVariant' = 'scatter' and (p_config #>> '{chartInteractions,yAxis,mode}' = 'fixed' or p_config #>> '{chartInteractions,zoom,mode}' = 'local' or p_config #> '{chartInteractions,zoom,applyPeriodAction}' = 'true'::jsonb) then return false; end if;
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
    or p_config ->> 'chartVariant' = 'heatmap' and (p_widget_type <> 'bar_chart' or p_group_by not in ('day','week'))
    or p_config ->> 'chartVariant' = 'scatter' and (p_widget_type <> 'line_chart' or p_group_by not in ('day','week'))
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

create function training_load.dashboard_scatter_v1() returns boolean language sql immutable parallel safe as $$ select true; $$;
