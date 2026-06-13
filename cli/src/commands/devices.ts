import chalk from "chalk";
import { listDevices } from "../driver/mobile/adb.js";
import { listBootedSimulators } from "../driver/mobile/ios-tools.js";

export interface DevicesCommandOptions {
  json?: boolean;
}

interface AndroidDevice {
  serial: string;
  state: string;
}

interface IosDevice {
  udid: string;
  name: string;
  state: string;
}

interface AndroidResult {
  available: boolean;
  devices: AndroidDevice[];
  error?: string;
}

// A missing adb (ENOENT) is "install platform-tools"; any other failure is a
// real adb error worth surfacing verbatim. Conflating them hides actionable info.
const isMissingBinary = (err: unknown): boolean =>
  err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";

const collectAndroid = async (): Promise<AndroidResult> => {
  try {
    return { available: true, devices: await listDevices() };
  } catch (err) {
    if (isMissingBinary(err)) return { available: false, devices: [] };
    return { available: true, devices: [], error: err instanceof Error ? err.message : String(err) };
  }
};

// Booted iOS simulators (drivable via `--platform ios-sim`). Resolves a full Xcode
// itself (xcode-select may point at Command Line Tools, which lacks simctl), so it
// works without `sudo xcode-select -s`. Non-darwin / no-Xcode degrades to empty.
const collectIos = async (): Promise<IosDevice[]> => {
  if (process.platform !== "darwin") return [];
  const sims = await listBootedSimulators().catch(() => []);
  return sims.map((d) => ({ udid: d.udid, name: d.name, state: d.state }));
};

export const runDevices = async (opts: DevicesCommandOptions): Promise<void> => {
  const [android, ios] = await Promise.all([collectAndroid(), collectIos()]);

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        android: {
          available: android.available,
          devices: android.devices,
          ...(android.error ? { error: android.error } : {}),
        },
        ios: { available: true, devices: ios },
      })}\n`,
    );
    return;
  }

  console.log();
  console.log(chalk.bold("Android (adb):"));
  if (!android.available) {
    console.log(chalk.dim("  adb not found on PATH."));
    console.log(
      chalk.dim("  Install Android platform-tools and set ANDROID_HOME (or put adb on PATH)."),
    );
  } else if (android.error) {
    console.log(chalk.yellow(`  adb error: ${android.error}`));
  } else if (android.devices.length === 0) {
    console.log(chalk.dim("  no devices or emulators connected."));
  } else {
    for (const d of android.devices) {
      console.log(`  ${chalk.cyan(d.serial)}  ${d.state}`);
    }
  }

  console.log();
  console.log(`${chalk.bold("iOS (simctl + axe):")} ${chalk.dim("--platform ios-sim")}`);
  if (process.platform !== "darwin") {
    console.log(chalk.dim("  iOS simulators are only listable on macOS."));
  } else if (ios.length === 0) {
    console.log(chalk.dim("  no booted simulators."));
  } else {
    for (const d of ios) {
      console.log(`  ${chalk.cyan(d.udid)}  ${d.name} (${d.state})`);
    }
  }
  console.log();
};
