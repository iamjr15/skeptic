/**
 * Extract the most likely one-time code from an email body. Deterministic, no LLM.
 * Strategy: prefer a code adjacent to a verification keyword, then a standalone
 * numeric/alphanumeric run of a plausible length.
 */
export const extractOtp = (text: string): string | null => {
  const body = stripHtml(text);

  // 1. Keyword-adjacent code: "your code is 123456", "OTP: 9281", "verification code 482913".
  const keyword =
    /(?:one[\s-]?time\s+(?:code|password)|verification\s+code|security\s+code|login\s+code|access\s+code|\bOTP\b|\bPIN\b|\bcode\b|passcode)\b[^\dA-Z]{0,24}([A-Z0-9]{4,8})/i.exec(
      body,
    );
  if (keyword && hasDigit(keyword[1]!)) return keyword[1]!.toUpperCase();

  // 2. A standalone 4-8 digit run delimited by non-alphanumerics (most OTPs).
  const digits = body.match(/(?<![A-Za-z0-9])(\d{4,8})(?![A-Za-z0-9])/g);
  if (digits && digits.length > 0) {
    // Pick the run closest to a code-ish word if any, else the first.
    return digits[0]!;
  }

  // 3. Alphanumeric code with at least one digit (e.g. "A1B2C3"), 6-8 chars.
  const alnum = body.match(/(?<![A-Za-z0-9])([A-Z0-9]{6,8})(?![A-Za-z0-9])/g);
  if (alnum) {
    const withDigit = alnum.find(hasDigit);
    if (withDigit) return withDigit;
  }

  return null;
};

const hasDigit = (s: string): boolean => /\d/.test(s);

const stripHtml = (s: string): string =>
  s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
