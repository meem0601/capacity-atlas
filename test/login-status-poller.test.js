import test from "node:test";
import assert from "node:assert/strict";
import { createAsyncTerminalPoller } from "../public/login-status-poller.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("overlapping status polls read and handle a terminal result only once", async () => {
  const pending = deferred();
  let reads = 0;
  let handled = 0;
  const poll = createAsyncTerminalPoller({
    read: async () => {
      reads += 1;
      return pending.promise;
    },
    handle: async status => {
      handled += 1;
      return status === "completed";
    }
  });

  const first = poll();
  const overlapping = poll();
  assert.equal(reads, 1);
  assert.equal(await overlapping, false);

  pending.resolve("completed");
  assert.equal(await first, true);
  assert.equal(await poll(), true);
  assert.equal(reads, 1);
  assert.equal(handled, 1);
});
