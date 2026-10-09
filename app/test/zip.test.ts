// zip.test.ts — the pure-JS ZIP reader that replaces `unzip` (§2.2).
//
// The writer below is a deliberately dumb one: a test that used a real archiver
// would be testing that archiver.  What matters is that *our* reader agrees with
// the format spec and with the two layouts Google's platform-tools zip uses
// (stored + deflate, sizes in the central directory, unix permission bits).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { crc32, extractZip, readEntryData, readZipEntries } from '../src/main/zip.js';

interface Entry {
  name: string;
  data: Buffer;
  method?: 0 | 8 | 12;
  unixMode?: number;
}

function localHeader(name: Buffer, method: number, crc: number, csize: number, usize: number): Buffer {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4); // version needed
  b.writeUInt16LE(0, 6); // flags
  b.writeUInt16LE(method, 8);
  b.writeUInt16LE(0, 10); // time
  b.writeUInt16LE(0, 12); // date
  b.writeUInt32LE(crc, 14);
  b.writeUInt32LE(csize, 18);
  b.writeUInt32LE(usize, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(0, 28);
  return b;
}

function centralHeader(name: Buffer, method: number, crc: number, csize: number, usize: number, lho: number, unixMode: number): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE((3 << 8) | 20, 4); // made by unix
  b.writeUInt16LE(20, 6);
  b.writeUInt16LE(0, 8);
  b.writeUInt16LE(method, 10);
  b.writeUInt16LE(0, 12);
  b.writeUInt16LE(0, 14);
  b.writeUInt32LE(crc, 16);
  b.writeUInt32LE(csize, 20);
  b.writeUInt32LE(usize, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt16LE(0, 30);
  b.writeUInt16LE(0, 32);
  b.writeUInt16LE(0, 34);
  b.writeUInt16LE(0, 36);
  b.writeUInt32LE((unixMode & 0xffff) << 16, 38); // external attributes
  b.writeUInt32LE(lho, 42);
  return b;
}

function buildZip(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const isDir = e.name.endsWith('/');
    const method = isDir ? 0 : (e.method ?? 8);
    const raw = isDir ? Buffer.alloc(0) : e.data;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    parts.push(localHeader(name, method, crc, body.length, raw.length), name, body);
    centrals.push(centralHeader(name, method, crc, body.length, raw.length, offset, e.unixMode ?? 0), name);
    offset += 30 + name.length + body.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, central, eocd]);
}

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ether-zip-'));
}

test('crc32 matches the standard test vector', () => {
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('readZipEntries lists names, methods, directory flags and unix modes', () => {
  const zip = buildZip([
    { name: 'platform-tools/', data: Buffer.alloc(0), unixMode: 0o755 },
    { name: 'platform-tools/adb', data: Buffer.from('ELF-not-really', 'utf8'), method: 0, unixMode: 0o755 },
    { name: 'platform-tools/NOTICE.txt', data: Buffer.from('x'.repeat(5000), 'utf8'), method: 8 },
  ]);
  const entries = readZipEntries(zip);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['platform-tools/', 'platform-tools/adb', 'platform-tools/NOTICE.txt'],
  );
  assert.equal(entries[0]!.isDir, true);
  assert.equal(entries[1]!.method, 0);
  assert.equal(entries[1]!.unixMode, 0o755);
  assert.equal(entries[2]!.method, 8);
  assert.equal(entries[2]!.uncompressedSize, 5000);
});

test('readEntryData round-trips stored and deflated payloads', () => {
  const stored = Buffer.from([0, 1, 2, 250, 251, 252]);
  const deflated = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  const zip = buildZip([
    { name: 'stored.bin', data: stored, method: 0 },
    { name: 'deflated.bin', data: deflated, method: 8 },
  ]);
  const entries = readZipEntries(zip);
  assert.deepEqual(readEntryData(zip, entries[0]!), stored);
  assert.deepEqual(readEntryData(zip, entries[1]!), deflated);
});

test('readEntryData refuses a corrupted payload (CRC mismatch)', () => {
  const data = Buffer.from('permission-denied-once-corrupted', 'utf8');
  const zip = buildZip([{ name: 'a.bin', data, method: 0 }]);
  const bodyStart = 30 + 'a.bin'.length;
  zip[bodyStart] = zip[bodyStart]! ^ 0xff;
  assert.throws(() => readEntryData(zip, readZipEntries(zip)[0]!), /CRC mismatch/);
});

test('readEntryData refuses an unsupported compression method', () => {
  const zip = buildZip([{ name: 'weird.bin', data: Buffer.from('abc'), method: 12 }]);
  assert.throws(() => readEntryData(zip, readZipEntries(zip)[0]!), /unsupported compression method 12/);
});

test('readZipEntries refuses zip64 rather than mis-reading it', () => {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 10); // entry count == sentinel
  assert.throws(() => readZipEntries(eocd), /zip64/);
});

test('readZipEntries refuses a non-zip buffer', () => {
  assert.throws(() => readZipEntries(Buffer.from('this is not a zip file, not even close')), /central directory/);
});

test('extractZip writes files, restores the executable bit and returns the paths', async () => {
  const dir = tmpDir();
  try {
    const zip = buildZip([
      { name: 'platform-tools/', data: Buffer.alloc(0), unixMode: 0o755 },
      { name: 'platform-tools/adb', data: Buffer.from('#!/bin/sh\necho hi\n', 'utf8'), method: 8, unixMode: 0o755 },
      { name: 'platform-tools/NOTICE.txt', data: Buffer.from('notice\n', 'utf8'), method: 0, unixMode: 0o644 },
    ]);
    const written = await extractZip(zip, dir);
    assert.equal(written.length, 2);
    assert.ok(existsSync(path.join(dir, 'platform-tools', 'adb')));
    const mode = statSync(path.join(dir, 'platform-tools', 'adb')).mode & 0o777;
    assert.equal(mode, 0o755);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractZip refuses entries that would escape the destination', async () => {
  const dir = tmpDir();
  try {
    const escape = buildZip([{ name: '../evil.sh', data: Buffer.from('boom'), method: 0 }]);
    await assert.rejects(() => extractZip(escape, dir), /path escapes dest/);
    const absolute = buildZip([{ name: '/etc/passwd', data: Buffer.from('boom'), method: 0 }]);
    await assert.rejects(() => extractZip(absolute, dir), /absolute path/);
    assert.ok(!existsSync(path.join(dir, '..', 'evil.sh')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
