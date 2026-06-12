import * as net from "node:net";
import { extractOtp } from "./otp.js";

export interface CapturedMail {
  from: string;
  to: string[];
  subject: string;
  body: string;
  /** Best-effort one-time code extracted from the body. */
  otp: string | null;
  receivedAt: number;
}

export interface SmtpSinkHandle {
  readonly port: number;
  /** Resolve when a mail matching `to` (substring, case-insensitive) arrives, or reject on timeout. */
  waitFor(opts: { to?: string; timeoutMs: number }): Promise<CapturedMail>;
  messages(): CapturedMail[];
  close(): Promise<void>;
}

/**
 * Minimal in-memory SMTP capture server for OTP/verification-email testing. No
 * external service, no auth, no delivery — it just accepts mail and records it.
 * Point the app-under-test's SMTP at this host:port in a dev/staging config.
 */
export const startSmtpSink = async (port = 0): Promise<SmtpSinkHandle> => {
  const captured: CapturedMail[] = [];
  const waiters: Array<{ match: (m: CapturedMail) => boolean; resolve: (m: CapturedMail) => void }> = [];

  const deliver = (mail: CapturedMail): void => {
    captured.push(mail);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.match(mail)) {
        waiters[i]!.resolve(mail);
        waiters.splice(i, 1);
      }
    }
  };

  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    let inData = false;
    let dataLines: string[] = [];
    const envelope = { from: "", to: [] as string[] };

    const write = (line: string): void => {
      conn.write(`${line}\r\n`);
    };
    write("220 skeptic-smtp-sink ready");

    conn.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);

        if (inData) {
          if (line === ".") {
            inData = false;
            deliver(parseMail(envelope.from, envelope.to, dataLines.join("\n")));
            dataLines = [];
            write("250 OK: queued");
          } else {
            // De-stuff the SMTP dot-stuffing.
            dataLines.push(line.startsWith("..") ? line.slice(1) : line);
          }
          continue;
        }

        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "HELO" || cmd === "EHLO") write("250 OK");
        else if (cmd === "MAIL") {
          envelope.from = extractAddr(line);
          write("250 OK");
        } else if (cmd === "RCPT") {
          envelope.to.push(extractAddr(line));
          write("250 OK");
        } else if (cmd === "DATA") {
          inData = true;
          write("354 End data with <CR><LF>.<CR><LF>");
        } else if (cmd === "RSET") {
          envelope.from = "";
          envelope.to.length = 0;
          write("250 OK");
        } else if (cmd === "QUIT") {
          write("221 Bye");
          conn.end();
        } else if (cmd === "NOOP") write("250 OK");
        else write("250 OK");
      }
    });
    conn.on("error", () => {
      /* peer hangup is normal */
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const actualPort = (server.address() as net.AddressInfo).port;

  return {
    port: actualPort,
    messages: () => captured.slice(),
    waitFor: ({ to, timeoutMs }) =>
      new Promise<CapturedMail>((resolve, reject) => {
        const match = (m: CapturedMail): boolean =>
          !to || m.to.some((addr) => addr.toLowerCase().includes(to.toLowerCase()));
        const existing = captured.find(match);
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === wrapped);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`no matching email${to ? ` to "${to}"` : ""} within ${timeoutMs}ms`));
        }, timeoutMs);
        const wrapped = (m: CapturedMail): void => {
          clearTimeout(timer);
          resolve(m);
        };
        waiters.push({ match, resolve: wrapped });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const extractAddr = (line: string): string => /<([^>]*)>/.exec(line)?.[1] ?? line.split(":").slice(1).join(":").trim();

const parseMail = (from: string, to: string[], raw: string): CapturedMail => {
  const sep = raw.search(/\r?\n\r?\n/);
  const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw;
  const body = sep >= 0 ? raw.slice(sep).trim() : "";
  const header = (name: string): string => {
    const m = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(headerBlock);
    return m?.[1]?.trim() ?? "";
  };
  return {
    from: from || header("From"),
    to: to.length ? to : header("To").split(",").map((s) => s.trim()).filter(Boolean),
    subject: header("Subject"),
    body,
    otp: extractOtp(`${header("Subject")}\n${body}`),
    receivedAt: Date.now(),
  };
};
