import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import {
  EmailConfigError,
  __gmailTransportOptionsForTests,
  __resetBrevoRequestTimeoutMsForTests,
  __resetGmailTransportFactoryForTests,
  __setBrevoRequestTimeoutMsForTests,
  __setGmailTransportFactoryForTests,
  assertEmailConfigValid,
  sendEmailVerification,
} from "../src/email.js";

// Unit tests for backend/src/email.js's provider selection, Gmail/Brevo
// adapters, and production startup validation. Never sends a real email -
// the Gmail transport is always replaced with a mock via
// __setGmailTransportFactoryForTests, and Brevo (which talks HTTPS via the
// built-in fetch, not an injectable client) is exercised by temporarily
// replacing globalThis.fetch. Every test resets both in `after`/on its own
// error path so no test state leaks into other files (same isolation
// discipline used throughout this codebase's test suite).

const ENV_KEYS = ["NODE_ENV", "EMAIL_PROVIDER", "EMAIL_FROM", "EMAIL_REPLY_TO", "GMAIL_USER", "GMAIL_APP_PASSWORD", "BREVO_API_KEY", "RESEND_API_KEY"];
let savedEnv;
const originalFetch = globalThis.fetch;

before(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __resetGmailTransportFactoryForTests();
  __resetBrevoRequestTimeoutMsForTests();
  globalThis.fetch = originalFetch;
});

function setEnv(overrides) {
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      const value = overrides[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

// --- Gmail adapter (mock transport only - never a real send) ---

test("1. sendEmailVerification with EMAIL_PROVIDER=gmail calls the injected mock transport, never a real one", async () => {
  setEnv({ EMAIL_PROVIDER: "gmail", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", GMAIL_USER: "optimovee@gmail.com", GMAIL_APP_PASSWORD: "fake-app-password" });
  const calls = [];
  __setGmailTransportFactoryForTests(() => ({
    sendMail: async (options) => {
      calls.push(options);
      return { messageId: "mock-message-id" };
    },
  }));
  try {
    await sendEmailVerification({
      to: "athlete@test.local",
      verificationUrl: "https://app.example.com/verify-email?token=some-raw-token",
      recipientName: "Athlete",
      contextLabel: "Test Club",
      expiresAt: new Date(Date.now() + 60000),
    });
  } finally {
    __resetGmailTransportFactoryForTests();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "athlete@test.local");
  assert.equal(calls[0].from, "OptiMove <optimovee@gmail.com>");
  assert.ok(calls[0].html.includes("some-raw-token"), "the mock transport call itself legitimately carries the token (that's the email body) - only logging must never carry it");
});

test("2. Gmail adapter passes EMAIL_REPLY_TO through when set, and omits it when unset", async () => {
  setEnv({ EMAIL_PROVIDER: "gmail", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", EMAIL_REPLY_TO: "optimovee@gmail.com", GMAIL_USER: "optimovee@gmail.com", GMAIL_APP_PASSWORD: "fake-app-password" });
  const calls = [];
  __setGmailTransportFactoryForTests(() => ({ sendMail: async (options) => calls.push(options) }));
  try {
    await sendEmailVerification({ to: "a@test.local", verificationUrl: "https://x/verify-email?token=t", expiresAt: new Date() });
  } finally {
    __resetGmailTransportFactoryForTests();
  }
  assert.equal(calls[0].replyTo, "optimovee@gmail.com");

  setEnv({ EMAIL_PROVIDER: "gmail", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", GMAIL_USER: "optimovee@gmail.com", GMAIL_APP_PASSWORD: "fake-app-password" });
  const calls2 = [];
  __setGmailTransportFactoryForTests(() => ({ sendMail: async (options) => calls2.push(options) }));
  try {
    await sendEmailVerification({ to: "a@test.local", verificationUrl: "https://x/verify-email?token=t", expiresAt: new Date() });
  } finally {
    __resetGmailTransportFactoryForTests();
  }
  assert.equal(calls2[0].replyTo, undefined);
});

test("3. Gmail adapter throws a generic EmailSendError (never the raw SMTP error) when the transport rejects", async () => {
  setEnv({ EMAIL_PROVIDER: "gmail", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", GMAIL_USER: "optimovee@gmail.com", GMAIL_APP_PASSWORD: "fake-app-password" });
  __setGmailTransportFactoryForTests(() => ({
    sendMail: async () => {
      throw new Error("535-5.7.8 Username and Password not accepted");
    },
  }));
  try {
    await assert.rejects(
      () => sendEmailVerification({ to: "a@test.local", verificationUrl: "https://x/verify-email?token=t", expiresAt: new Date() }),
      (error) => {
        assert.equal(error.name, "EmailSendError");
        assert.equal(error.message, "Gmail SMTP send failed.");
        assert.ok(!error.message.includes("Username and Password"), "the raw SMTP error text must never surface");
        return true;
      },
    );
  } finally {
    __resetGmailTransportFactoryForTests();
  }
});

test("4. Gmail adapter never falls back to a plain password field - only GMAIL_APP_PASSWORD is read", async () => {
  setEnv({ EMAIL_PROVIDER: "gmail", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", GMAIL_USER: "optimovee@gmail.com" });
  __setGmailTransportFactoryForTests(() => ({ sendMail: async () => {} }));
  try {
    await assert.rejects(
      () => sendEmailVerification({ to: "a@test.local", verificationUrl: "https://x/verify-email?token=t", expiresAt: new Date() }),
      (error) => {
        assert.equal(error.name, "EmailConfigError");
        assert.match(error.message, /GMAIL_APP_PASSWORD/);
        return true;
      },
    );
  } finally {
    __resetGmailTransportFactoryForTests();
  }
});

// --- Brevo adapter (HTTPS API via the built-in fetch - mocked, never a real send) ---

function mockFetchOnce(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return calls;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("15. sendEmailVerification with EMAIL_PROVIDER=brevo POSTs the exact URL, method, headers, and payload", async () => {
  setEnv({ EMAIL_PROVIDER: "brevo", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", BREVO_API_KEY: "fake-brevo-key" });
  const calls = mockFetchOnce(() => jsonResponse(201, { messageId: "mock-message-id" }));
  try {
    await sendEmailVerification({
      to: "athlete@test.local",
      verificationUrl: "https://app.example.com/verify-email?token=some-raw-token",
      recipientName: "Athlete",
      contextLabel: "Test Club",
      expiresAt: new Date(Date.now() + 60000),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(options.method, "POST");
  assert.equal(options.headers["api-key"], "fake-brevo-key");
  assert.equal(options.headers["content-type"], "application/json");
  assert.equal(options.headers.accept, "application/json");
  const body = JSON.parse(options.body);
  assert.deepEqual(body.sender, { email: "optimovee@gmail.com", name: "OptiMove" });
  assert.deepEqual(body.to, [{ email: "athlete@test.local" }]);
  assert.equal(body.subject, "Confirm your email for OptiMove");
  assert.ok(body.htmlContent.includes("some-raw-token"), "the request body itself legitimately carries the token (that's the email content) - only logging must never carry it");
  assert.ok(typeof body.textContent === "string" && body.textContent.length > 0, "a text version must be sent alongside the HTML one");
  assert.equal(body.replyTo, undefined, "EMAIL_REPLY_TO was not set, so replyTo must be omitted entirely");
});

test("16. Brevo adapter passes EMAIL_REPLY_TO through as {email}, and omits it when unset", async () => {
  setEnv({ EMAIL_PROVIDER: "brevo", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", EMAIL_REPLY_TO: "optimovee@gmail.com", BREVO_API_KEY: "fake-brevo-key" });
  const calls = mockFetchOnce(() => jsonResponse(201, {}));
  try {
    await sendEmailVerification({ to: "a@test.local", verificationUrl: "https://x/verify-email?token=t", expiresAt: new Date() });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.replyTo, { email: "optimovee@gmail.com" });
});

test("17. a 2xx Brevo response resolves without throwing", async () => {
  setEnv({ EMAIL_PROVIDER: "brevo", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", BREVO_API_KEY: "fake-brevo-key" });
  mockFetchOnce(() => jsonResponse(201, { messageId: "mock-message-id" }));
  try {
    await assert.doesNotReject(() => sendEmailVerification({ to: "a@test.local", verificationUrl: "https://x/verify-email?token=t", expiresAt: new Date() }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("18. a non-2xx Brevo response throws EmailSendError, logging only status and Brevo's code - never the raw body, secret, address, or token", async () => {
  setEnv({ EMAIL_PROVIDER: "brevo", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", BREVO_API_KEY: "fake-brevo-key" });
  mockFetchOnce(() => jsonResponse(401, { code: "unauthorized", message: "Key not found for api-key fake-brevo-key belonging to account optimovee@gmail.com" }));
  const rawToken = "brevo-raw-token-should-never-log";
  const recipient = "brevo-secret-recipient@test.local";
  const { error, captured } = await captureConsole(() =>
    sendEmailVerification({ to: recipient, verificationUrl: `https://app.example.com/verify-email?token=${rawToken}`, expiresAt: new Date() }),
  );
  globalThis.fetch = originalFetch;

  assert.equal(error.name, "EmailSendError");
  assert.equal(error.message, "Brevo send failed (401/unauthorized).");

  const combined = captured.join("\n");
  assert.ok(combined.includes("401"));
  assert.ok(combined.includes("unauthorized"));
  assert.ok(!combined.includes("Key not found"), "the raw Brevo error message must never be logged");
  assert.ok(!combined.includes("fake-brevo-key"), "the API key must never be logged");
  assert.ok(!combined.includes(rawToken));
  assert.ok(!combined.includes(recipient));
});

test("19. a Brevo network failure throws a generic EmailSendError, logging only that it was a network error - never the raw error text", async () => {
  setEnv({ EMAIL_PROVIDER: "brevo", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", BREVO_API_KEY: "fake-brevo-key" });
  globalThis.fetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.brevo.com");
  };
  const rawToken = "brevo-network-fail-token";
  const recipient = "brevo-network-fail-recipient@test.local";
  const { error, captured } = await captureConsole(() =>
    sendEmailVerification({ to: recipient, verificationUrl: `https://app.example.com/verify-email?token=${rawToken}`, expiresAt: new Date() }),
  );
  globalThis.fetch = originalFetch;

  assert.equal(error.name, "EmailSendError");
  assert.equal(error.message, "Brevo SMTP send failed (network error).");

  const combined = captured.join("\n");
  assert.ok(combined.includes("network_error"));
  assert.ok(!combined.includes("ENOTFOUND"), "the raw network error text must never be logged");
  assert.ok(!combined.includes("fake-brevo-key"));
  assert.ok(!combined.includes(rawToken));
  assert.ok(!combined.includes(recipient));
});

test("20. a Brevo request that never resolves is aborted at the configured timeout and throws a generic timeout EmailSendError", async () => {
  setEnv({ EMAIL_PROVIDER: "brevo", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", BREVO_API_KEY: "fake-brevo-key" });
  __setBrevoRequestTimeoutMsForTests(30);
  globalThis.fetch = (url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const abortError = new Error("This operation was aborted");
        abortError.name = "AbortError";
        reject(abortError);
      });
    });
  const rawToken = "brevo-timeout-token";
  const recipient = "brevo-timeout-recipient@test.local";
  const start = Date.now();
  const { error, captured } = await captureConsole(() =>
    sendEmailVerification({ to: recipient, verificationUrl: `https://app.example.com/verify-email?token=${rawToken}`, expiresAt: new Date() }),
  );
  globalThis.fetch = originalFetch;
  __resetBrevoRequestTimeoutMsForTests();

  assert.ok(Date.now() - start < 5000, "the request must fail fast at the configured timeout, not hang");
  assert.equal(error.name, "EmailSendError");
  assert.equal(error.message, "Brevo send timed out.");

  const combined = captured.join("\n");
  assert.ok(combined.includes("timeout"));
  assert.ok(!combined.includes("fake-brevo-key"));
  assert.ok(!combined.includes(rawToken));
  assert.ok(!combined.includes(recipient));
});

test("12. the Gmail transport uses explicit host/port 587/STARTTLS and finite timeouts, never the service:\"gmail\" shorthand (which resolves to implicit-TLS 465)", () => {
  setEnv({ GMAIL_USER: "optimovee@gmail.com", GMAIL_APP_PASSWORD: "fake-app-password" });
  const options = __gmailTransportOptionsForTests();
  assert.equal(options.host, "smtp.gmail.com");
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.connectionTimeout, 10000);
  assert.equal(options.greetingTimeout, 10000);
  assert.equal(options.socketTimeout, 15000);
  assert.equal(options.service, undefined, "must not use the service:\"gmail\" shorthand");
  assert.equal(options.auth.user, "optimovee@gmail.com");
  assert.equal(options.auth.pass, "fake-app-password");
});

// --- Sanitized diagnostics: only code/responseCode/command may ever be logged ---

function captureConsole(fn) {
  const originalError = console.error;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const captured = [];
  const capture = (...args) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = capture;
  console.log = capture;
  console.warn = capture;
  return fn()
    .then((result) => ({ result, captured }))
    .catch((error) => ({ error, captured }))
    .finally(() => {
      console.error = originalError;
      console.log = originalLog;
      console.warn = originalWarn;
    });
}

test("13. an EAUTH SMTP failure logs only code/responseCode/command - never the raw SMTP response text, the address, or the token", async () => {
  setEnv({ EMAIL_PROVIDER: "gmail", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", GMAIL_USER: "optimovee@gmail.com", GMAIL_APP_PASSWORD: "fake-app-password" });
  __setGmailTransportFactoryForTests(() => ({
    sendMail: async () => {
      const error = new Error("Invalid login: 535-5.7.8 Username and Password not accepted. Learn more at https://support.google.com/mail/?p=BadCredentials");
      error.code = "EAUTH";
      error.responseCode = 535;
      error.command = "AUTH PLAIN";
      throw error;
    },
  }));
  const rawToken = "raw-verification-token-should-never-log";
  const recipient = "secret-recipient@test.local";
  const { error, captured } = await captureConsole(() =>
    sendEmailVerification({ to: recipient, verificationUrl: `https://app.example.com/verify-email?token=${rawToken}`, expiresAt: new Date() }),
  );
  __resetGmailTransportFactoryForTests();

  assert.equal(error.name, "EmailSendError");
  assert.equal(error.message, "Gmail SMTP send failed (EAUTH/535).", "the sanitized code may appear in the internal error message");

  assert.ok(captured.length >= 1, "the failure must produce at least one diagnostic log line");
  const combined = captured.join("\n");
  assert.ok(combined.includes("EAUTH"));
  assert.ok(combined.includes("535"));
  assert.ok(combined.includes("AUTH PLAIN"));
  assert.ok(!combined.includes("Username and Password"), "the raw SMTP response text must never be logged");
  assert.ok(!combined.includes("BadCredentials"), "the raw SMTP response text must never be logged");
  assert.ok(!combined.includes(rawToken), "the raw verification token must never be logged");
  assert.ok(!combined.includes(recipient), "the recipient address must never be logged");
  assert.ok(!combined.includes("fake-app-password"), "the app password must never be logged");
});

test("14. an ETIMEDOUT connection failure logs only a safe code - never the raw error text, the address, or the token", async () => {
  setEnv({ EMAIL_PROVIDER: "gmail", EMAIL_FROM: "OptiMove <optimovee@gmail.com>", GMAIL_USER: "optimovee@gmail.com", GMAIL_APP_PASSWORD: "fake-app-password" });
  __setGmailTransportFactoryForTests(() => ({
    sendMail: async () => {
      const error = new Error("Connection timeout at smtp.gmail.com:587 after 10000ms - ETIMEDOUT");
      error.code = "ETIMEDOUT";
      throw error;
    },
  }));
  const rawToken = "raw-verification-token-should-never-log-either";
  const recipient = "another-secret-recipient@test.local";
  const { error, captured } = await captureConsole(() =>
    sendEmailVerification({ to: recipient, verificationUrl: `https://app.example.com/verify-email?token=${rawToken}`, expiresAt: new Date() }),
  );
  __resetGmailTransportFactoryForTests();

  assert.equal(error.name, "EmailSendError");
  assert.equal(error.message, "Gmail SMTP send failed (ETIMEDOUT).");

  const combined = captured.join("\n");
  assert.ok(combined.includes("ETIMEDOUT"));
  assert.ok(!combined.includes("Connection timeout at smtp.gmail.com:587 after 10000ms"), "the raw error message must never be logged");
  assert.ok(!combined.includes(rawToken));
  assert.ok(!combined.includes(recipient));
  assert.ok(!combined.includes("fake-app-password"));
});

// --- assertEmailConfigValid: production startup validation ---

test("5. assertEmailConfigValid is a no-op outside production, even with nothing configured", () => {
  setEnv({ NODE_ENV: "test" });
  assert.doesNotThrow(() => assertEmailConfigValid());
});

test("6. production with no EMAIL_PROVIDER refuses to start", () => {
  setEnv({ NODE_ENV: "production" });
  assert.throws(() => assertEmailConfigValid(), EmailConfigError);
});

test("7. production with EMAIL_PROVIDER=gmail missing GMAIL_USER/GMAIL_APP_PASSWORD/EMAIL_FROM refuses to start", () => {
  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "gmail" });
  assert.throws(() => assertEmailConfigValid(), /GMAIL_USER/);

  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "gmail", GMAIL_USER: "optimovee@gmail.com" });
  assert.throws(() => assertEmailConfigValid(), /GMAIL_APP_PASSWORD/);

  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "gmail", GMAIL_USER: "optimovee@gmail.com", GMAIL_APP_PASSWORD: "app-password" });
  assert.throws(() => assertEmailConfigValid(), /EMAIL_FROM/);
});

test("8. production with EMAIL_PROVIDER=gmail and all three required vars set does not throw", () => {
  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "gmail", GMAIL_USER: "optimovee@gmail.com", GMAIL_APP_PASSWORD: "app-password", EMAIL_FROM: "OptiMove <optimovee@gmail.com>" });
  assert.doesNotThrow(() => assertEmailConfigValid());
});

test("21. production with EMAIL_PROVIDER=brevo missing BREVO_API_KEY/EMAIL_FROM refuses to start", () => {
  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "brevo" });
  assert.throws(() => assertEmailConfigValid(), /BREVO_API_KEY/);

  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "key" });
  assert.throws(() => assertEmailConfigValid(), /EMAIL_FROM/);
});

test("22. production with EMAIL_PROVIDER=brevo and both required vars set does not throw", () => {
  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "key", EMAIL_FROM: "OptiMove <optimovee@gmail.com>" });
  assert.doesNotThrow(() => assertEmailConfigValid());
});

test("9. production with EMAIL_PROVIDER=resend missing RESEND_API_KEY/EMAIL_FROM refuses to start", () => {
  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "resend" });
  assert.throws(() => assertEmailConfigValid(), /RESEND_API_KEY/);

  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "key" });
  assert.throws(() => assertEmailConfigValid(), /EMAIL_FROM/);

  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "key", EMAIL_FROM: "OptiMove <a@b.com>" });
  assert.doesNotThrow(() => assertEmailConfigValid());
});

test("10. production with EMAIL_PROVIDER=dev or console always refuses to start", () => {
  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "dev" });
  assert.throws(() => assertEmailConfigValid(), EmailConfigError);

  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "console" });
  assert.throws(() => assertEmailConfigValid(), EmailConfigError);
});

test("11. production with an unrecognized EMAIL_PROVIDER refuses to start", () => {
  setEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "sendgrid" });
  assert.throws(() => assertEmailConfigValid(), /Unsupported EMAIL_PROVIDER/);
});
