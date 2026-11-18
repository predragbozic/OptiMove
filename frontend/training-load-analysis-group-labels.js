import { formatDate } from "./utils.js";

// Build once from result order, before charts partition or reorder rows.
export function dashboardGroupLabels(model) {
  const labels = new Map();
  const kind = model.groupBy === "session" ? "Session" : model.groupBy === "component" ? "Component" : "Group";
  let next = 1;
  for (const series of model.series) {
    for (const row of series.current) {
      const key = row.identity.bucketKey ?? "";
      if (labels.has(key)) continue;
      if (key && row.identity.athleteId && String(key).toLowerCase() === String(row.identity.athleteId).toLowerCase()) {
        labels.set(key, "");
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
        labels.set(key, formatDate(key));
      } else if (/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|[{}\[\]]/i.test(String(key))) {
        labels.set(key, `${kind} ${next++}`);
      } else {
        labels.set(key, typeof key === "string" ? key : "");
      }
    }
  }
  return labels;
}
