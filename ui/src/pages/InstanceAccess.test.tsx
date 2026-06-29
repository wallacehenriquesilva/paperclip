// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAccessApi = vi.hoisted(() => ({
  searchAdminUsers: vi.fn(),
  getCurrentBoardAccess: vi.fn(),
  getUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
  deactivateUser: vi.fn(),
  reactivateUser: vi.fn(),
}));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ companies: [] }) }));
vi.mock("@/components/InstanceApiKeysSection", () => ({ InstanceApiKeysSection: () => null }));

import { InstanceAccess } from "./InstanceAccess";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "one@example.com",
    name: "User One",
    image: null,
    isInstanceAdmin: false,
    deactivatedAt: null,
    activeCompanyMembershipCount: 0,
    ...overrides,
  };
}

function userAccess() {
  return {
    user: { id: "x", email: null, name: null, image: null, isInstanceAdmin: false },
    companyAccess: [],
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((node) =>
    node.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

function listButtonByName(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((node) =>
    node.querySelector(".truncate.font-medium")?.textContent === name,
  ) as HTMLButtonElement | undefined;
}

describe("InstanceAccess — user deactivation", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ userId: "user-self" });
    mockAccessApi.getUserCompanyAccess.mockResolvedValue(userAccess());
    mockAccessApi.deactivateUser.mockResolvedValue({ id: "user-1", deactivatedAt: "2026-06-29T00:00:00.000Z" });
    mockAccessApi.reactivateUser.mockResolvedValue({ id: "user-2", deactivatedAt: null });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <InstanceAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("deactivates a non-self user after confirmation", async () => {
    mockAccessApi.searchAdminUsers.mockResolvedValue([
      user({ id: "user-self", name: "Me", email: "me@example.com" }),
      user({ id: "user-1", name: "User One" }),
    ]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const root = await render();
    // First user (self) auto-selected; switch to the target user.
    await act(async () => listButtonByName(container, "User One")?.click());
    await flushReact();

    const button = buttonByText(container, "Deactivate user");
    expect(button).toBeTruthy();
    expect(button?.disabled).toBe(false);

    await act(async () => button?.click());
    await flushReact();

    expect(confirmSpy).toHaveBeenCalled();
    expect(mockAccessApi.deactivateUser).toHaveBeenCalledWith("user-1");
    confirmSpy.mockRestore();
    await act(async () => root.unmount());
  });

  it("disables the deactivate button for your own account", async () => {
    mockAccessApi.searchAdminUsers.mockResolvedValue([
      user({ id: "user-self", name: "Me", email: "me@example.com" }),
    ]);

    const root = await render();
    const button = buttonByText(container, "Deactivate user");
    expect(button).toBeTruthy();
    expect(button?.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it("offers reactivation for an already-deactivated user", async () => {
    mockAccessApi.searchAdminUsers.mockResolvedValue([
      user({ id: "user-2", name: "User Two", deactivatedAt: "2026-06-20T00:00:00.000Z" }),
    ]);

    const root = await render();
    expect(buttonByText(container, "Reactivate user")).toBeTruthy();
    expect(container.textContent).toContain("cannot access the platform");

    await act(async () => buttonByText(container, "Reactivate user")?.click());
    await flushReact();

    expect(mockAccessApi.reactivateUser).toHaveBeenCalledWith("user-2");
    await act(async () => root.unmount());
  });
});
