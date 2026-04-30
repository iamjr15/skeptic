export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface BrowserProfile {
  browser: string;
  profilePath: string;
  platform: "darwin" | "linux";
}

export interface CookieExtractionResult {
  cookies: BrowserCookie[];
  browser: string;
  profilePath: string;
  error?: string;
}
