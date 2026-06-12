import { createAdb, listDevices, type Adb } from "./adb.js";
import { AndroidAdbDriverSession } from "./adb-session.js";
import type { Driver, DriverSession, NewSessionOptions } from "../types.js";

export interface AdbDriverOptions {
  /** Device serial; defaults to the first attached device. */
  serial?: string;
  adbPath?: string;
  /** Adb runner override (tests inject a stub). */
  adb?: Adb;
}

/** Android `Driver` over adb. Each session targets one device serial. */
export class AdbDriver implements Driver {
  private constructor(
    private readonly serial: string,
    private readonly adb: Adb,
  ) {}

  static async create(opts: AdbDriverOptions = {}): Promise<AdbDriver> {
    let serial = opts.serial;
    if (!serial) {
      const devices = (await listDevices(opts.adbPath)).filter((d) => d.state === "device");
      if (devices.length === 0) {
        throw new Error("no Android device/emulator attached (adb devices is empty); boot one first");
      }
      serial = devices[0]!.serial;
    }
    const adb = opts.adb ?? createAdb({ serial, ...(opts.adbPath ? { adbPath: opts.adbPath } : {}) });
    return new AdbDriver(serial, adb);
  }

  /** Build directly from an injected adb runner (tests). */
  static fromAdb(serial: string, adb: Adb): AdbDriver {
    return new AdbDriver(serial, adb);
  }

  newSession(opts?: NewSessionOptions): Promise<DriverSession> {
    const dir = opts?.artifactDir ?? process.cwd();
    return Promise.resolve(new AndroidAdbDriverSession(this.adb, this.serial, dir));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
