/**
 * Device profiles for responsive testing.
 * Ported from backend/device_profiles.py — Chrome 134 stable user agents.
 */

export type DeviceCategory = "desktop" | "phone" | "tablet";

export interface DeviceProfile {
  label: string;
  category: DeviceCategory;
  width: number;
  height: number;
  dpr: number;
  userAgent: string | null;
}

const IOS_18_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1";

const IPAD_18_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1";

export const DEVICE_PROFILES: Record<string, DeviceProfile> = {
  // -- Desktops --
  desktop_1080p: {
    label: "Desktop 1080p",
    category: "desktop",
    width: 1920,
    height: 1080,
    dpr: 1,
    userAgent: null,
  },
  desktop_1440p: {
    label: "Desktop 1440p",
    category: "desktop",
    width: 2560,
    height: 1440,
    dpr: 1,
    userAgent: null,
  },
  macbook_pro_14: {
    label: 'MacBook Pro 14"',
    category: "desktop",
    width: 1512,
    height: 982,
    dpr: 2,
    userAgent: null,
  },

  // -- iPhones (iOS 18) --
  iphone_16_pro_max: {
    label: "iPhone 16 Pro Max",
    category: "phone",
    width: 440,
    height: 956,
    dpr: 3,
    userAgent: IOS_18_UA,
  },
  iphone_16_pro: {
    label: "iPhone 16 Pro",
    category: "phone",
    width: 402,
    height: 874,
    dpr: 3,
    userAgent: IOS_18_UA,
  },
  iphone_16: {
    label: "iPhone 16",
    category: "phone",
    width: 390,
    height: 844,
    dpr: 3,
    userAgent: IOS_18_UA,
  },
  iphone_15_pro_max: {
    label: "iPhone 15 Pro Max",
    category: "phone",
    width: 430,
    height: 932,
    dpr: 3,
    userAgent: IOS_18_UA,
  },
  iphone_se_3: {
    label: "iPhone SE (3rd gen)",
    category: "phone",
    width: 375,
    height: 667,
    dpr: 2,
    userAgent: IOS_18_UA,
  },

  // -- Android Phones --
  galaxy_s25_ultra: {
    label: "Samsung Galaxy S25 Ultra",
    category: "phone",
    width: 412,
    height: 891,
    dpr: 3.5,
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  },
  galaxy_s25: {
    label: "Samsung Galaxy S25",
    category: "phone",
    width: 360,
    height: 780,
    dpr: 3,
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  },
  pixel_9_pro_xl: {
    label: "Google Pixel 9 Pro XL",
    category: "phone",
    width: 414,
    height: 921,
    dpr: 3.25,
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  },
  pixel_9: {
    label: "Google Pixel 9",
    category: "phone",
    width: 412,
    height: 892,
    dpr: 2.625,
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
  },

  // -- Tablets --
  ipad_pro_13_m4: {
    label: 'iPad Pro 13" (M4)',
    category: "tablet",
    width: 1032,
    height: 1376,
    dpr: 2,
    userAgent: IPAD_18_UA,
  },
  ipad_pro_11_m4: {
    label: 'iPad Pro 11" (M4)',
    category: "tablet",
    width: 834,
    height: 1210,
    dpr: 2,
    userAgent: IPAD_18_UA,
  },
  ipad_air_13_m3: {
    label: 'iPad Air 13" (M3)',
    category: "tablet",
    width: 1024,
    height: 1366,
    dpr: 2,
    userAgent: IPAD_18_UA,
  },
  galaxy_tab_s10_ultra: {
    label: "Samsung Galaxy Tab S10 Ultra",
    category: "tablet",
    width: 906,
    height: 1422,
    dpr: 2,
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; SM-X920) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  },
};

/** All valid device profile IDs. */
export const DEVICE_PROFILE_IDS = Object.keys(DEVICE_PROFILES);

/** Look up a device profile by ID, or return undefined. */
export function getDeviceProfile(id: string): DeviceProfile | undefined {
  return DEVICE_PROFILES[id];
}

/** List profiles filtered by category. */
export function getProfilesByCategory(
  category: DeviceCategory,
): Record<string, DeviceProfile> {
  const result: Record<string, DeviceProfile> = {};
  for (const [id, profile] of Object.entries(DEVICE_PROFILES)) {
    if (profile.category === category) result[id] = profile;
  }
  return result;
}
