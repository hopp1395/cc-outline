import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { promisify } from "node:util";
import { deflateRaw, inflateRawSync } from "node:zlib";

/**
 * A minimal zip archive: stored or deflated entries, no zip64 (entries and the
 * archive under 4 GB), names in UTF-8. Enough for the session export and its
 * import, without a dependency.
 */

const deflate = promisify(deflateRaw);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Date and time in the DOS format zip headers use (local time, 2 s steps). */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const UTF8_FLAG = 0x0800;
const STORE = 0;
const DEFLATE = 8;
/** Smaller entries are stored: deflating them gains nothing. */
const MIN_DEFLATE = 64;

interface Central {
  name: Buffer;
  crc: number;
  method: number;
  compressed: number;
  size: number;
  offset: number;
  time: { time: number; date: number };
}

/** Writes a zip archive entry by entry to `file`; `close` writes the central directory. */
export class ZipWriter {
  private fd: number;
  private offset = 0;
  private entries: Central[] = [];
  private names = new Set<string>();

  constructor(readonly file: string) {
    this.fd = openSync(file, "w");
  }

  private write(buf: Buffer): void {
    writeSync(this.fd, buf);
    this.offset += buf.length;
  }

  /** Adds an entry; `name` uses forward slashes. A name added twice is skipped. */
  async add(name: string, data: Buffer | string, modified = new Date()): Promise<void> {
    if (this.names.has(name)) return;
    this.names.add(name);
    const raw = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const packed = raw.length >= MIN_DEFLATE ? await deflate(raw) : undefined;
    const method = packed && packed.length < raw.length ? DEFLATE : STORE;
    const body = method === DEFLATE ? packed! : raw;
    const entry: Central = {
      name: Buffer.from(name, "utf8"),
      crc: crc32(raw),
      method,
      compressed: body.length,
      size: raw.length,
      offset: this.offset,
      time: dosTime(modified),
    };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(entry.time.time, 10);
    header.writeUInt16LE(entry.time.date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compressed, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(entry.name.length, 26);
    header.writeUInt16LE(0, 28);
    this.write(header);
    this.write(entry.name);
    this.write(body);
    this.entries.push(entry);
  }

  /** Writes the central directory and closes the file. */
  close(): void {
    const start = this.offset;
    for (const e of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(e.method, 10);
      header.writeUInt16LE(e.time.time, 12);
      header.writeUInt16LE(e.time.date, 14);
      header.writeUInt32LE(e.crc, 16);
      header.writeUInt32LE(e.compressed, 20);
      header.writeUInt32LE(e.size, 24);
      header.writeUInt16LE(e.name.length, 28);
      header.writeUInt32LE(e.offset, 42);
      this.write(header);
      this.write(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    this.write(end);
    closeSync(this.fd);
  }

  /** Closes the file without finishing it, e.g. after a failure. */
  abort(): void {
    try {
      closeSync(this.fd);
    } catch {
      // Already closed.
    }
  }
}

/** An entry of a zip archive read with `readZip`; `data` unpacks it. */
export interface ZipEntry {
  name: string;
  size: number;
  modified: Date;
  data: () => Buffer;
}

/** The entries of the zip archive `file` (stored or deflated). Throws when it is no zip archive. */
export function readZip(file: string): ZipEntry[] {
  const buf = readFileSync(file);
  // The end of central directory record, searched backwards past a comment of up to 64 KB.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("damaged zip archive");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const time = buf.readUInt16LE(at + 12);
    const date = buf.readUInt16LE(at + 14);
    const crc = buf.readUInt32LE(at + 16);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString(flags & UTF8_FLAG ? "utf8" : "latin1");
    at += 46 + nameLength + extraLength + commentLength;
    const modified = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
    entries.push({
      name,
      size,
      modified,
      data: () => {
        const local = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
        const body = buf.subarray(local, local + compressed);
        const raw = method === STORE ? Buffer.from(body) : method === DEFLATE ? inflateRawSync(body) : undefined;
        if (!raw) throw new Error(`${name}: unsupported compression`);
        if (crc32(raw) !== crc) throw new Error(`${name}: checksum mismatch`);
        return raw;
      },
    });
  }
  return entries;
}
