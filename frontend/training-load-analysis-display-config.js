const WIDGET_TYPES = new Set(["kpi", "table", "line_chart", "bar_chart"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function normalizeDashboardDisplayConfig(widget) {
  const original = widget?.display_config;
  const effective = {
    schemaVersion: 2,
    numberFormat: { maximumFractionDigits: 1 },
    legend: { visible: true },
    valueLabels: { visible: false },
  };
  const issues = [];
  const issue = (code, path) => issues.push({ code, path });
  let status = "ready";
  let sourceVersion = null;
  if (!WIDGET_TYPES.has(widget?.widget_type)) issue("unsupportedWidgetType", "widget_type");
  if (original === null || original === undefined) {
    sourceVersion = 1;
  } else if (!plainObject(original)) {
    issue("invalidDisplayConfig", "display_config");
  } else if (original.schemaVersion === 1) {
    sourceVersion = 1;
  } else if (Number.isSafeInteger(original.schemaVersion) && original.schemaVersion > 0 && original.schemaVersion !== 2) {
    sourceVersion = original.schemaVersion;
    status = "unsupported";
    issue("unsupportedDisplayConfigVersion", "schemaVersion");
  } else if (original.schemaVersion === 2) {
    sourceVersion = 2;
    for (const key of Object.keys(original)) {
      if (!["schemaVersion", "numberFormat", "legend", "valueLabels"].includes(key)) issue("unknownDisplayConfigField", key);
    }
    for (const [key, field] of [["numberFormat", "maximumFractionDigits"], ["legend", "visible"], ["valueLabels", "visible"]]) {
      if (!Object.hasOwn(original, key)) continue;
      const section = original[key];
      if (!plainObject(section)) {
        issue("invalidDisplayConfigField", key);
        continue;
      }
      for (const sectionKey of Object.keys(section)) {
        if (sectionKey !== field) issue("unknownDisplayConfigField", `${key}.${sectionKey}`);
      }
      if (!Object.hasOwn(section, field)) continue;
      const value = section[field];
      const valid = key === "numberFormat" ? Number.isInteger(value) && value >= 0 && value <= 6 : typeof value === "boolean";
      if (valid) effective[key][field] = value;
      else issue("invalidDisplayConfigField", `${key}.${field}`);
    }
  } else {
    issue("invalidDisplayConfigVersion", "schemaVersion");
  }
  if (issues.length && status === "ready") status = "invalid";
  return { status, sourceVersion, effective, issues };
}
