import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { APIError } from "better-auth/api";
import type { GenericOAuthConfig } from "better-auth/plugins";
import type { Db } from "@paperclipai/db";
import type { AuthOidcConfig, AuthPasswordLoginMode } from "./oidc-config.js";
import { logger } from "../middleware/logger.js";

/**
 * Board SSO via a single OIDC provider (Google Workspace by default) on top of
 * better-auth's `genericOAuth` plugin. No schema changes: identities live in
 * the existing `account` table (`provider_id = <providerId>`).
 */

export const PASSWORD_LOGIN_DISABLED_CODE = "PASSWORD_LOGIN_DISABLED";
export const PASSWORD_LOGIN_DISABLED_MESSAGE = "Password sign-in is disabled. Use single sign-on instead.";

type OidcDiscovery = {
  issuer: string;
  jwks_uri: string;
};

export type OidcUserInfo = {
  id: string;
  email: string;
  name: string;
  image?: string;
  emailVerified: boolean;
};

export type OidcVerifierDeps = {
  fetchDiscovery?: (url: string) => Promise<OidcDiscovery>;
  createKeySet?: (jwksUri: string) => JWTVerifyGetKey;
};

async function defaultFetchDiscovery(url: string): Promise<OidcDiscovery> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`OIDC discovery request failed (${res.status})`);
  const body = (await res.json()) as Partial<OidcDiscovery>;
  if (!body.issuer || !body.jwks_uri) throw new Error("OIDC discovery document is missing issuer or jwks_uri");
  return { issuer: body.issuer, jwks_uri: body.jwks_uri };
}

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Builds the `getUserInfo` callback for the provider. better-auth's default
 * only decodes the id_token; here we verify signature (JWKS), issuer, audience
 * and expiry, and enforce the hosted domain + email-domain allowlist so that a
 * token from outside the organization never reaches user lookup/creation.
 * Returning null aborts the callback (redirect with `error=user_info_is_missing`).
 */
export function createOidcUserInfoResolver(
  oidc: AuthOidcConfig,
  allowedEmailDomains: readonly string[],
  deps: OidcVerifierDeps = {},
) {
  const fetchDiscovery = deps.fetchDiscovery ?? defaultFetchDiscovery;
  const createKeySet = deps.createKeySet ?? ((uri: string) => createRemoteJWKSet(new URL(uri)));
  let cached: Promise<{ issuer: string; keySet: JWTVerifyGetKey }> | null = null;

  const load = () => {
    if (!cached) {
      cached = fetchDiscovery(oidc.discoveryUrl)
        .then((discovery) => ({
          issuer: oidc.expectedIssuer ?? discovery.issuer,
          keySet: createKeySet(discovery.jwks_uri),
        }))
        .catch((err) => {
          cached = null;
          throw err;
        });
    }
    return cached;
  };

  const domainAllowlist = allowedEmailDomains.map((d) => d.toLowerCase());

  return async function getUserInfo(tokens: { idToken?: string }): Promise<OidcUserInfo | null> {
    const reject = (reason: string, extra?: Record<string, unknown>) => {
      logger.warn({ providerId: oidc.providerId, reason, ...extra }, "SSO sign-in rejected");
      return null;
    };

    if (!tokens.idToken) return reject("missing_id_token");

    let claims: Record<string, unknown>;
    try {
      const { issuer, keySet } = await load();
      const verified = await jwtVerify(tokens.idToken, keySet, { issuer, audience: oidc.clientId });
      claims = verified.payload as Record<string, unknown>;
    } catch (err) {
      return reject("invalid_id_token", { err: err instanceof Error ? err.message : String(err) });
    }

    const sub = typeof claims.sub === "string" ? claims.sub : "";
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!sub) return reject("missing_sub");
    if (!email || !email.includes("@")) return reject("missing_email");
    if (claims.email_verified === false || claims.email_verified === "false") {
      return reject("email_not_verified", { email });
    }
    if (oidc.requiredHostedDomain) {
      const hd = typeof claims.hd === "string" ? claims.hd.toLowerCase() : "";
      if (hd !== oidc.requiredHostedDomain) return reject("hosted_domain_mismatch", { email, hd });
    }
    if (domainAllowlist.length > 0 && !domainAllowlist.includes(emailDomain(email))) {
      return reject("email_domain_not_allowed", { email });
    }

    const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email.split("@")[0]!;
    const image = typeof claims.picture === "string" ? claims.picture : undefined;
    return { id: sub, email, name, image, emailVerified: true };
  };
}

export function buildOidcProviderConfig(
  oidc: AuthOidcConfig,
  allowedEmailDomains: readonly string[],
  deps?: OidcVerifierDeps,
): GenericOAuthConfig {
  return {
    providerId: oidc.providerId,
    discoveryUrl: oidc.discoveryUrl,
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    scopes: oidc.scopes,
    pkce: true,
    prompt: "select_account",
    ...(oidc.requiredHostedDomain ? { authorizationUrlParams: { hd: oidc.requiredHostedDomain } } : {}),
    disableSignUp: !oidc.autoProvision,
    overrideUserInfo: false,
    getUserInfo: createOidcUserInfoResolver(oidc, allowedEmailDomains, deps) as GenericOAuthConfig["getUserInfo"],
  };
}

/**
 * Rejects `/sign-in/email` when password sign-in is disabled, except for the
 * configured break-glass accounts.
 */
export function assertPasswordSignInAllowed(input: {
  path: string | undefined;
  body: unknown;
  passwordLogin: AuthPasswordLoginMode;
  breakGlassEmails: readonly string[];
}) {
  if (input.passwordLogin !== "disabled") return;
  if (input.path !== "/sign-in/email") return;
  const email = (input.body as { email?: unknown } | null)?.email;
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (normalized && input.breakGlassEmails.includes(normalized)) {
    logger.warn({ email: normalized }, "break-glass password sign-in");
    return;
  }
  throw new APIError("FORBIDDEN", {
    code: PASSWORD_LOGIN_DISABLED_CODE,
    message: PASSWORD_LOGIN_DISABLED_MESSAGE,
  });
}

/**
 * Adds a freshly SSO-provisioned user to the default company. Never throws:
 * a failure here must not block sign-in (the user can be added manually).
 */
export async function provisionSsoUserMembership(
  db: Db,
  oidc: AuthOidcConfig,
  userId: string,
): Promise<void> {
  if (!oidc.defaultCompanyId) return;
  const companyId = oidc.defaultCompanyId;
  try {
    const [{ accessService }, { grantsForHumanRole }, { logActivity }] = await Promise.all([
      import("../services/access.js"),
      import("../services/company-member-roles.js"),
      import("../services/activity-log.js"),
    ]);
    const access = accessService(db);
    const membership = await access.ensureMembership(companyId, "user", userId, oidc.defaultRole, "active");
    await access.setPrincipalGrants(companyId, "user", userId, grantsForHumanRole(oidc.defaultRole), null);
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "sso",
      action: "company_membership.sso_provisioned",
      entityType: "company_membership",
      entityId: membership?.id ?? userId,
      details: { userId, role: oidc.defaultRole, providerId: oidc.providerId },
    });
    logger.info({ userId, companyId, role: oidc.defaultRole }, "SSO user provisioned into default company");
  } catch (err) {
    logger.error({ err, userId, companyId }, "failed to provision SSO user into default company");
  }
}

export function isOidcCallbackContext(ctx: unknown, providerId: string): boolean {
  const c = ctx as { path?: string; params?: { providerId?: string } } | null | undefined;
  if (!c) return false;
  if (c.params?.providerId === providerId) return true;
  return typeof c.path === "string" && c.path.startsWith("/oauth2/callback");
}
