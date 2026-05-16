import { inflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIRECTORY_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 65535;

export class ZipArchiveError extends Error {
  code: string;
  constructor(message: string, code = "ZIP_INVALID") {
    super(message);
    this.name = "ZipArchiveError";
    this.code = code;
  }
}

export interface ZipArchiveEntry {
  path: string;
  bytes: Buffer;
}

export interface ExtractZipOptions {
  /** Cap on the sum of uncompressed bytes across all entries. */
  maxTotalUncompressedBytes?: number;
  /** Cap on the uncompressed size of any single entry. */
  maxEntryUncompressedBytes?: number;
  /** Cap on the number of entries (post-filter). */
  maxEntries?: number;
}

export interface ExtractZipResult {
  /** Entries with paths normalized and shared top-level directory stripped. */
  entries: ZipArchiveEntry[];
  /** The shared top-level directory that was stripped, if any. */
  strippedRoot: string | null;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function isUnsafeArchivePath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("/")) return true;
  if (/^[a-zA-Z]:\//.test(value)) return true;
  const segments = value.split("/");
  return segments.some((segment) => segment === ".." || segment === "" || /\0/.test(segment));
}

function isIgnorableArchivePath(value: string): boolean {
  if (!value) return true;
  const first = value.split("/")[0];
  if (first === "__MACOSX") return true;
  if (value.endsWith("/.DS_Store") || value === ".DS_Store") return true;
  return false;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < EOCD_MIN_SIZE) {
    throw new ZipArchiveError("File is too small to be a valid zip archive", "ZIP_TOO_SHORT");
  }
  const minOffset = Math.max(0, buffer.length - (EOCD_MIN_SIZE + EOCD_MAX_COMMENT));
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) {
      return offset;
    }
  }
  throw new ZipArchiveError("End of central directory record not found", "EOCD_MISSING");
}

function readCentralDirectoryLocation(buffer: Buffer, eocdOffset: number) {
  let totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let cdSize = buffer.readUInt32LE(eocdOffset + 12);
  let cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  const usesZip64 = cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff;
  if (!usesZip64) return { totalEntries, cdOffset, cdSize };

  const locatorOffset = eocdOffset - 20;
  if (
    locatorOffset >= 0
    && buffer.readUInt32LE(locatorOffset) === ZIP64_EOCD_LOCATOR_SIG
  ) {
    const zip64EocdOffset = Number(buffer.readBigUInt64LE(locatorOffset + 8));
    if (
      zip64EocdOffset >= 0
      && zip64EocdOffset + 56 <= buffer.length
      && buffer.readUInt32LE(zip64EocdOffset) === ZIP64_EOCD_SIG
    ) {
      totalEntries = Number(buffer.readBigUInt64LE(zip64EocdOffset + 32));
      cdSize = Number(buffer.readBigUInt64LE(zip64EocdOffset + 40));
      cdOffset = Number(buffer.readBigUInt64LE(zip64EocdOffset + 48));
    }
  }
  return { totalEntries, cdOffset, cdSize };
}

function decompressEntry(
  method: number,
  compressed: Buffer,
  expectedSize: number,
  pathLabel: string,
): Buffer {
  if (method === 0) {
    return Buffer.from(compressed);
  }
  if (method === 8) {
    try {
      return Buffer.from(inflateRawSync(compressed));
    } catch (err) {
      throw new ZipArchiveError(
        `Failed to decompress ${pathLabel}: ${err instanceof Error ? err.message : String(err)}`,
        "DECOMPRESSION_FAILED",
      );
    }
  }
  throw new ZipArchiveError(
    `Unsupported compression method ${method} for ${pathLabel}`,
    "UNSUPPORTED_COMPRESSION",
  );
}

function sharedTopLevelDir(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const firstSegmentsList = paths
    .map((value) => value.split("/").filter(Boolean))
    .filter((parts) => parts.length > 0);
  if (firstSegmentsList.length === 0) return null;
  const candidate = firstSegmentsList[0]![0]!;
  return firstSegmentsList.every((parts) => parts.length > 1 && parts[0] === candidate)
    ? candidate
    : null;
}

/**
 * Parses a zip archive and returns its file entries. Supports STORE/DEFLATE,
 * ZIP64 metadata, and entries written with data descriptors (sizes are taken
 * from the central directory, not the local file header).
 */
export function extractZipArchive(input: Buffer, options: ExtractZipOptions = {}): ExtractZipResult {
  const maxEntries = options.maxEntries ?? 2_000;
  const maxTotalUncompressedBytes = options.maxTotalUncompressedBytes ?? 50 * 1024 * 1024;
  const maxEntryUncompressedBytes = options.maxEntryUncompressedBytes ?? 25 * 1024 * 1024;

  const eocdOffset = findEndOfCentralDirectory(input);
  const { totalEntries, cdOffset, cdSize } = readCentralDirectoryLocation(input, eocdOffset);

  if (totalEntries > maxEntries) {
    throw new ZipArchiveError(
      `Zip contains ${totalEntries} entries; limit is ${maxEntries}`,
      "TOO_MANY_ENTRIES",
    );
  }
  if (cdOffset < 0 || cdOffset + cdSize > input.length) {
    throw new ZipArchiveError("Central directory location is out of range", "CD_OUT_OF_RANGE");
  }

  const entries: ZipArchiveEntry[] = [];
  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > input.length) {
      throw new ZipArchiveError("Truncated central directory entry", "CD_TRUNCATED");
    }
    if (input.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIG) {
      throw new ZipArchiveError("Central directory signature mismatch", "CD_SIG_MISMATCH");
    }

    const compressionMethod = input.readUInt16LE(cursor + 10);
    let compressedSize = input.readUInt32LE(cursor + 20);
    let uncompressedSize = input.readUInt32LE(cursor + 24);
    const fileNameLength = input.readUInt16LE(cursor + 28);
    const extraFieldLength = input.readUInt16LE(cursor + 30);
    const commentLength = input.readUInt16LE(cursor + 32);
    let localHeaderOffset = input.readUInt32LE(cursor + 42);

    const nameStart = cursor + 46;
    const nameEnd = nameStart + fileNameLength;
    const extraEnd = nameEnd + extraFieldLength;
    const entryEnd = extraEnd + commentLength;
    if (entryEnd > input.length) {
      throw new ZipArchiveError("Central directory entry overruns buffer", "CD_TRUNCATED");
    }
    const rawName = input.toString("utf8", nameStart, nameEnd);

    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff
    ) {
      let extraCursor = nameEnd;
      while (extraCursor + 4 <= extraEnd) {
        const headerId = input.readUInt16LE(extraCursor);
        const dataSize = input.readUInt16LE(extraCursor + 2);
        if (headerId === 0x0001 && extraCursor + 4 + dataSize <= extraEnd) {
          let p = extraCursor + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(input.readBigUInt64LE(p));
            p += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(input.readBigUInt64LE(p));
            p += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(input.readBigUInt64LE(p));
            p += 8;
          }
          break;
        }
        extraCursor += 4 + dataSize;
      }
    }

    cursor = entryEnd;

    const normalizedName = normalizePath(rawName);
    const isDirectoryEntry = rawName.endsWith("/") || rawName.endsWith("\\");
    if (isDirectoryEntry || !normalizedName) continue;
    if (isIgnorableArchivePath(normalizedName)) continue;
    if (isUnsafeArchivePath(normalizedName)) {
      throw new ZipArchiveError(`Zip contains unsafe path: ${rawName}`, "UNSAFE_PATH");
    }
    if (uncompressedSize > maxEntryUncompressedBytes) {
      throw new ZipArchiveError(
        `Zip entry ${normalizedName} exceeds the ${maxEntryUncompressedBytes}-byte single-entry limit`,
        "ENTRY_TOO_LARGE",
      );
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxTotalUncompressedBytes) {
      throw new ZipArchiveError(
        `Zip uncompressed size exceeds the ${maxTotalUncompressedBytes}-byte total limit`,
        "TOTAL_TOO_LARGE",
      );
    }

    if (localHeaderOffset < 0 || localHeaderOffset + 30 > input.length) {
      throw new ZipArchiveError("Local file header offset is out of range", "LFH_OUT_OF_RANGE");
    }
    if (input.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIG) {
      throw new ZipArchiveError(
        `Local file header signature mismatch for ${normalizedName}`,
        "LFH_SIG_MISMATCH",
      );
    }
    const localFileNameLength = input.readUInt16LE(localHeaderOffset + 26);
    const localExtraFieldLength = input.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > input.length) {
      throw new ZipArchiveError(
        `Zip data for ${normalizedName} extends past end of archive`,
        "DATA_TRUNCATED",
      );
    }
    const compressed = input.subarray(dataStart, dataEnd);
    const bytes = decompressEntry(compressionMethod, compressed, uncompressedSize, normalizedName);

    entries.push({ path: normalizedName, bytes });
  }

  const strippedRoot = sharedTopLevelDir(entries.map((entry) => entry.path));
  const finalEntries = strippedRoot
    ? entries
      .map((entry) => ({
        path: entry.path.startsWith(`${strippedRoot}/`)
          ? entry.path.slice(strippedRoot.length + 1)
          : entry.path,
        bytes: entry.bytes,
      }))
      .filter((entry) => entry.path.length > 0)
    : entries;

  return { entries: finalEntries, strippedRoot };
}
