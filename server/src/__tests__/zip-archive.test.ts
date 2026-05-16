import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractZipArchive, ZipArchiveError } from "../lib/zip-archive.js";

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

type ZipEntry = {
  path: string;
  content: string | Uint8Array;
  compression?: "store" | "deflate";
};

function buildZip(entries: ZipEntry[]): Buffer {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileName = encoder.encode(entry.path);
    const body =
      typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    const checksum = crc32(body);
    const method = entry.compression === "deflate" ? 8 : 0;
    const stored = method === 0 ? body : deflateRawSync(body);

    const localHeader = new Uint8Array(30 + fileName.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, method);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, stored.length);
    writeUint32(localHeader, 22, body.length);
    writeUint16(localHeader, 26, fileName.length);
    localHeader.set(fileName, 30);

    const centralHeader = new Uint8Array(46 + fileName.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, method);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, stored.length);
    writeUint32(centralHeader, 24, body.length);
    writeUint16(centralHeader, 28, fileName.length);
    writeUint32(centralHeader, 42, localOffset);
    centralHeader.set(fileName, 46);

    localChunks.push(localHeader, stored);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + stored.length;
  }

  const centralDirectoryLength = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const total =
    localChunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralDirectoryLength + 22;
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of localChunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  const centralDirectoryOffset = offset;
  for (const chunk of centralChunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  writeUint32(archive, offset, 0x06054b50);
  writeUint16(archive, offset + 8, entries.length);
  writeUint16(archive, offset + 10, entries.length);
  writeUint32(archive, offset + 12, centralDirectoryLength);
  writeUint32(archive, offset + 16, centralDirectoryOffset);
  return Buffer.from(archive);
}

describe("extractZipArchive", () => {
  it("reads stored entries and strips the shared root", () => {
    const zip = buildZip([
      { path: "my-skill/SKILL.md", content: "# Hello\n" },
      { path: "my-skill/scripts/run.sh", content: "echo hi\n" },
    ]);

    const result = extractZipArchive(zip);

    expect(result.strippedRoot).toBe("my-skill");
    expect(result.entries.map((entry) => entry.path).sort()).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
    expect(result.entries.find((entry) => entry.path === "SKILL.md")?.bytes.toString("utf8"))
      .toBe("# Hello\n");
  });

  it("reads deflate-compressed entries", () => {
    const zip = buildZip([
      { path: "SKILL.md", content: "deflate body content\n".repeat(50), compression: "deflate" },
    ]);

    const result = extractZipArchive(zip);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.bytes.toString("utf8")).toBe("deflate body content\n".repeat(50));
  });

  it("rejects paths with parent-directory segments", () => {
    const zip = buildZip([{ path: "../escape.md", content: "nope" }]);

    expect(() => extractZipArchive(zip)).toThrow(ZipArchiveError);
    expect(() => extractZipArchive(zip)).toThrow(/unsafe path/i);
  });

  it("normalizes leading-slash paths into safe relative paths", () => {
    const zip = buildZip([
      { path: "/etc/passwd", content: "data" },
      { path: "/etc/sub", content: "sub" },
    ]);

    const result = extractZipArchive(zip);

    expect(result.entries.every((entry) => !entry.path.startsWith("/"))).toBe(true);
    expect(result.entries.every((entry) => !entry.path.includes(".."))).toBe(true);
  });

  it("rejects Windows-style absolute paths", () => {
    const zip = buildZip([{ path: "C:/Windows/System32/evil", content: "nope" }]);

    expect(() => extractZipArchive(zip)).toThrow(ZipArchiveError);
  });

  it("skips macOS metadata entries", () => {
    const zip = buildZip([
      { path: "my-skill/SKILL.md", content: "# Hello\n" },
      { path: "__MACOSX/my-skill/._SKILL.md", content: "metadata" },
      { path: "my-skill/.DS_Store", content: "DS junk" },
    ]);

    const result = extractZipArchive(zip);

    expect(result.entries.map((entry) => entry.path).sort()).toEqual(["SKILL.md"]);
  });

  it("returns no shared root when entries diverge at top level", () => {
    const zip = buildZip([
      { path: "SKILL.md", content: "# Hello\n" },
      { path: "scripts/run.sh", content: "echo hi\n" },
    ]);

    const result = extractZipArchive(zip);

    expect(result.strippedRoot).toBeNull();
    expect(result.entries.map((entry) => entry.path).sort()).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
  });

  it("rejects archives whose total uncompressed size exceeds the limit", () => {
    const big = "x".repeat(64);
    const zip = buildZip([
      { path: "SKILL.md", content: big },
      { path: "extra.txt", content: big },
    ]);

    expect(() =>
      extractZipArchive(zip, { maxTotalUncompressedBytes: 100 }),
    ).toThrow(/total/i);
  });

  it("rejects archives that are not zip", () => {
    expect(() => extractZipArchive(Buffer.from("not a zip"))).toThrow(ZipArchiveError);
  });
});
