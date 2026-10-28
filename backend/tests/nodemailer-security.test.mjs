import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import nodemailer from "nodemailer";
import { __gmailTransportOptionsForTests, __setGmailTransportFactoryForTests, __resetGmailTransportFactoryForTests, sendEmailVerification } from "../src/email.js";

const keys = ["EMAIL_PROVIDER", "EMAIL_FROM", "EMAIL_REPLY_TO", "GMAIL_USER", "GMAIL_APP_PASSWORD"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  __resetGmailTransportFactoryForTests();
  for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
});
function configure() {
  process.env.EMAIL_PROVIDER = "gmail";
  process.env.EMAIL_FROM = "OptiMove <sender@example.test>";
  process.env.EMAIL_REPLY_TO = "Support <support@example.test>";
  process.env.GMAIL_USER = "sender@example.test";
  process.env.GMAIL_APP_PASSWORD = "offline-fixture-password";
}
const verification = { verificationUrl: "https://app.example.test/verify-email?token=offline-fixture", recipientName: "Athlete", contextLabel: "Fixture Club", expiresAt: new Date("2030-01-01T00:00:00Z") };

for (const [recipient, envelope] of [
  ["athlete@example.test", "athlete@example.test"],
  ['"Athlete; other@unwanted.test" <athlete@example.test>', "athlete@example.test"],
  ['Athlete (outer (nested) other@unwanted.test) <athlete@example.test>', "athlete@example.test"],
  ["Athlete <athlete@bücher.test>", "athlete@xn--bcher-kva.test"],
]) {
  test(`real Nodemailer serialization keeps a single intended recipient: ${envelope}, ${recipient.length} characters`, async () => {
    configure();
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    let info, options;
    __setGmailTransportFactoryForTests(() => ({ sendMail: async (mail) => { options = mail; info = await transport.sendMail(mail); return info; } }));
    try {
      await sendEmailVerification({ ...verification, to: recipient });
      assert.deepEqual(info.envelope, { from: "sender@example.test", to: [envelope] });
      assert.equal(options.replyTo, "Support <support@example.test>");
      assert.match(options.text, /https:\/\/app\.example\.test\/verify-email\?token=offline-fixture/);
      assert.match(options.html, /offline-fixture/);
      const mime = info.message.toString();
      assert.match(mime, /^From: OptiMove <sender@example\.test>/m);
      assert.match(mime, /^Reply-To: Support <support@example\.test>/m);
      assert.match(mime, /Content-Type: multipart\/alternative/);
      assert.ok(!/^Bcc:/m.test(mime));
    } finally { transport.close(); }
  });
}
test("real SMTP transport refuses missing STARTTLS before sending authentication credentials", async () => {
  configure();
  const commands = [], sockets = new Set();
  const smtp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("220 fixture.example.test ESMTP\r\n");
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      let end;
      while ((end = pending.indexOf("\r\n")) !== -1) {
        const command = pending.slice(0, end); pending = pending.slice(end + 2);
        commands.push(command.split(" ")[0]);
        if (/^EHLO /i.test(command)) socket.write("250-fixture.example.test\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (/^STARTTLS$/i.test(command)) socket.write("502 TLS unavailable\r\n");
        else socket.write("500 unexpected command\r\n");
      }
    });
  });
  await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const transport = nodemailer.createTransport({ ...__gmailTransportOptionsForTests(), host: "127.0.0.1", port: smtp.address().port, connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 2000 });
  try {
    await assert.rejects(transport.sendMail({ from: "sender@example.test", to: "athlete@example.test", subject: "offline", text: "fixture" }), (error) => error.code === "ETLS");
    assert.ok(commands.includes("STARTTLS"));
    assert.ok(!commands.includes("AUTH"), "credentials must never be sent over plaintext SMTP");
  } finally {
    transport.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => smtp.close(resolve));
  }
});
