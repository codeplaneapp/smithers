import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { accountsFilePath } from "./accountsFilePath.js";

// Max time an acquirer spins waiting for the lock before erroring.
const LOCK_TIMEOUT_MS = 10_000;
// Lock-file age past which the holder is presumed crashed and the lock is broken.
const STALE_LOCK_MS = 30_000;
// Disambiguates concurrent in-process stale-break attempts' side-path names.
let breakSeq = 0;

/**
 * Cross-process advisory lock around accounts.json read-modify-write. Smithers
 * runs many agents/CLIs concurrently and both the wizard and the programmatic
 * API can mutate ~/.smithers/accounts.json at the same time. Without a lock,
 * two callers each readAccounts() the same base state and then writeAccounts()
 * the whole file via atomic rename — the second rename clobbers the first
 * writer's entry (lost update). This serializes those critical sections.
 *
 * The lock is an O_EXCL lock file next to accounts.json: only one process can
 * create it. Others spin-wait briefly. A lock older than {@link STALE_LOCK_MS}
 * is treated as orphaned (the holder crashed) and broken, so a killed process
 * can never wedge the registry permanently — which matters because Smithers'
 * whole premise is surviving kills/restarts.
 *
 * @template T
 * @param {NodeJS.ProcessEnv} env
 * @param {() => T} critical the read-modify-write to run while holding the lock
 * @returns {T}
 */
export function withAccountsLock(env, critical) {
  const lockPath = `${accountsFilePath(env)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = -1;
  let ownedIno = -1;
  for (;;) {
    try {
      // wx === O_CREAT | O_EXCL | O_WRONLY: atomic create-or-fail.
      fd = openSync(lockPath, "wx", 0o600);
      ownedIno = fstatSync(fd).ino;
      break;
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out acquiring accounts lock at ${lockPath} after ${LOCK_TIMEOUT_MS}ms; another process may be stuck holding it.`,
        );
      }
      // A lock older than STALE_LOCK_MS is orphaned (the holder almost
      // certainly crashed): break it and retry immediately. statSync and
      // rmSync are not atomic with respect to other waiters, so we
      // cannot just rmSync(lockPath) here — between our stat and our
      // remove, another waiter may have already broken this same lock
      // and a new holder may have created a brand-new one at the same
      // path, and we must never delete *that*. Instead, rename the
      // directory entry aside (rename is atomic: only one waiter can
      // ever win the rename of a given path — a loser gets ENOENT and
      // retries) and only delete the renamed-aside file once its inode
      // proves it is the exact file we observed as stale.
      let lockStat;
      try {
        lockStat = statSync(lockPath);
      } catch {
        // Lock vanished between EEXIST and stat: the holder released it. Retry.
        continue;
      }
      if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
        const observedIno = lockStat.ino;
        const sidePath = `${lockPath}.stale.${process.pid}.${breakSeq++}`;
        try {
          renameSync(lockPath, sidePath);
        } catch (renameCause) {
          // Someone else already broke or released this lock. Retry.
          if (renameCause?.code === "ENOENT") continue;
          throw renameCause;
        }
        let sideIno;
        try {
          sideIno = statSync(sidePath).ino;
        } catch {
          continue;
        }
        if (sideIno === observedIno) {
          // Confirmed: this is the exact file we observed as stale.
          rmSync(sidePath, { force: true });
          continue;
        }
        // We moved a lock created *after* our stat — a fresh lock a
        // successor acquired in the gap. Restore it instead of
        // destroying a live holder's lock, then fall through to
        // respect it via the busy-wait spin below.
        try {
          renameSync(sidePath, lockPath);
        } catch {
          try {
            rmSync(sidePath, { force: true });
          } catch {}
        }
      }
      // Busy-wait a few milliseconds before retrying. This API is fully
      // synchronous, so the critical section never yields the event loop —
      // a short spin is simpler and safer than introducing async.
      const spinUntil = Date.now() + 5;
      while (Date.now() < spinUntil) {
        // intentional busy-wait
      }
    }
  }
  try {
    writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
    return critical();
  } finally {
    try {
      closeSync(fd);
    } catch {}
    // Only remove the lock file if it is still the exact file we created:
    // if it was (mistakenly) broken while we were inside the critical
    // section, a successor may already hold a fresh lock at this path,
    // and deleting it would admit a second concurrent holder.
    try {
      if (ownedIno >= 0 && statSync(lockPath).ino === ownedIno) {
        rmSync(lockPath, { force: true });
      }
    } catch {}
  }
}
