type LockerId = string | number | symbol;

/**
 * Minimal structural view of Node's `AsyncLocalStorage`, so we can use it
 * without a static `import ... from "node:async_hooks"` (which would break
 * browser bundles). It is only ever reached through a runtime-guarded IIFE.
 */
interface AsyncLocalStorageLike {
  getStore(): LockerId | undefined;
  run<R>(store: LockerId, callback: () => R): R;
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
  isReentrant(lockerId: LockerId): boolean;
  run<T>(lockerId: LockerId, fn: () => Promise<T>): Promise<T>;
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
        isReentrant: (lockerId) => als.getStore() === lockerId,
        run: (lockerId, fn) => als.run(lockerId, () => fn()),
      };
    } catch {
      /* fall through to the no-op guard */
    }
  }

  return {
    isReentrant: () => false,
    run: (_lockerId, fn) => fn(),
  };
}

const guard = createReentrancyGuard();

/**
 * Per-key FIFO queue built from a chain of "tail" promises.
 * `tails.get(lockerId)` only settles once the next call for that key may
 * proceed. Entries are removed once the queue drains, so the table does
 * not grow without bound.
 */
const tails = new Map<LockerId, Promise<void>>();

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
 *   without `async_hooks`).
 *
 * @throws {Error} On Node.js, when `body` re-enters the same `lockerId` while
 *   it is still held.
 */
export async function asyncLockAndRun<T = void>(
  arg: AsyncLockAndRun<T>,
): Promise<T> {
  const { lockerId, body } = arg;

  if (guard.isReentrant(lockerId)) {
    throw new Error(
      `[async-lock-and-run] reentrant call for lockerId ${String(lockerId)}: ` +
        "calling asyncLockAndRun with the same lockerId inside its own body would deadlock. " +
        "Use a distinct lockerId for nested work.",
    );
  }

  const previous = tails.get(lockerId) ?? Promise.resolve();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const myTurn = previous.then(() => gate);
  tails.set(lockerId, myTurn);

  await previous;

  try {
    return await guard.run(lockerId, () => body());
  } finally {
    release();
    if (tails.get(lockerId) === myTurn) {
      tails.delete(lockerId);
    }
  }
}
