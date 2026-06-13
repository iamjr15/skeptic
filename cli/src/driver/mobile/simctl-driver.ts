import { createIosTools, listBootedSimulators, type IosTools } from "./ios-tools.js";
import { IosSimDriverSession } from "./simctl-session.js";
import type { Driver, DriverSession, NewSessionOptions } from "../types.js";

export interface IosSimDriverOptions {
  /** Simulator UDID; defaults to the only booted simulator. */
  udid?: string;
  /** IosTools runner override (tests inject a stub). */
  tools?: IosTools;
}

/** iOS-simulator `Driver` over `simctl` + `axe`. Each session targets one booted sim. */
export class IosSimDriver implements Driver {
  private constructor(
    private readonly udid: string,
    private readonly tools: IosTools,
  ) {}

  static async create(opts: IosSimDriverOptions = {}): Promise<IosSimDriver> {
    let udid = opts.udid;
    if (!udid) {
      const sims = await listBootedSimulators();
      if (sims.length === 0) {
        throw new Error("no booted iOS simulator (simctl list devices booted is empty); boot one first");
      }
      udid = sims[0]!.udid;
    }
    const tools = opts.tools ?? createIosTools();
    return new IosSimDriver(udid, tools);
  }

  /** Build directly from an injected tools runner (tests). */
  static fromTools(udid: string, tools: IosTools): IosSimDriver {
    return new IosSimDriver(udid, tools);
  }

  newSession(opts?: NewSessionOptions): Promise<DriverSession> {
    const dir = opts?.artifactDir ?? process.cwd();
    return Promise.resolve(new IosSimDriverSession(this.tools, this.udid, dir));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
