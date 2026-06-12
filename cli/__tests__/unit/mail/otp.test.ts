import { describe, it, expect } from "vitest";
import { extractOtp } from "../../../src/mail/otp.js";

describe("extractOtp", () => {
  it("extracts keyword-adjacent codes", () => {
    expect(extractOtp("Your verification code is 123456.")).toBe("123456");
    expect(extractOtp("OTP: 9281")).toBe("9281");
    expect(extractOtp("Use code 482913 to log in")).toBe("482913");
    expect(extractOtp("Your one-time password is 5567")).toBe("5567");
    expect(extractOtp("Enter this PIN: 4821 to continue")).toBe("4821");
  });

  it("extracts alphanumeric codes with a digit", () => {
    expect(extractOtp("Your code: A1B2C3")).toBe("A1B2C3");
  });

  it("falls back to a standalone numeric run", () => {
    expect(extractOtp("Hello,\n\n   882041   \n\nThanks")).toBe("882041");
  });

  it("strips HTML before extracting", () => {
    expect(extractOtp("<html><body><p>Your code is <b>739104</b></p></body></html>")).toBe("739104");
  });

  it("returns null when no code is present", () => {
    expect(extractOtp("Welcome to our service! Click the link to continue.")).toBeNull();
  });

  it("prefers the keyword-adjacent code over an incidental number", () => {
    expect(extractOtp("Order #100 placed. Your security code is 246810.")).toBe("246810");
  });
});
