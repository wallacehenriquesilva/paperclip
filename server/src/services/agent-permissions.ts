export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  autoApproveHumanCheckpoints: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    autoApproveHumanCheckpoints: false,
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  return {
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    autoApproveHumanCheckpoints:
      typeof record.autoApproveHumanCheckpoints === "boolean"
        ? record.autoApproveHumanCheckpoints
        : defaults.autoApproveHumanCheckpoints,
  };
}
