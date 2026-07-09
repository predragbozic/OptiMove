import { clean } from "./utils.js";

export function duplicateTemplateNames(templates) {
  const counts = new Map();
  templates.forEach((template) => {
    const name = clean(template.plan_name);
    if (!name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

export function templateSecondaryLabel() {
  return "";
}

export function templateCategoryLabel(template) {
  return clean(template.library_category) || inferProgramCategory(template) || "General";
}

export function inferProgramCategory(template) {
  const text = `${template.plan_name || ""} ${template.source_external_id || ""}`.toLowerCase();
  if (/(rehab|rechab|rtp|return|injury|pain|calf|groin|neck)/.test(text)) return "Rehabilitation";
  if (/(strength|strenght|power|gym|core|legs|arms)/.test(text)) return "Strength & power";
  if (/(speed|sprint|acceleration|deceleration|running)/.test(text)) return "Speed & conditioning";
  if (/(mobility|stability|activation|warm)/.test(text)) return "Movement prep";
  return "";
}

export function programPriceLabel(template) {
  const accessModel = template.access_model || (template.is_free === false ? "one_time_forever" : "free_forever");
  const durationDays = Number(template.access_duration_days || 0);
  if (template.is_free === false) {
    const price = template.price_cents ? `${Math.round(template.price_cents / 100)} EUR` : "Paid";
    if (accessModel === "subscription") return `${price} / ${template.subscription_period || "month"}`;
    if (durationDays) return `${price} - ${durationDays} days`;
    return price;
  }
  if (accessModel === "trial") return durationDays ? `Free trial - ${durationDays} days` : "Free trial";
  if (accessModel === "time_limited") return durationDays ? `Free - ${durationDays} days` : "Time-limited";
  if (accessModel === "assigned") return "Assigned";
  return "Free";
}

export function ratingLabel(entity) {
  const count = Number(entity?.review_count || 0);
  if (!count) return "No reviews yet";
  const average = Number(entity?.average_rating || 0);
  return `${average.toFixed(average % 1 ? 1 : 0)} / 5 (${count})`;
}

export function programInfoModel(program) {
  const tags = (program.tags || []).map((tag) => clean(tag.name)).filter(Boolean);
  return {
    title: program.plan_name || "Program",
    group: templateCategoryLabel(program),
    creator: clean(program.creator_name),
    description: clean(program.description || program.program_note || program.short_note || program.note),
    price: programPriceLabel(program),
    tags,
  };
}
