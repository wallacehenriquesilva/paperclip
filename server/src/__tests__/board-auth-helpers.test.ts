import { describe, expect, it } from "vitest";
import {
  boardApiKeyMaskedValue,
  boardApiKeyStatusForRow,
  resolveBoardApiKeyExpiresAt,
} from "../services/board-auth.js";

describe("resolveBoardApiKeyExpiresAt", () => {
  const now = Date.parse("2026-06-28T00:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;

  it("maps each finite option to the right offset", () => {
    expect(resolveBoardApiKeyExpiresAt("1d", now)?.getTime()).toBe(now + DAY);
    expect(resolveBoardApiKeyExpiresAt("7d", now)?.getTime()).toBe(now + 7 * DAY);
    expect(resolveBoardApiKeyExpiresAt("15d", now)?.getTime()).toBe(now + 15 * DAY);
    expect(resolveBoardApiKeyExpiresAt("30d", now)?.getTime()).toBe(now + 30 * DAY);
  });

  it("returns null for 'never'", () => {
    expect(resolveBoardApiKeyExpiresAt("never", now)).toBeNull();
  });
});

describe("boardApiKeyMaskedValue", () => {
  it("appends the stored suffix", () => {
    expect(boardApiKeyMaskedValue("1a2b")).toBe("pcp_board_••••1a2b");
  });

  it("falls back gracefully without a suffix (e.g. legacy CLI keys)", () => {
    expect(boardApiKeyMaskedValue(null)).toBe("pcp_board_••••");
    expect(boardApiKeyMaskedValue(undefined)).toBe("pcp_board_••••");
  });
});

describe("boardApiKeyStatusForRow", () => {
  it("reports revoked first, even if also expired", () => {
    expect(
      boardApiKeyStatusForRow({ revokedAt: new Date(), expiresAt: new Date(0) }),
    ).toBe("revoked");
  });

  it("reports expired when past the expiry", () => {
    expect(
      boardApiKeyStatusForRow({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) }),
    ).toBe("expired");
  });

  it("reports active for a live, never-expiring key", () => {
    expect(boardApiKeyStatusForRow({ revokedAt: null, expiresAt: null })).toBe("active");
    expect(
      boardApiKeyStatusForRow({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) }),
    ).toBe("active");
  });
});
