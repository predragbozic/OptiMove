create or replace function training_load.dashboard_presentation_valid(p_config jsonb)
returns boolean language plpgsql immutable parallel safe as $$
declare
  interactions jsonb;
  section jsonb;
  component jsonb;
  threshold_rule jsonb;
  threshold_value jsonb;
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
    if not training_load.dashboard_simple_object(section, array['evaluationVersion','rules','metricVersionId'], array['evaluationVersion','rules'])
      or section -> 'evaluationVersion' <> '1'::jsonb
      or jsonb_typeof(section -> 'rules') is distinct from 'array' then return false; end if;
    if section ? 'metricVersionId' and (
      jsonb_typeof(section -> 'metricVersionId') is distinct from 'string'
      or (section ->> 'metricVersionId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_array_length(section -> 'rules') <> 1
    ) then return false; end if;
    if jsonb_array_length(section -> 'rules') > 1 then return false; end if;
    if jsonb_array_length(section -> 'rules') = 1 then
      threshold_rule := section #> '{rules,0}';
      threshold_value := threshold_rule -> 'threshold';
      if jsonb_typeof(threshold_value -> 'value') is distinct from 'number'
        or coalesce(jsonb_typeof(threshold_value -> 'unit'), '') not in ('string', 'null') then return false; end if;
      if abs((threshold_value ->> 'value')::numeric) > 1.7976931348623157e308::numeric
        or threshold_value <> jsonb_build_object('value', threshold_value -> 'value', 'unit', threshold_value -> 'unit')
        or threshold_rule <> jsonb_build_object(
          'id', 'simple-above', 'priority', 1, 'enabled', true, 'name', 'Upper threshold',
          'target', '{"series":"main","phase":"current","cell":"value","athletes":{"mode":"allReturned"}}'::jsonb,
          'operand', 'value', 'operator', 'gt', 'threshold', threshold_value,
          'style', '{"tone":"caution","marker":"up","label":"Above threshold"}'::jsonb
        ) then return false; end if;
    end if;
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

create function training_load.dashboard_catalog_threshold_v1()
returns boolean language sql immutable parallel safe as $$ select true; $$;
