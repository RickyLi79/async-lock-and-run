type LockerId = string | number | symbol;

/**
 * Per-key lock entry. `lockerId` identifies which key this acquisition holds;
 * `tail` is the FIFO gate promise (the next call for the same key awaits it
 * before running); `unlocked` flips to `true` once this acquisition releases
 * the lock.
 */
type LockEntry = {
  lockerId: LockerId;
  tail: Promise<void>;
  unlocked: boolean;
};

/**
 * Minimal structural view of Node's `AsyncLocalStorage`, so we can use it
 * without a static `import ... from "node:async_hooks"` (which would break
 * browser bundles). It is only ever reached through a runtime-guarded IIFE.
 */
interface AsyncLocalStorageLike {
  getStore(): LockEntry | undefined;
  run<R>(store: LockEntry, callback: () => R): R;
}

interface AsyncHooksModule {
  AsyncLocalStorage: new () => AsyncLocalStorageLike;
}

/**
 * Reentrancy detection is runtime-dependent:
 * - Node.js (>= 22.3) exposes `process.getBuiltinModule`, so `node:async_hooks`
 *   can be loaded without a static import and without CJS `require`.
 * - Browser / other runtimes have no async-hooks equivalent, so detection is
 *   disabled and calls simply queue (a plain per-key mutex).
 */
interface ReentrancyGuard {
  getStore(): LockEntry | undefined;
  run<T>(store: LockEntry, fn: () => Promise<T>): Promise<T>;
}

function createReentrancyGuard(): ReentrancyGuard {
  const processLike = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => AsyncHooksModule };
    }
  ).process;

  if (processLike?.getBuiltinModule) {
    try {
      const { AsyncLocalStorage } =
        processLike.getBuiltinModule("node:async_hooks");
      const als = new AsyncLocalStorage();
      return {
        getStore: () => als.getStore(),
        run: (store, fn) => als.run(store, () => fn()),
      };
    } catch {
      /* fall through to the no-op guard */
    }
  }

  return {
    getStore: () => undefined,
    run: (_store, fn) => fn(),
  };
}

const guard = createReentrancyGuard();

/**
 * Per-key FIFO queue: each key maps to its lock entry, whose `tail` promise
 * only settles once the next call for that key may proceed. The entry doubles
 * as the reentrancy identity of the acquisition currently executing the key.
 * Entries are removed once the queue drains, so the table does not grow
 * without bound.
 */
const locks = new Map<LockerId, LockEntry>();

export type AsyncLockAndRun<T> = {
  lockerId: string | number | symbol;
  body: () => Promise<T>;
};

/**
 * Runs `body` under a per-`lockerId` mutual exclusion lock.
 *
 * - Calls for the same `lockerId` run one at a time, in FIFO (arrival)
 *   order; calls for different `lockerId`s run fully in parallel.
 * - Every call executes its own `body` and receives its own result.
 * - A rejected `body` only rejects its own call — queued siblings still run —
 *   and the lock is always released, even on rejection.
 * - Keys are compared by identity: `1` and `"1"` are *different* locks, and
 *   symbols are unique.
 * - Re-entering the same `lockerId` from inside its own `body` would deadlock;
 *   on Node.js this is detected and rejected instead (no detection on runtimes
 *   without `async_hooks`). Detection is scoped to the specific acquisition
 *   that currently holds the lock: async work *detached* from `body`
 *   (fire-and-forget timers, un-awaited tasks) that later calls the same key
 *   after the lock has been released is allowed and simply queues/runs
 *   normally.
 *
 * @throws {Error} On Node.js, when the same acquisition re-enters its own
 *   `lockerId` while it still holds the lock.
 */
export async function asyncLockAndRun<T = void>(
  arg: AsyncLockAndRun<T>,
): Promise<T> {
  const { lockerId, body } = arg;

  const current = guard.getStore();
  if (
    current !== undefined &&
    !current.unlocked &&
    current.lockerId === lockerId
  ) {
    throw new Error(
      `[async-lock-and-run] reentrant call for lockerId ${String(lockerId)}: ` +
        "calling asyncLockAndRun with the same lockerId inside its own body would deadlock. " +
        "Use a distinct lockerId for nested work.",
    );
  }

  const previous = locks.get(lockerId)?.tail ?? Promise.resolve();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry: LockEntry = {
    lockerId,
    tail: previous.then(() => gate),
    unlocked: false,
  };
  locks.set(lockerId, entry);

  await previous;

  try {
    return await guard.run(entry, () => body());
  } finally {
    entry.unlocked = true;
    release();
    if (locks.get(lockerId) === entry) {
      locks.delete(lockerId);
    }
  }
}
