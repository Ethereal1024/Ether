// zip.ts — minimal ZIP reader built on node:zlib.
//
// Why not shell out to `unzip`?  Because the whole point of the Node relay /
// Electron choice is "no host-side dependency": `unzip` is absent on a stock
// Windows box, and pulling in a native module would drag back the very build
// matrix the plan avoids (§2.2, §3.1).
//
// Scope: exactly what `platform-tools-latest-*.zip` needs — stored (0) and
// deflate (8) entries, central-directory sizes, unix permission bits, CRC32
// verification.  Zip64 is detected and refused loudly rather than mis-read.

import { createWriteStream } from 'node:fs';
import { mkdir, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDir: boolean;
  /** Unix mode from the "version made by" high byte, or 0 when not a unix zip. */
  unixMode: number;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function findEocd(buf: Buffer): number {
  // The comment is at most 65535 bytes, so the EOCD starts within that window.
  const min = Math.max(0, buf.length - (65535 + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('zip: end of central directory not found (not a zip file?)');
}

export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || total === 0xffff) {
    throw new Error('zip: zip64 archives are not supported');
  }
  if (cdOffset + cdSize > buf.length) throw new Error('zip: central directory is out of range');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== CDH_SIG) throw new Error('zip: bad central directory header');
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) {
      throw new Error(`zip: zip64 entry not supported (${name})`);
    }
    const host = versionMadeBy >>> 8;
    entries.push({
      name,
      method,
      crc32: crc,
      compressedSize: csize,
      uncompressedSize: usize,
      localHeaderOffset: lho,
      isDir: name.endsWith('/'),
      unixMode: host === 3 ? (externalAttrs >>> 16) & 0xffff : 0,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract one entry's payload, verifying CRC32. */
export function readEntryData(buf: Buffer, e: ZipEntry): Buffer {
  const lho = e.localHeaderOffset;
  if (buf.readUInt32LE(lho) !== LFH_SIG) throw new Error(`zip: bad local header for ${e.name}`);
  const nameLen = buf.readUInt16LE(lho + 26);
  const extraLen = buf.readUInt16LE(lho + 28);
  const start = lho + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressedSize);

  let data: Buffer;
  if (e.method === 0) data = Buffer.from(raw);
  else if (e.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: 1 << 30 });
  else throw new Error(`zip: unsupported compression method ${e.method} for ${e.name}`);

  if (data.length !== e.uncompressedSize) {
    throw new Error(`zip: size mismatch for ${e.name} (${data.length} != ${e.uncompressedSize})`);
  }
  if (crc32(data) !== e.crc32) throw new Error(`zip: CRC mismatch for ${e.name}`);
  return data;
}

function safeJoin(destDir: string, name: string): string {
  const clean = name.replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) throw new Error(`zip: absolute path ${name}`);
  const out = path.resolve(destDir, clean);
  const root = path.resolve(destDir);
  if (out !== root && !out.startsWith(root + path.sep)) throw new Error(`zip: path escapes dest (${name})`);
  return out;
}

/** Extract every entry under destDir, restoring unix permission bits. */
export async function extractZip(buf: Buffer, destDir: string, log: (l: string) => void = () => {}): Promise<string[]> {
  const entries = readZipEntries(buf);
  const written: string[] = [];
  for (const e of entries) {
    const target = safeJoin(destDir, e.name);
    if (e.isDir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const data = readEntryData(buf, e);
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(target);
      ws.on('error', reject);
      ws.on('close', () => resolve());
      ws.end(data);
    });
    if (e.unixMode) await chmod(target, e.unixMode & 0o777);
    written.push(target);
    log(`extracted ${e.name} (${data.length} bytes)`);
  }
  return written;
}

export async function cleanDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
