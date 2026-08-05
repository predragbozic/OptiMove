// Central email-sending service (feature/email-verification-foundation) -
// routes must never call an email provider directly, and must never know
// which provider is configured; everything goes through
// sendEmailVerification below. Configuration is entirely via environment
// variables - no hardcoded keys, no provider-specific code anywhere outside
// this file.
//
// Env vars:
//   EMAIL_PROVIDER     "gmail" | "resend" | "dev" | "console" - required in
//                       production (see assertEmailConfigValid); defaults to
//                       "dev" everywhere else if unset.
//   EMAIL_FROM         sender address - required for gmail/resend.
//   EMAIL_REPLY_TO      optional reply-to address.
//   GMAIL_USER         required when EMAIL_PROVIDER=gmail.
//   GMAIL_APP_PASSWORD  required when EMAIL_PROVIDER=gmail - a Gmail App
//                       Password, NEVER the account's own login password.
//                       Read only from this environment variable, never
//                       logged, never hardcoded.
//   RESEND_API_KEY     required when EMAIL_PROVIDER=resend.
//   PUBLIC_APP_URL     (not read here - see backend/src/appOrigin.js) used by
//                       callers to build the verificationUrl this module sends.
//
// Nothing in this file ever logs a raw verification token, a raw
// verification URL, or any secret (API key / app password) - not on
// success, not on failure, in any environment. Callers that need the raw
// token for automated tests get it back through the API response
// (non-production only), never through a log line.
import nodemailer from "nodemailer";

// Read fresh on every call, never cached at module-load time - this module
// is imported long before server.js decides whether to call
// assertEmailConfigValid, and tests need to be able to exercise both
// production and non-production behavior within a single process.
function isProduction() {
  return process.env.NODE_ENV === "production";
}

export class EmailConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmailConfigError";
  }
}
export class EmailSendError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmailSendError";
  }
}

function resolveProvider() {
  const configured = String(process.env.EMAIL_PROVIDER || "").trim().toLowerCase();
  if (configured) return configured;
  // No explicit choice: production must never silently pretend to send an
  // email it never sent - every other environment (local dev, automated
  // tests) defaults to the safe dev adapter instead.
  return isProduction() ? null : "dev";
}

// Called once at server startup (see backend/src/server.js) - never at
// import time, so tests that merely import this module (with NODE_ENV
// unset) never trigger it. In production, refuses to let the process start
// at all if the configured provider is missing what it needs, rather than
// accepting join requests it can never actually deliver a verification
// email for.
export function assertEmailConfigValid() {
  if (!isProduction()) return;
  const provider = resolveProvider();
  if (!provider) {
    throw new EmailConfigError("EMAIL_PROVIDER must be set in production.");
  }
  if (provider === "gmail") {
    if (!String(process.env.GMAIL_USER || "").trim()) throw new EmailConfigError("GMAIL_USER is required when EMAIL_PROVIDER=gmail.");
    if (!process.env.GMAIL_APP_PASSWORD) throw new EmailConfigError("GMAIL_APP_PASSWORD is required when EMAIL_PROVIDER=gmail.");
    if (!String(process.env.EMAIL_FROM || "").trim()) throw new EmailConfigError("EMAIL_FROM is required when EMAIL_PROVIDER=gmail.");
    return;
  }
  if (provider === "resend") {
    if (!process.env.RESEND_API_KEY) throw new EmailConfigError("RESEND_API_KEY is required when EMAIL_PROVIDER=resend.");
    if (!String(process.env.EMAIL_FROM || "").trim()) throw new EmailConfigError("EMAIL_FROM is required when EMAIL_PROVIDER=resend.");
    return;
  }
  if (provider === "dev" || provider === "console") {
    throw new EmailConfigError('EMAIL_PROVIDER="dev"/"console" never sends a real email and is not allowed in production - configure "gmail" or "resend".');
  }
  throw new EmailConfigError(`Unsupported EMAIL_PROVIDER: "${provider}".`);
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

// Explicit STARTTLS config on port 587 - NOT nodemailer's `service: "gmail"`
// shorthand, which resolves to implicit TLS on port 465. Render's outbound
// network reaches Gmail fine on 587/STARTTLS but was silently failing (or
// hanging until a generic timeout) against 465 in production - hence the
// explicit host/port/secure/requireTLS and the finite timeouts below, so a
// bad connection fails fast with a classifiable error instead of hanging.
function gmailTransportOptions() {
  return {
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  };
}

// Test-only: lets a test assert on the exact options this module would pass
// to nodemailer.createTransport, without needing to mock nodemailer itself.
export function __gmailTransportOptionsForTests() {
  return gmailTransportOptions();
}

// Overridable only by backend/tests/email-service.test.mjs, so tests can
// inject a mock transport and never send a real email through a real Gmail
// account. No route or other application code ever calls this.
let gmailTransportFactory = () => nodemailer.createTransport(gmailTransportOptions());

export function __setGmailTransportFactoryForTests(factory) {
  gmailTransportFactory = factory;
}

export function __resetGmailTransportFactoryForTests() {
  gmailTransportFactory = () => nodemailer.createTransport(gmailTransportOptions());
}

// Pulls out only the non-sensitive diagnostic fields an SMTP/nodemailer
// error may carry - code (e.g. "EAUTH", "ETIMEDOUT"), responseCode (the SMTP
// status, e.g. 535), and command (e.g. "AUTH PLAIN"). These are short,
// protocol-defined enums/strings, never the raw error message or SMTP
// response text, which can echo connection details or (in some client
// error shapes) fragments of the request itself. Used both for the safe
// startup-to-console diagnostic log and to build EmailSendError's message.
function sanitizeSmtpError(error) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  const responseCode = typeof error?.responseCode === "number" ? error.responseCode : undefined;
  const command = typeof error?.command === "string" ? error.command : undefined;
  return { code, responseCode, command };
}

async function sendViaGmail({ to, subject, html, text }) {
  const user = String(process.env.GMAIL_USER || "").trim();
  // A Gmail APP PASSWORD, generated in the Google Account's own security
  // settings - never the account's normal login password, and never
  // anything other than this one environment variable. This module never
  // asks for, accepts, or falls back to a plain account password.
  const pass = process.env.GMAIL_APP_PASSWORD;
  const from = String(process.env.EMAIL_FROM || "").trim();
  if (!user) throw new EmailConfigError("GMAIL_USER is not configured.");
  if (!pass) throw new EmailConfigError("GMAIL_APP_PASSWORD is not configured.");
  if (!from) throw new EmailConfigError("EMAIL_FROM is not configured.");
  const replyTo = String(process.env.EMAIL_REPLY_TO || "").trim() || undefined;
  const transport = gmailTransportFactory();
  try {
    await transport.sendMail({ from, to, subject, html, text, ...(replyTo ? { replyTo } : {}) });
  } catch (error) {
    // Never logs the caught error directly, its message, or its response
    // text - some SMTP client error shapes embed the SMTP server's full
    // response line, which can echo back connection/auth detail. Only the
    // three sanitized, protocol-level fields below are ever written to the
    // console - no recipient address, no email content, no verification
    // URL/token, no secret.
    const { code, responseCode, command } = sanitizeSmtpError(error);
    console.error("[email:gmail] send failed", { code, responseCode, command });
    const label = [code, responseCode].filter((part) => part !== undefined).join("/");
    throw new EmailSendError(label ? `Gmail SMTP send failed (${label}).` : "Gmail SMTP send failed.");
  }
}

// Never sends a real email - the safe default for local development and
// automated tests. Deliberately logs ONLY the recipient and subject - never
// the verification link or token, in any environment. A developer running
// locally gets the raw token/link through the API response instead (see
// POST /api/auth/join-links/:token/apply's devVerificationToken field,
// non-production only).
function sendViaDevAdapter({ to, subject }) {
  console.log(`[email:dev] would send "${subject}" to ${to}`);
}

export async function sendEmailVerification({ to, verificationUrl, recipientName, contextLabel, expiresAt }) {
  const provider = resolveProvider();
  if (!provider) {
    // Loud, specific failure - never a silent "pretend it worked" when a
    // production deploy is missing its email configuration.
    throw new EmailConfigError("EMAIL_PROVIDER is not configured.");
  }
  const { subject, text, html } = buildVerificationEmail({ verificationUrl, recipientName, contextLabel, expiresAt });
  if (provider === "gmail") {
    await sendViaGmail({ to, subject, html, text });
    return;
  }
  if (provider === "resend") {
    await sendViaResend({ to, subject, html, text });
    return;
  }
  if (provider === "dev" || provider === "console") {
    sendViaDevAdapter({ to, subject });
    return;
  }
  throw new EmailConfigError(`Unsupported EMAIL_PROVIDER: "${provider}".`);
}
