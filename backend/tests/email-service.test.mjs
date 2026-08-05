import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import {
  EmailConfigError,
  __resetGmailTransportFactoryForTests,
  __setGmailTransportFactoryForTests,
  assertEmailConfigValid,
  sendEmailVerification,
} from "../src/email.js";

// Unit tests for backend/src/email.js's provider selection, Gmail adapter,
// and production startup validation. Never sends a real email - the Gmail
// transport is always replaced with a mock via
// __setGmailTransportFactoryForTests, which every test resets in `after`/on
// its own error path so no test state leaks into other files (same
// isolation discipline used throughout this codebase's test suite).

const ENV_KEYS = ["NODE_ENV", "EMAIL_PROVIDER", "EMAIL_FROM", "EMAIL_REPLY_TO", "GMAIL_USER", "GMAIL_APP_PASSWORD", "RESEND_API_KEY"];
let savedEnv;

before(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __resetGmailTransportFactoryForTests();
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
