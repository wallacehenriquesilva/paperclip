import { describe, expect, it } from "vitest";
import { INSTANCE_TERMINAL_ALLOWED_COMMANDS } from "../realtime/instance-terminal-ws.js";

describe("instance terminal allowlist", () => {
  it("includes the expected AI login binaries", () => {
    for (const expected of ["claude", "codex", "cursor-agent", "gemini", "opencode"]) {
      expect(INSTANCE_TERMINAL_ALLOWED_COMMANDS).toContain(expected);
    }
  });

  it("does not include shells or destructive utilities", () => {
    for (const blocked of ["bash", "sh", "zsh", "rm", "sudo", "su", "eval", "ssh", "curl", "wget", "cat"]) {
      expect(INSTANCE_TERMINAL_ALLOWED_COMMANDS).not.toContain(blocked);
    }
  });

  it("only contains binary names (no shell expressions or paths)", () => {
    for (const command of INSTANCE_TERMINAL_ALLOWED_COMMANDS) {
      expect(command).not.toContain("/");
      expect(command).not.toContain(" ");
      expect(command).not.toContain(";");
      expect(command).not.toContain("|");
    }
  });
});
