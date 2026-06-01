import { describe, expect, it } from "vitest";
import { isValidIssuePathId, parseIssuePathIdFromPath, parseIssueReferenceFromHref } from "./issue-reference";

describe("issue-reference", () => {
  it("extracts issue ids from company-scoped issue paths", () => {
    expect(parseIssuePathIdFromPath("/PAP/issues/PAP-1271")).toBe("PAP-1271");
    expect(parseIssuePathIdFromPath("/PAP/issues/pap-1272")).toBe("PAP-1272");
    expect(parseIssuePathIdFromPath("/issues/pc1a2-7")).toBe("PC1A2-7");
    expect(parseIssuePathIdFromPath("/PC1A2/issues/pc1a2-7")).toBe("PC1A2-7");
    expect(parseIssuePathIdFromPath("/issues/PAP-1179")).toBe("PAP-1179");
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
  });

  it("does not treat full issue URLs as internal issue paths", () => {
    expect(parseIssuePathIdFromPath("http://localhost:3100/PAP/issues/PAP-1179")).toBeNull();
    expect(parseIssuePathIdFromPath("http://remote.example.test:3103/PAPA/issues/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("does not treat GitHub issue URLs as internal Paperclip issue links", () => {
    expect(parseIssuePathIdFromPath("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
    expect(parseIssueReferenceFromHref("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
  });

  it("ignores placeholder issue paths", () => {
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
    expect(parseIssuePathIdFromPath("http://localhost:3100/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
  });

  it("normalizes bare identifiers, relative issue paths, and issue scheme links into internal links", () => {
    expect(parseIssueReferenceFromHref("pap-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
    expect(parseIssueReferenceFromHref("pc1a2-7")).toEqual({
      issuePathId: "PC1A2-7",
      href: "/issues/PC1A2-7",
    });
    expect(parseIssueReferenceFromHref("/PAP/issues/pap-1180")).toEqual({
      issuePathId: "PAP-1180",
      href: "/issues/PAP-1180",
    });
    expect(parseIssueReferenceFromHref("issue://PAP-1310")).toEqual({
      issuePathId: "PAP-1310",
      href: "/issues/PAP-1310",
    });
    expect(parseIssueReferenceFromHref("issue://:PAP-1311")).toEqual({
      issuePathId: "PAP-1311",
      href: "/issues/PAP-1311",
    });
  });

  it("normalizes exact inline-code-like issue identifiers", () => {
    expect(parseIssueReferenceFromHref("PAP-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
  });

  it("preserves absolute Paperclip issue URLs so origin, port, and hash are not lost", () => {
    expect(parseIssueReferenceFromHref("http://localhost:3100/PAP/issues/PAP-1179")).toBeNull();
    expect(parseIssueReferenceFromHref("http://remote.example.test:3103/PAPA/issues/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("ignores literal route placeholder paths", () => {
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("http://localhost:3100/api/issues/:id")).toBeNull();
  });

  it("rejects placeholder identifiers in issue:// scheme hrefs", () => {
    // Real-world breakage: agent transcripts and runbook templates contain
    // sample text like `issue://<issue-identifier>` or `issue://{issueId}`.
    // Without filtering these out, the markdown renderer mounts a MarkdownIssueLink
    // for each one and fires a 404 fetch per occurrence.
    expect(parseIssueReferenceFromHref("issue://<issue-identifier>")).toBeNull();
    expect(parseIssueReferenceFromHref("issue://{issueId}")).toBeNull();
    expect(parseIssueReferenceFromHref("issue://[issue-id]")).toBeNull();
    expect(parseIssueReferenceFromHref("issue://(issueId)")).toBeNull();
    expect(parseIssueReferenceFromHref("issue://ZED-24)")).toBeNull();
    expect(parseIssueReferenceFromHref("issue://my issue")).toBeNull();
  });

  it("rejects placeholder identifiers embedded in /issues/ paths", () => {
    expect(parseIssueReferenceFromHref("/issues/<issue-identifier>")).toBeNull();
    expect(parseIssueReferenceFromHref("/issues/{issueId}")).toBeNull();
    expect(parseIssueReferenceFromHref("/PAP/issues/{issueId}")).toBeNull();
  });

  it("still accepts UUID-like ids via issue:// scheme", () => {
    expect(parseIssueReferenceFromHref("issue://abcdef12-3456-7890-abcd-ef0123456789")).toEqual({
      issuePathId: "abcdef12-3456-7890-abcd-ef0123456789",
      href: "/issues/abcdef12-3456-7890-abcd-ef0123456789",
    });
  });

  describe("isValidIssuePathId", () => {
    it("accepts bare identifiers and UUID-like ids", () => {
      expect(isValidIssuePathId("PAP-1271")).toBe(true);
      expect(isValidIssuePathId("pc1a2-7")).toBe(true);
      expect(isValidIssuePathId("abcdef12-3456-7890-abcd-ef0123456789")).toBe(true);
    });

    it("rejects placeholders and structurally invalid ids", () => {
      expect(isValidIssuePathId("")).toBe(false);
      expect(isValidIssuePathId("   ")).toBe(false);
      expect(isValidIssuePathId(null)).toBe(false);
      expect(isValidIssuePathId(undefined)).toBe(false);
      expect(isValidIssuePathId("<issue-identifier>")).toBe(false);
      expect(isValidIssuePathId("{issueId}")).toBe(false);
      expect(isValidIssuePathId(":id")).toBe(false);
      expect(isValidIssuePathId("ZED-24)")).toBe(false);
      expect(isValidIssuePathId("PAP-")).toBe(false);
      expect(isValidIssuePathId("PAP")).toBe(false);
      expect(isValidIssuePathId("123-PAP")).toBe(false);
    });
  });
});
