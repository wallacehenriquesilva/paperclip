import type {
  CompanyMcpServer,
  CompanyMcpServerCreateRequest,
  CompanyMcpServerListItem,
  CompanyMcpServerTestRequest,
  CompanyMcpServerTestResult,
  CompanyMcpServerUpdateRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export const companyMcpServersApi = {
  list: (companyId: string) =>
    api.get<CompanyMcpServerListItem[]>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers`,
    ),
  detail: (companyId: string, id: string) =>
    api.get<CompanyMcpServer>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers/${encodeURIComponent(id)}`,
    ),
  create: (companyId: string, payload: CompanyMcpServerCreateRequest) =>
    api.post<CompanyMcpServer>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers`,
      payload,
    ),
  update: (companyId: string, id: string, payload: CompanyMcpServerUpdateRequest) =>
    api.patch<CompanyMcpServer>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers/${encodeURIComponent(id)}`,
      payload,
    ),
  delete: (companyId: string, id: string) =>
    api.delete<CompanyMcpServer>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers/${encodeURIComponent(id)}`,
    ),
  test: (companyId: string, id: string, payload: CompanyMcpServerTestRequest = {}) =>
    api.post<CompanyMcpServerTestResult>(
      `/companies/${encodeURIComponent(companyId)}/mcp-servers/${encodeURIComponent(id)}/test`,
      payload,
    ),
};
