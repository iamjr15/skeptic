import { describe, it, expect } from "vitest";
import { checkPing, type DaemonRuntimeState } from "../../../src/daemon/rpc.js";

const baseState: DaemonRuntimeState = {
  engine: "chromium",
  headed: false,
  cliVersion: "1.2.3",
  playwrightVersion: "1.59.0",
  startedAt: 0,
  clients: 0,
  incClients: () => {},
  decClients: () => {},
  wsEndpoint: () => "ws://fake/",
};

describe("daemon handshake (checkPing)", () => {
  it("ok=true when every field matches", () => {
    const r = checkPing(
      {
        engine: "chromium",
        headed: false,
        cliVersion: "1.2.3",
        playwrightVersion: "1.59.0",
      },
      baseState,
    );
    expect(r.ok).toBe(true);
  });

  it("engine-mismatch when client requests different engine", () => {
    const r = checkPing(
      {
        engine: "firefox",
        headed: false,
        cliVersion: "1.2.3",
        playwrightVersion: "1.59.0",
      },
      baseState,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("engine-mismatch");
    expect(r.engine).toBe("chromium");
  });

  it("headed-mismatch when client requests headed but daemon is headless", () => {
    const r = checkPing(
      {
        engine: "chromium",
        headed: true,
        cliVersion: "1.2.3",
        playwrightVersion: "1.59.0",
      },
      baseState,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("headed-mismatch");
  });

  it("version-mismatch on Playwright drift", () => {
    const r = checkPing(
      {
        engine: "chromium",
        headed: false,
        cliVersion: "1.2.3",
        playwrightVersion: "1.99.99",
      },
      baseState,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("version-mismatch");
  });

  it("version-mismatch on CLI drift", () => {
    const r = checkPing(
      {
        engine: "chromium",
        headed: false,
        cliVersion: "9.9.9",
        playwrightVersion: "1.59.0",
      },
      baseState,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("version-mismatch");
  });

  it("missing-fields rejection when client omits handshake data", () => {
    const r = checkPing({}, baseState);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing-fields");
  });

  it("auth-failed when SKEPTIC_DAEMON_AUTH_TOKEN is set and client omits token", () => {
    const prev = process.env["SKEPTIC_DAEMON_AUTH_TOKEN"];
    process.env["SKEPTIC_DAEMON_AUTH_TOKEN"] = "secret";
    try {
      const r = checkPing(
        {
          engine: "chromium",
          headed: false,
          cliVersion: "1.2.3",
          playwrightVersion: "1.59.0",
        },
        baseState,
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("auth-failed");

      const r2 = checkPing(
        {
          engine: "chromium",
          headed: false,
          cliVersion: "1.2.3",
          playwrightVersion: "1.59.0",
          authToken: "secret",
        },
        baseState,
      );
      expect(r2.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["SKEPTIC_DAEMON_AUTH_TOKEN"];
      else process.env["SKEPTIC_DAEMON_AUTH_TOKEN"] = prev;
    }
  });
});
