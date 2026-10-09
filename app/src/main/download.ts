// download.ts — one HTTPS GET into one file, used by the two things this app fetches
// at runtime (Android platform-tools, and — on Windows — the USB driver package).
//
// Why it is not part of adb.ts any more: the driver download needs the same redirect
// handling, the same progress line and the same "a failed fetch must not leave a
// half-written file behind" rule, and two copies of that is how one of them rots.  The
// error type is deliberately plain: the caller decides what a failure means for its
// own vocabulary (`adb.ts` re-throws it as its `download` code).

import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import https from 'node:https';

/** The progress line step: one line every 4 MiB, and one at the end. */
const PROGRESS = 4 << 20;
const DEFAULT_TIMEOUT = 60_000;

export class DownloadError extends Error {}

/**
 * Fetch `url` into `dest`.  A redirect is followed (dl.google.com uses them for the
 * region), a non-200 is an error, and any failure removes the partial file: the next
 * start must not find a truncated zip and call it a cache hit.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  log: (l: string) => void,
  label: string,
  opts: { timeoutMs?: number; redirects?: number } = {},
): Promise<void> {
  const redirects = opts.redirects ?? 0;
  if (redirects > 5) throw new DownloadError(`${label}: too many redirects`);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const req = https.get(url, (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          resolve(
            downloadToFile(new URL(res.headers.location, url).toString(), dest, log, label, {
              timeoutMs: timeout,
              redirects: redirects + 1,
            }),
          );
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new DownloadError(`${label}: HTTP ${code}`));
          return;
        }
        const out = createWriteStream(dest);
        res.on('data', (c: Buffer) => {
          total += c.length;
          out.write(c);
          if (total % PROGRESS < c.length) log(`downloading ${label}… ${(total >> 20)} MiB`);
        });
        res.on('end', () => out.end(() => resolve()));
        res.on('error', (e) => out.destroy(e));
        out.on('error', reject);
      });
      req.on('error', (e) => reject(new DownloadError(`${label}: ${e.message}`)));
      req.setTimeout(timeout, () => {
        req.destroy(new DownloadError(`${label}: timed out after ${timeout / 1000}s`));
      });
    });
  } catch (e) {
    await rm(dest, { force: true }).catch(() => undefined);
    throw e;
  }
  log(`downloaded ${label} ${total >> 20} MiB -> ${dest}`);
}
