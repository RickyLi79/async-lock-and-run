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
});
