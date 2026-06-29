// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

import { QuietHoursSettings } from "./QuietHoursSettings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function findByTestId(container: HTMLElement, testId: string): HTMLElement | undefined {
  return container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | undefined;
}

describe("QuietHoursSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompaniesApi.update.mockResolvedValue({ id: "company-1" });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(quietHours: Parameters<typeof QuietHoursSettings>[0]["quietHours"]) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <QuietHoursSettings companyId="company-1" quietHours={quietHours} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  it("hides window editor when quiet hours is disabled", async () => {
    const root = await render(null);
    expect(findByTestId(container, "quiet-hours-window")).toBeNull();
    await act(async () => root.unmount());
  });

  it("reveals a default window and saves the config when enabled", async () => {
    const root = await render(null);

    const toggle = findByTestId(container, "quiet-hours-enabled-toggle");
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // A default window appears once enabled.
    expect(findByTestId(container, "quiet-hours-window")).toBeTruthy();

    const save = findByTestId(container, "quiet-hours-save") as HTMLButtonElement | undefined;
    expect(save).toBeTruthy();
    expect(save!.disabled).toBe(false);

    await act(async () => {
      save!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCompaniesApi.update).toHaveBeenCalledTimes(1);
    const [companyId, payload] = mockCompaniesApi.update.mock.calls[0];
    expect(companyId).toBe("company-1");
    expect(payload.quietHours.enabled).toBe(true);
    expect(payload.quietHours.onBlock).toBe("defer");
    expect(payload.quietHours.windows.length).toBeGreaterThan(0);

    await act(async () => root.unmount());
  });

  it("renders existing windows from a persisted config", async () => {
    const root = await render({
      enabled: true,
      timezone: "UTC",
      windows: [
        { days: [1, 2], start: "22:00", end: "08:00" },
        { days: [], start: "12:00", end: "13:00" },
      ],
      onBlock: "skip",
    });
    const windows = container.querySelectorAll('[data-testid="quiet-hours-window"]');
    expect(windows.length).toBe(2);
    // No change yet => no save button.
    expect(findByTestId(container, "quiet-hours-save")).toBeNull();
    await act(async () => root.unmount());
  });
});
