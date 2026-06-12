import { startSmtpSink } from "../mail/smtp-sink.js";
import { logger } from "../utils/logger.js";

export interface MailCommandOptions {
  to?: string;
  port?: number;
  timeout?: number;
  json?: boolean;
}

/**
 * Start a local SMTP capture sink, wait for a verification email, and print the
 * extracted one-time code. Point the app-under-test's SMTP at this host:port in
 * its dev/staging config, then run a signup/login flow in the browser session.
 *
 *   skeptic mail --to user@test.com --port 2525 --timeout 60000
 */
export const runMail = async (opts: MailCommandOptions): Promise<void> => {
  const port = opts.port ?? 2525;
  const timeoutMs = opts.timeout ?? 60_000;

  let sink;
  try {
    sink = await startSmtpSink(port);
  } catch (err) {
    logger.error(`mail: could not start SMTP sink on port ${port}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // Listening info to stderr so --json stdout stays clean/parseable.
  process.stderr.write(
    `[skeptic] SMTP sink listening on 127.0.0.1:${sink.port} — point the app's SMTP here, then trigger the email.\n`,
  );

  try {
    const mail = await sink.waitFor({
      ...(opts.to ? { to: opts.to } : {}),
      timeoutMs,
    });
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({
          success: true,
          data: { port: sink.port, from: mail.from, to: mail.to, subject: mail.subject, otp: mail.otp, body: mail.body },
        })}\n`,
      );
    } else if (mail.otp) {
      process.stdout.write(`${mail.otp}\n`);
    } else {
      process.stdout.write(`(no code found)\nSubject: ${mail.subject}\n${mail.body}\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) process.stdout.write(`${JSON.stringify({ success: false, error: message })}\n`);
    else logger.error(`mail: ${message}`);
    process.exitCode = 1;
  } finally {
    await sink.close();
  }
};
