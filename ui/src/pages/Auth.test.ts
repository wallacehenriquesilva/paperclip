import { describe, expect, it } from "vitest";
import { describeSsoError } from "./Auth";

describe("describeSsoError", () => {
  it("returns null without an error code", () => {
    expect(describeSsoError(null)).toBeNull();
  });

  it("explains cancelled and unregistered SSO attempts", () => {
    expect(describeSsoError("access_denied")).toMatch(/cancelled/);
    expect(describeSsoError("signup_disabled")).toMatch(/invite/);
  });

  it("falls back to a generic message that does not leak the reason", () => {
    expect(describeSsoError("user_info_is_missing")).toBe(
      "Single sign-on failed. Make sure you're using your organization account.",
    );
  });
});
