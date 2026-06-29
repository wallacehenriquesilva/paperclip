import { afterEach, describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";
import {
  buildBetterAuthAdvancedOptions,
  deriveAuthCookiePrefix,
  deriveAuthTrustedOrigins,
  isEmailDomainAllowed,
} from "../auth/better-auth.js";

const ORIGINAL_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (ORIGINAL_INSTANCE_ID === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_INSTANCE_ID;
});

describe("Better Auth cookie scoping", () => {
  it("derives an instance-scoped cookie prefix", () => {
    expect(deriveAuthCookiePrefix("default")).toBe("paperclip-default");
    expect(deriveAuthCookiePrefix("PAP-1601-worktree")).toBe("paperclip-PAP-1601-worktree");
  });

  it("uses PAPERCLIP_INSTANCE_ID for the Better Auth cookie prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "sat-worktree";

    const advanced = buildBetterAuthAdvancedOptions({ disableSecureCookies: false });

    expect(advanced).toEqual({
      cookiePrefix: "paperclip-sat-worktree",
    });
    expect(getCookies({ advanced } as BetterAuthOptions).sessionToken.name).toBe(
      "paperclip-sat-worktree.session_token",
    );
  });

  it("keeps local http auth cookies non-secure while preserving the scoped prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "pap-worktree";

    expect(buildBetterAuthAdvancedOptions({ disableSecureCookies: true })).toEqual({
      cookiePrefix: "paperclip-pap-worktree",
      useSecureCookies: false,
    });
  });

  it("adds hostname port variants for authenticated mode on non-default ports", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["Board.Example.Test"],
      port: 3101,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0]);

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test",
      "http://board.example.test",
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
  });

  it("prefers an explicit resolved listen port over the configured port", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["board.example.test"],
      port: 3100,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0], { listenPort: 3101 });

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
    expect(trustedOrigins).not.toContain("https://board.example.test:3100");
    expect(trustedOrigins).not.toContain("http://board.example.test:3100");
  });
});

describe("email-domain allowlist gate", () => {
  it("allows any domain when the allowlist is empty", () => {
    expect(isEmailDomainAllowed("anyone@anywhere.com", [])).toBe(true);
  });

  it("allows a domain present in the allowlist", () => {
    expect(isEmailDomainAllowed("user@contaazul.com", ["contaazul.com"])).toBe(true);
  });

  it("rejects a domain absent from the allowlist", () => {
    expect(isEmailDomainAllowed("user@gmail.com", ["contaazul.com"])).toBe(false);
  });

  it("matches case-insensitively on both sides", () => {
    expect(isEmailDomainAllowed("User@ContaAzul.COM", ["CONTAAZUL.com"])).toBe(true);
  });

  it("tolerates a leading @ and surrounding whitespace in the allowlist", () => {
    expect(isEmailDomainAllowed("user@contaazul.com", [" @contaazul.com "])).toBe(true);
  });

  it("treats an allowlist of only blank entries as no restriction", () => {
    expect(isEmailDomainAllowed("user@gmail.com", ["  ", ""])).toBe(true);
  });

  it("does not match a subdomain against a bare domain entry", () => {
    expect(isEmailDomainAllowed("user@mail.contaazul.com", ["contaazul.com"])).toBe(false);
  });

  it("rejects malformed emails without a domain", () => {
    expect(isEmailDomainAllowed("not-an-email", ["contaazul.com"])).toBe(false);
    expect(isEmailDomainAllowed("user@", ["contaazul.com"])).toBe(false);
  });

  it("matches against the last @ segment", () => {
    expect(isEmailDomainAllowed("weird@local@contaazul.com", ["contaazul.com"])).toBe(true);
  });
});
