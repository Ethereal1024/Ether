// tmp.ts — remove a test's temporary directory without racing the process inside it.
//
// The tests that start a real Controller (and the fake adb / fake Sunshine children behind
// it) end with `down()`, but a child can still be flushing a log, a pid file or a reverse
// table into the data directory while `rm` walks it.  In that window `rmSync` reports
// ENOTEMPTY — the directory looked empty to `rmdir`, then something appeared — which is how
// a green suite went red in v0.2.9's release verify ("directory not empty, rmdir
// '/tmp/ether-autoconnect-press-…'"), on a test that had passed on the same commit twice.
//
// Retrying is the right shape for that race: give the last write a few tens of milliseconds
// rather than weakening the test or ignoring the error.  Node's own retry loop covers
// ENOTEMPTY, EBUSY and EPERM.
import { rmSync } from 'node:fs';

/** Delete a test's scratch directory, tolerating a child that is still writing into it. */
export function rmTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
