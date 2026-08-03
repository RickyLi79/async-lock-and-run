import { assert, describe, it } from "vitest";
import { asyncLockAndRun } from "./index";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("asyncLockAndRun", () => {
  it("serializes calls with the same lockerId (per-key mutex)", async () => {
    const order: string[] = [];
    const first = asyncLockAndRun({
      lockerId: "key",
      body: async () => {
        order.push("first:start");
        await sleep(30);
        order.push("first:end");
        return 1;
      },
    });
    const second = asyncLockAndRun({
      lockerId: "key",
      body: async () => {
        order.push("second:start");
        await sleep(5);
        order.push("second:end");
        return 2;
      },
    });

    const results = await Promise.all([first, second]);
    assert.deepEqual(results, [1, 2]);
    assert.deepEqual(order, [
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("runs calls for different lockerIds concurrently", async () => {
    let running = 0;
    let maxRunning = 0;
    const body = async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(30);
      running -= 1;
    };

    await Promise.all([
      asyncLockAndRun({ lockerId: "a", body }),
      asyncLockAndRun({ lockerId: "b", body }),
      asyncLockAndRun({ lockerId: "c", body }),
    ]);

    assert.strictEqual(maxRunning, 3);
  });

  it("runs same-key calls in FIFO order with independent results", async () => {
    const started: number[] = [];
    const calls = [0, 1, 2].map((i) =>
      asyncLockAndRun({
        lockerId: "fifo",
        body: async () => {
          started.push(i);
          await sleep(10);
          return i * 10;
        },
      }),
    );

    const results = await Promise.all(calls);
    assert.deepEqual(started, [0, 1, 2]);
    assert.deepEqual(results, [0, 10, 20]);
  });

  it("isolates errors: a rejected body does not affect queued siblings", async () => {
    const order: string[] = [];
    const failing = asyncLockAndRun({
      lockerId: "err",
      body: async () => {
        order.push("fail:start");
        await sleep(5);
        order.push("fail:end");
        throw new Error("boom");
      },
    });
    const succeeding = asyncLockAndRun({
      lockerId: "err",
      body: async () => {
        order.push("ok:start");
        await sleep(5);
        order.push("ok:end");
        return "ok";
      },
    });

    let caught: unknown;
    try {
      await failing;
    } catch (error) {
      caught = error;
    }
    assert.isDefined(caught);
    assert.match(String((caught as Error).message), /boom/);

    assert.strictEqual(await succeeding, "ok");
    assert.deepEqual(order, ["fail:start", "fail:end", "ok:start", "ok:end"]);
  });

  it("releases the lock after a rejected body", async () => {
    let caught: unknown;
    try {
      await asyncLockAndRun({
        lockerId: "release",
        body: async () => {
          throw new Error("nope");
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.isDefined(caught);

    // A later same-key call must still acquire the lock.
    const result = await asyncLockAndRun({
      lockerId: "release",
      body: async () => "acquired",
    });
    assert.strictEqual(result, "acquired");
  });

  it('treats numeric 1 and string "1" as different locks', async () => {
    let running = 0;
    let maxRunning = 0;
    const body = async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(30);
      running -= 1;
    };

    await Promise.all([
      asyncLockAndRun({ lockerId: 1, body }),
      asyncLockAndRun({ lockerId: "1", body }),
    ]);

    assert.strictEqual(maxRunning, 2);
  });

  it("rejects a reentrant call with the same lockerId (Node path)", async () => {
    let caught: unknown;
    try {
      await asyncLockAndRun({
        lockerId: "reentrant",
        body: () =>
          asyncLockAndRun({
            lockerId: "reentrant",
            body: async () => "inner",
          }),
      });
    } catch (error) {
      caught = error;
    }
    assert.isDefined(caught);
    assert.match(String((caught as Error).message), /reentrant/i);
  });

  it("allows nested calls with a different lockerId", async () => {
    const result = await asyncLockAndRun({
      lockerId: "outer",
      body: () =>
        asyncLockAndRun({
          lockerId: "inner",
          body: async () => "deep",
        }),
    });
    assert.strictEqual(result, "deep");
  });

  it("keeps working across many sequential same-key calls (queue drains cleanly)", async () => {
    const order: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const value = await asyncLockAndRun({
        lockerId: "sequential",
        body: async () => {
          order.push(i);
          await sleep(1);
          return i;
        },
      });
      assert.strictEqual(value, i);
    }
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  it("treats the same symbol as one lock and distinct symbols as different locks", async () => {
    const s1 = Symbol("s1");
    const s2 = Symbol("s2");

    // Same symbol → serialized.
    const order: string[] = [];
    const first = asyncLockAndRun({
      lockerId: s1,
      body: async () => {
        order.push("first:start");
        await sleep(20);
        order.push("first:end");
      },
    });
    const second = asyncLockAndRun({
      lockerId: s1,
      body: async () => {
        order.push("second:start");
        await sleep(5);
        order.push("second:end");
      },
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, [
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);

    // Distinct symbols → concurrent.
    let running = 0;
    let maxRunning = 0;
    const body = async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(20);
      running -= 1;
    };
    await Promise.all([
      asyncLockAndRun({ lockerId: s1, body }),
      asyncLockAndRun({ lockerId: s2, body }),
    ]);
    assert.strictEqual(maxRunning, 2);
  });

  it("releases the lock and propagates when body throws synchronously", async () => {
    let caught: unknown;
    try {
      await asyncLockAndRun({
        lockerId: "sync-throw",
        body: () => {
          throw new Error("sync boom");
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.isDefined(caught);
    assert.match(String((caught as Error).message), /sync boom/);

    // Lock must be released even for a synchronous throw.
    const result = await asyncLockAndRun({
      lockerId: "sync-throw",
      body: async () => "recovered",
    });
    assert.strictEqual(result, "recovered");
  });

  it("rejects a reentrant call that happens after an await (context propagates)", async () => {
    let caught: unknown;
    try {
      await asyncLockAndRun({
        lockerId: "async-reentrant",
        body: async () => {
          await sleep(1);
          await asyncLockAndRun({
            lockerId: "async-reentrant",
            body: async () => "inner",
          });
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.isDefined(caught);
    assert.match(String((caught as Error).message), /reentrant/i);
  });

  it("propagates the exact error instance to the caller", async () => {
    const expected = new Error("identical");
    let caught: unknown;
    try {
      await asyncLockAndRun({
        lockerId: "err-ref",
        body: async () => {
          throw expected;
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.strictEqual(caught, expected);
  });

  it("returns the exact object reference produced by body", async () => {
    const expected = { n: 1 };
    const result = await asyncLockAndRun({
      lockerId: "ref",
      body: async () => expected,
    });
    assert.strictEqual(result, expected);
  });

  it("keeps advancing the queue through multiple consecutive failures", async () => {
    const order: string[] = [];
    const failures = [0, 1].map(() =>
      asyncLockAndRun({
        lockerId: "multi-fail",
        body: async () => {
          order.push("fail");
          throw new Error("x");
        },
      }),
    );
    const success = asyncLockAndRun({
      lockerId: "multi-fail",
      body: async () => {
        order.push("ok");
        return "done";
      },
    });

    for (const failing of failures) {
      let caught: unknown;
      try {
        await failing;
      } catch (error) {
        caught = error;
      }
      assert.isDefined(caught);
    }
    assert.strictEqual(await success, "done");
    assert.deepEqual(order, ["fail", "fail", "ok"]);
  });

  it("handles a large burst of same-key calls without lost wakeups or skipped bodies", async () => {
    const count = 50;
    let ran = 0;
    const calls = Array.from({ length: count }, (_, i) =>
      asyncLockAndRun({
        lockerId: "burst",
        body: async () => {
          ran += 1;
          await sleep(1);
          return i;
        },
      }),
    );
    const results = await Promise.all(calls);
    assert.strictEqual(ran, count);
    assert.deepEqual(
      results,
      Array.from({ length: count }, (_, i) => i),
    );
  });

  it("infers the generic return type and supports void bodies by default", async () => {
    const value = await asyncLockAndRun({
      lockerId: "type",
      body: async () => 42,
    });
    const typed: number = value; // compile-time inference check
    assert.strictEqual(typed, 42);

    const voidResult = await asyncLockAndRun({
      lockerId: "void",
      body: async () => {},
    });
    assert.isUndefined(voidResult);
  });

  it("allows a detached (fire-and-forget) same-key call spawned by body after the lock is released", async () => {
    const lockerId = "detached";
    let innerBodyRan = false;
    let innerRejected: unknown;
    await asyncLockAndRun({
      lockerId,
      body: async () => {
        setTimeout(() => {
          asyncLockAndRun({
            lockerId,
            body: async () => {
              innerBodyRan = true;
            },
          }).catch((error) => {
            innerRejected = error;
          });
        }, 0);
      },
    });

    await sleep(20);
    assert.strictEqual(innerBodyRan, true);
    assert.isUndefined(innerRejected);
  });
});
