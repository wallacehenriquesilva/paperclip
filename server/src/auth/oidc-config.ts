import { HUMAN_COMPANY_MEMBERSHIP_ROLES, type HumanCompanyMembershipRole } from "@paperclipai/shared";

/**
 * SSO (OIDC) configuration for board sign-in. Everything is env-driven and
 * opt-in: with PAPERCLIP_AUTH_OIDC_ENABLED unset the instance behaves exactly
 * as before (email + password only).
 */
export type AuthOidcConfig = {
  providerId: string;
  label: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Expected `iss` claim. When unset, the issuer advertised by the discovery document is used. */
  expectedIssuer: string | undefined;
  /** Google Workspace hosted domain. Sent as `hd` and required to match the id_token `hd` claim. */
  requiredHostedDomain: string | undefined;
  /** Create a Paperclip user on first SSO sign-in (still subject to the email-domain allowlist). */
  autoProvision: boolean;
  /** Company that newly provisioned SSO users join. */
  defaultCompanyId: string | undefined;
  defaultRole: HumanCompanyMembershipRole;
};

export type AuthPasswordLoginMode = "enabled" | "disabled";

export type AuthSsoSettings = {
  authOidc: AuthOidcConfig | null;
  authPasswordLogin: AuthPasswordLoginMode;
  authBreakGlassEmails: string[];
  authSessionTtlHours: number | undefined;
};

const GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration";
const PROVIDER_ID_RE = /^[a-z0-9-]+$/;

type Env = Record<string, string | undefined>;

function readTrimmed(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readBoolean(env: Env, key: string, fallback: boolean): boolean {
  const value = readTrimmed(env, key)?.toLowerCase();
  if (value === undefined) return fallback;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(`${key} must be true or false (got "${env[key]}")`);
}

function readCsv(env: Env, key: string): string[] {
  return (readTrimmed(env, key) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function parseAuthSsoSettings(env: Env = process.env): AuthSsoSettings {
  const passwordLoginRaw = (readTrimmed(env, "PAPERCLIP_AUTH_PASSWORD_LOGIN") ?? "enabled").toLowerCase();
  if (passwordLoginRaw !== "enabled" && passwordLoginRaw !== "disabled") {
    throw new Error(`PAPERCLIP_AUTH_PASSWORD_LOGIN must be "enabled" or "disabled" (got "${passwordLoginRaw}")`);
  }
  const authPasswordLogin: AuthPasswordLoginMode = passwordLoginRaw;
  const authBreakGlassEmails = readCsv(env, "PAPERCLIP_AUTH_BREAK_GLASS_EMAILS").map((email) => email.toLowerCase());

  const ttlRaw = readTrimmed(env, "PAPERCLIP_AUTH_SESSION_TTL_HOURS");
  let authSessionTtlHours: number | undefined;
  if (ttlRaw !== undefined) {
    const parsed = Number(ttlRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`PAPERCLIP_AUTH_SESSION_TTL_HOURS must be a positive number (got "${ttlRaw}")`);
    }
    authSessionTtlHours = parsed;
  }

  let authOidc: AuthOidcConfig | null = null;
  if (readBoolean(env, "PAPERCLIP_AUTH_OIDC_ENABLED", false)) {
    const clientId = readTrimmed(env, "PAPERCLIP_AUTH_OIDC_CLIENT_ID");
    const clientSecret = readTrimmed(env, "PAPERCLIP_AUTH_OIDC_CLIENT_SECRET");
    const missing = [
      !clientId && "PAPERCLIP_AUTH_OIDC_CLIENT_ID",
      !clientSecret && "PAPERCLIP_AUTH_OIDC_CLIENT_SECRET",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`PAPERCLIP_AUTH_OIDC_ENABLED=true requires ${missing.join(" and ")}`);
    }

    const providerId = (readTrimmed(env, "PAPERCLIP_AUTH_OIDC_PROVIDER_ID") ?? "oidc").toLowerCase();
    if (!PROVIDER_ID_RE.test(providerId)) {
      throw new Error(`PAPERCLIP_AUTH_OIDC_PROVIDER_ID must match ${PROVIDER_ID_RE} (got "${providerId}")`);
    }

    const defaultRoleRaw = (readTrimmed(env, "PAPERCLIP_AUTH_OIDC_DEFAULT_ROLE") ?? "viewer").toLowerCase();
    if (!(HUMAN_COMPANY_MEMBERSHIP_ROLES as readonly string[]).includes(defaultRoleRaw)) {
      throw new Error(
        `PAPERCLIP_AUTH_OIDC_DEFAULT_ROLE must be one of ${HUMAN_COMPANY_MEMBERSHIP_ROLES.join(", ")} (got "${defaultRoleRaw}")`,
      );
    }

    const scopes = readCsv(env, "PAPERCLIP_AUTH_OIDC_SCOPES");
    authOidc = {
      providerId,
      label: readTrimmed(env, "PAPERCLIP_AUTH_OIDC_LABEL") ?? "Google",
      discoveryUrl: readTrimmed(env, "PAPERCLIP_AUTH_OIDC_DISCOVERY_URL") ?? GOOGLE_DISCOVERY_URL,
      clientId: clientId!,
      clientSecret: clientSecret!,
      scopes: scopes.length > 0 ? scopes : ["openid", "email", "profile"],
      expectedIssuer: readTrimmed(env, "PAPERCLIP_AUTH_OIDC_EXPECTED_ISSUER"),
      requiredHostedDomain: readTrimmed(env, "PAPERCLIP_AUTH_OIDC_REQUIRED_HD")?.toLowerCase().replace(/^@/, ""),
      autoProvision: readBoolean(env, "PAPERCLIP_AUTH_OIDC_AUTO_PROVISION", true),
      defaultCompanyId: readTrimmed(env, "PAPERCLIP_AUTH_OIDC_DEFAULT_COMPANY_ID"),
      defaultRole: defaultRoleRaw as HumanCompanyMembershipRole,
    };
  }

  if (authPasswordLogin === "disabled" && !authOidc) {
    throw new Error("PAPERCLIP_AUTH_PASSWORD_LOGIN=disabled requires PAPERCLIP_AUTH_OIDC_ENABLED=true");
  }

  return { authOidc, authPasswordLogin, authBreakGlassEmails, authSessionTtlHours };
}
