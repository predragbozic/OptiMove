// Central email-sending service (feature/email-verification-foundation) -
// routes must never call an email provider directly; everything goes
// through sendEmailVerification below. Configuration is entirely via
// environment variables - no hardcoded keys, no provider-specific code
// anywhere outside this file.
//
// Required env vars:
//   EMAIL_PROVIDER   "resend" | "dev" | "console" - required in production;
//                     defaults to "dev" everywhere else if unset.
//   EMAIL_FROM       sender address - required when EMAIL_PROVIDER=resend.
//   EMAIL_REPLY_TO   optional reply-to address.
//   RESEND_API_KEY   required when EMAIL_PROVIDER=resend.
//   PUBLIC_APP_URL   (not read here - see backend/src/appOrigin.js) used by
//                     callers to build the verificationUrl this module sends.
const isProduction = process.env.NODE_ENV === "production";

export class EmailConfigError extends Error {}
export class EmailSendError extends Error {}

function resolveProvider() {
  const configured = String(process.env.EMAIL_PROVIDER || "").trim().toLowerCase();
  if (configured) return configured;
  // No explicit choice: production must never silently pretend to send an
  // email it never sent - every other environment (local dev, automated
  // tests) defaults to the safe dev adapter instead.
  return isProduction ? null : "dev";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function buildVerificationEmail({ verificationUrl, recipientName, contextLabel, expiresAt }) {
  const subject = "Confirm your email for OptiMove";
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";
  const expiresLabel = new Date(expiresAt).toUTCString();
  const label = contextLabel || "OptiMove";
  const text = [
    greeting,
    "",
    `Please confirm your email to finish your join request for ${label}.`,
    "",
    `Verify email: ${verificationUrl}`,
    "",
    `This link expires ${expiresLabel}.`,
    "",
    "If you did not submit this request, you can safely ignore this email.",
  ].join("\n");
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>Please confirm your email to finish your join request for <strong>${escapeHtml(label)}</strong>.</p>`,
    `<p><a href="${escapeHtml(verificationUrl)}">Verify email</a></p>`,
    `<p>This link expires ${escapeHtml(expiresLabel)}.</p>`,
    "<p>If you did not submit this request, you can safely ignore this email.</p>",
  ].join("\n");
  return { subject, text, html };
}

async function sendViaResend({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = String(process.env.EMAIL_FROM || "").trim();
  if (!apiKey) throw new EmailConfigError("RESEND_API_KEY is not configured.");
  if (!from) throw new EmailConfigError("EMAIL_FROM is not configured.");
  const replyTo = String(process.env.EMAIL_REPLY_TO || "").trim() || undefined;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!response.ok) {
    // Never logs the response body (could echo request contents) or the API
    // key - only the status code, which carries no secret.
    throw new EmailSendError(`Resend responded with status ${response.status}.`);
  }
}

// Never sends a real email - the safe default for local development and
// automated tests. Logs the verification link itself (not a secret env
// var - the caller already returns it in the API response outside
// production) so a developer running locally can click through it.
function sendViaDevAdapter({ to, subject, verificationUrl }) {
  console.log(`[email:dev] would send "${subject}" to ${to}${verificationUrl ? ` - link: ${verificationUrl}` : ""}`);
}

export async function sendEmailVerification({ to, verificationUrl, recipientName, contextLabel, expiresAt }) {
  const provider = resolveProvider();
  if (!provider) {
    // Loud, specific failure - never a silent "pretend it worked" when a
    // production deploy is missing its email configuration.
    throw new EmailConfigError("EMAIL_PROVIDER is not configured.");
  }
  const { subject, text, html } = buildVerificationEmail({ verificationUrl, recipientName, contextLabel, expiresAt });
  if (provider === "resend") {
    await sendViaResend({ to, subject, html, text });
    return;
  }
  if (provider === "dev" || provider === "console") {
    sendViaDevAdapter({ to, subject, verificationUrl });
    return;
  }
  throw new EmailConfigError(`Unsupported EMAIL_PROVIDER: "${provider}".`);
}
