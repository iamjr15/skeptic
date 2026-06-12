import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { startSmtpSink, type SmtpSinkHandle } from "../../../src/mail/smtp-sink.js";

/** Speak just enough SMTP to deliver one message to the sink. */
const sendMail = (port: number, from: string, to: string, message: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const conn = net.createConnection(port, "127.0.0.1");
    conn.setEncoding("utf8");
    const steps = [
      `HELO test`,
      `MAIL FROM:<${from}>`,
      `RCPT TO:<${to}>`,
      `DATA`,
      `${message}\r\n.`,
      `QUIT`,
    ];
    let i = 0;
    conn.on("data", () => {
      if (i < steps.length) conn.write(`${steps[i++]}\r\n`);
      else {
        conn.end();
        resolve();
      }
    });
    conn.on("error", reject);
  });

describe("startSmtpSink (round-trip)", () => {
  let sink: SmtpSinkHandle | null = null;
  afterEach(async () => {
    if (sink) await sink.close();
    sink = null;
  });

  it("captures a delivered email and extracts its OTP", async () => {
    sink = await startSmtpSink(0);
    const waiting = sink.waitFor({ to: "user@test.com", timeoutMs: 5000 });
    await sendMail(
      sink.port,
      "noreply@app.com",
      "user@test.com",
      "Subject: Verify your email\r\nFrom: noreply@app.com\r\nTo: user@test.com\r\n\r\nYour verification code is 654321.",
    );
    const mail = await waiting;
    expect(mail.subject).toBe("Verify your email");
    expect(mail.to).toContain("user@test.com");
    expect(mail.otp).toBe("654321");
  });

  it("rejects waitFor on timeout when no matching email arrives", async () => {
    sink = await startSmtpSink(0);
    await expect(sink.waitFor({ to: "nobody@test.com", timeoutMs: 200 })).rejects.toThrow(/no matching email/);
  });

  it("filters by recipient", async () => {
    sink = await startSmtpSink(0);
    await sendMail(sink.port, "a@app.com", "alice@test.com", "Subject: A\r\n\r\ncode 111111");
    await sendMail(sink.port, "a@app.com", "bob@test.com", "Subject: B\r\n\r\ncode 222222");
    const bob = await sink.waitFor({ to: "bob@test.com", timeoutMs: 2000 });
    expect(bob.otp).toBe("222222");
  });
});
