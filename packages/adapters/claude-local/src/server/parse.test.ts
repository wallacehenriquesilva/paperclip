import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });

  it("parses the 'session limit · resets 8:50pm (UTC)' assistant message (5h cap)", () => {
    const now = new Date("2026-05-29T15:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your session limit · resets 8:50pm (UTC)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-05-29T20:50:00.000Z");
  });

  it("prefers the structured rate_limit_event resetsAt over scraping the message", () => {
    const now = new Date("2026-05-29T15:00:00.000Z");
    const resetsAt = new Date("2026-05-29T20:50:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      {
        errorMessage: "You've hit your session limit · resets 8:50pm (UTC)",
        rateLimit: { resetsAt },
      },
      now,
    );
    expect(extracted?.toISOString()).toBe(resetsAt.toISOString());
  });
});

describe("isClaudeTransientUpstreamError (extended message phrasings)", () => {
  it("matches 'hit your org's monthly usage limit'", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You've hit your org's monthly usage limit · resets June 1 (UTC)",
      }),
    ).toBe(true);
  });

  it("matches 'monthly limit reached'", () => {
    expect(
      isClaudeTransientUpstreamError({ errorMessage: "monthly limit reached" }),
    ).toBe(true);
  });

  it("matches structured rate_limit_event status=rejected even when message phrasing is unknown", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Some new phrasing we have never seen before",
        rateLimit: { status: "rejected", resetsAt: new Date() },
      }),
    ).toBe(true);
  });

  it("does NOT match unrelated errors", () => {
    expect(
      isClaudeTransientUpstreamError({ errorMessage: "Permission denied: file not writable" }),
    ).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore for monthly limits", () => {
  it("extracts the reset hint from a monthly-usage message", () => {
    const now = new Date("2026-05-31T15:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your org's monthly usage limit · resets 9pm (UTC)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-05-31T21:00:00.000Z");
  });
});

describe("parseClaudeStreamJson rate_limit_event capture", () => {
  it("captures rate_limit_event into the rateLimit field of the stream snapshot", () => {
    // Real-world event Claude emits when the 5-hour session limit fires.
    const stdout = [
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1780087800,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled_until",
          isUsingOverage: false,
        },
        uuid: "b240e450-f173-4b8c-a3dd-08bc53ec62b5",
        session_id: "9c4a10c7-6450-4c00-95f8-1f1bf2aa0148",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your session limit · resets 8:50pm (UTC)",
        session_id: "9c4a10c7-6450-4c00-95f8-1f1bf2aa0148",
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(stdout);
    expect(result.rateLimit).not.toBeNull();
    expect(result.rateLimit?.rateLimitType).toBe("five_hour");
    expect(result.rateLimit?.status).toBe("rejected");
    expect(result.rateLimit?.resetsAt?.toISOString()).toBe(new Date(1780087800 * 1000).toISOString());
  });
});
