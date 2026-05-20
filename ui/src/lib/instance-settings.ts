export const DEFAULT_INSTANCE_SETTINGS_PATH = "/instance/settings/general";

const KNOWN_INSTANCE_SETTINGS_PATHS = new Set([
  "/instance/settings/profile",
  "/instance/settings/general",
  "/instance/settings/access",
  "/instance/settings/heartbeats",
  "/instance/settings/plugins",
  "/instance/settings/experimental",
  "/instance/settings/adapters",
  "/instance/settings/ai-auth",
  "/instance/settings/terminal",
]);

export function normalizeRememberedInstanceSettingsPath(rawPath: string | null): string {
  if (!rawPath) return DEFAULT_INSTANCE_SETTINGS_PATH;

  const match = rawPath.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const pathname = match?.[1] ?? rawPath;
  const search = match?.[2] ?? "";
  const hash = match?.[3] ?? "";

  if (KNOWN_INSTANCE_SETTINGS_PATHS.has(pathname)) {
    return `${pathname}${search}${hash}`;
  }

  if (/^\/instance\/settings\/plugins\/[^/?#]+$/.test(pathname)) {
    return `${pathname}${search}${hash}`;
  }

  return DEFAULT_INSTANCE_SETTINGS_PATH;
}
