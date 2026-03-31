import type { LockRepository } from "../storage/repositories/locks.js";

export interface AcquireLockParams {
  lockType: "issue" | "workspace";
  lockKey: string;
  ownerId: string;
  daemonPid: number;
}

/**
 * Attempt to acquire an execution lock.
 *
 * Returns true if the lock was acquired, false if it is already held
 * (unique constraint violation on lockType+lockKey).
 */
export function acquireLock(
  lockRepo: LockRepository,
  params: AcquireLockParams
): boolean {
  try {
    lockRepo.insert(params);
    return true;
  } catch {
    // Unique constraint violation means lock already held
    return false;
  }
}

/**
 * Release an execution lock owned by a specific run.
 *
 * Idempotent -- no-op if the lock does not exist.
 */
export function releaseLock(
  lockRepo: LockRepository,
  _lockType: string,
  _lockKey: string,
  ownerId: string
): void {
  lockRepo.deleteByOwner(ownerId);
}

/**
 * Release all locks held by daemon PIDs other than the current one.
 *
 * Used on daemon startup to clean up locks from a previously crashed daemon.
 * Returns the number of stale locks released.
 */
export function releaseAllStaleLocks(
  lockRepo: LockRepository,
  currentPid: number
): number {
  return lockRepo.deleteByStale(currentPid);
}
