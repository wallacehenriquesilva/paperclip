import { api } from "./client";

export interface InstanceAiAuthService {
  key: string;
  label: string;
  command: string;
  args: string[];
  credentialPath: string;
  status: "authenticated" | "expired" | "unreadable" | "missing";
  accountLabel: string | null;
  expiresAt: string | null;
  lastModifiedAt: string | null;
}

export interface InstanceAiAuthStatusResponse {
  services: InstanceAiAuthService[];
}

export const instanceAiAuthApi = {
  status: () => api.get<InstanceAiAuthStatusResponse>("/instance/ai-auth/status"),
  signOut: (key: string) =>
    api.delete<{ ok: boolean; key: string; credentialPath: string }>(
      `/instance/ai-auth/${encodeURIComponent(key)}`,
    ),
};
