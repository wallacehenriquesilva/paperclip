import type {
  AgentGithubIdentityInput,
  AgentGithubIdentityView,
} from "@paperclipai/shared";
import { api } from "./client";

export interface AgentGithubIdentityTestResult {
  ok: boolean;
  status: "no_token" | "no_gh_binary" | "unauthenticated" | "authenticated";
  detail: string | null;
  hostname: string;
}

export const agentGithubIdentityApi = {
  read: (agentId: string) =>
    api.get<AgentGithubIdentityView>(`/agents/${encodeURIComponent(agentId)}/github-identity`),
  set: (agentId: string, input: AgentGithubIdentityInput) =>
    api.put<AgentGithubIdentityView>(
      `/agents/${encodeURIComponent(agentId)}/github-identity`,
      input,
    ),
  clear: (agentId: string) =>
    api.delete<AgentGithubIdentityView>(`/agents/${encodeURIComponent(agentId)}/github-identity`),
  test: (agentId: string) =>
    api.post<AgentGithubIdentityTestResult>(
      `/agents/${encodeURIComponent(agentId)}/github-identity/test`,
      {},
    ),
};
