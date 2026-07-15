import { clean } from "./utils.js";

export function isAthleteUser(user) {
  return clean(user?.role).toLowerCase() === "athlete" || clean(user?.accessScope).toLowerCase() === "athlete";
}

export function templateAccessStatusCode(template) {
  return clean(template?.user_access_status).toLowerCase();
}

export function templateAccessStatusLabel(template) {
  const status = templateAccessStatusCode(template);
  if (status === "requested") return "Requested";
  if (status === "rejected") return "Rejected";
  if (status === "accessed") return "Approved";
  if (status === "used") return "Used";
  if (status === "completed") return "Completed";
  return "";
}

export function hasTemplateAccessStatus(template) {
  return Boolean(templateAccessStatusLabel(template));
}

export function hasActiveTemplateAccess(template) {
  return ["accessed", "used", "completed"].includes(templateAccessStatusCode(template));
}

export function templateAccessActionLabel(template, user) {
  if (!isAthleteUser(user)) return "Preview";
  const status = templateAccessStatusCode(template);
  if (status === "requested") return "Request sent";
  if (status === "rejected") return "Request again";
  if (status === "accessed") return "Mark as used";
  if (status === "used" || status === "completed") return "Access active";
  return template?.requires_approval === true ? "Request access" : "Get access";
}

export function templateAccessHelperText(template, review = {}) {
  const status = templateAccessStatusCode(template);
  const isRequested = review.requestSent || status === "requested";
  const isRejected = status === "rejected";
  const isApproved = status === "accessed";
  const isUsed = review.usedMarked || status === "used" || status === "completed";
  if (isRequested) return "Your request is waiting for coach approval.";
  if (isRejected) return "Your coach did not approve this program request. You can send a new request if needed.";
  if (isApproved) return "Access is approved. Mark it as used when you start working with this program.";
  if (isUsed) return "Access is active. You can leave a verified review for this program.";
  if (template?.requires_approval === true) return "Your coach must approve this program before it becomes active.";
  return "Reviews are enabled after access is active and the program has been used.";
}
