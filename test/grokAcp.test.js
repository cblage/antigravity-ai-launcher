"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  DEFAULT_ARGS,
  GrokAcpClient,
  MAX_STDOUT_BUFFER_BYTES
} = require("../src/quota/grokAcp");

function createChild(onFrame) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.killCalls = 0;
  child.endCalls = 0;
  child.frames = [];
  child.stdin = {
    writable: true,
    write(data, callback) {
      const frame = JSON.parse(String(data).trim());
      child.frames.push(frame);
      onFrame?.(frame, child, callback);
      if (!onFrame) {
        callback?.();
      }
      return true;
    },
    end() {
      child.endCalls += 1;
      child.stdin.writable = false;
    }
  };
  child.kill = () => {
    if (!child.killed) {
      child.killCalls += 1;
      child.killed = true;
    }
    return true;
  };
  return child;
}

function reply(child, frame, result) {
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: frame.id,
    result
  })}\n`);
}

test("reads Grok billing over a short-lived ACP process", async () => {
  const calls = [];
  const child = createChild((frame, process, callback) => {
    callback?.();
    if (frame.method === "initialize") {
      process.stdout.write("not-json\n");
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { ignored: true }
      })}\n`);
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 999,
        result: { ignored: true }
      })}\n`);
      const response = `${JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: { protocolVersion: 1 }
      })}\n`;
      process.stdout.write(response.slice(0, 11));
      process.stdout.write(response.slice(11));
      return;
    }
    reply(process, frame, {
      config: {
        creditUsagePercent: 12,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" }
      }
    });
  });
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };

  const client = new GrokAcpClient("/test/grok", {
    spawnImpl,
    cwd: "/test/home",
    env: { TEST: "yes" }
  });
  const result = await client.readBilling(1000);

  assert.equal(result.config.creditUsagePercent, 12);
  assert.deepEqual(calls, [{
    command: "/test/grok",
    args: [...DEFAULT_ARGS],
    options: {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/test/home",
      env: { TEST: "yes" }
    }
  }]);
  assert.deepEqual(child.frames.map((frame) => frame.method), [
    "initialize",
    "_x.ai/billing"
  ]);
  assert.ok(child.frames.every((frame) => frame.jsonrpc === "2.0"));
  assert.deepEqual(child.frames[0].params, {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false
    }
  });
  assert.deepEqual(child.frames[1].params, {});
  assert.equal(child.killCalls, 1);
  assert.equal(child.endCalls, 1);
});

test("surfaces ACP RPC errors and cleans up", async () => {
  const child = createChild((frame, process, callback) => {
    callback?.();
    if (frame.method === "initialize") {
      reply(process, frame, { protocolVersion: 1 });
      return;
    }
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: -32601, message: "Method not found" }
    })}\n`);
  });
  const client = new GrokAcpClient("grok", { spawnImpl: () => child });

  await assert.rejects(
    client.readBilling(1000),
    /'_x\.ai\/billing' failed \(-32601\): Method not found/
  );
  assert.equal(child.killCalls, 1);
});

test("times out unanswered requests and cleans up", async () => {
  const child = createChild((_frame, _process, callback) => callback?.());
  const client = new GrokAcpClient("grok", { spawnImpl: () => child });

  await assert.rejects(client.readBilling(10), /'initialize' timed out/);
  assert.equal(child.killCalls, 1);
  assert.equal(child.endCalls, 1);
});

test("rejects an unbounded stdout line and cleans up", async () => {
  const child = createChild((_frame, process, callback) => {
    callback?.();
    process.stdout.write(Buffer.alloc(MAX_STDOUT_BUFFER_BYTES + 1, "x"));
  });
  const client = new GrokAcpClient("grok", { spawnImpl: () => child });

  await assert.rejects(client.readBilling(1000), /1 MiB line limit/);
  assert.equal(child.killCalls, 1);
});

test("surfaces asynchronous spawn errors", async () => {
  const child = createChild((_frame, _process, callback) => callback?.());
  const client = new GrokAcpClient("grok", {
    spawnImpl: () => {
      process.nextTick(() => child.emit("error", new Error("ENOENT")));
      return child;
    }
  });

  await assert.rejects(client.readBilling(1000), /process error: ENOENT/);
  assert.equal(child.killCalls, 1);
});

test("surfaces process exits with bounded stderr diagnostics", async () => {
  const child = createChild((_frame, _process, callback) => callback?.());
  const client = new GrokAcpClient("grok", {
    spawnImpl: () => {
      process.nextTick(() => {
        child.stderr.write("authentication failed\n");
        child.exitCode = 7;
        child.emit("exit", 7, null);
      });
      return child;
    }
  });

  await assert.rejects(
    client.readBilling(1000),
    /exited \(code 7\): authentication failed/
  );
  assert.equal(child.killCalls, 0);
});

test("surfaces synchronous spawn failures", async () => {
  const client = new GrokAcpClient("grok", {
    spawnImpl: () => {
      throw new Error("spawn exploded");
    }
  });

  await assert.rejects(client.readBilling(), /Failed to start Grok ACP: spawn exploded/);
});

test("surfaces asynchronous stdin write failures", async () => {
  const child = createChild((_frame, _process, callback) => {
    callback?.(new Error("broken pipe"));
  });
  const client = new GrokAcpClient("grok", { spawnImpl: () => child });

  await assert.rejects(
    client.readBilling(1000),
    /Failed to write Grok ACP request 'initialize': broken pipe/
  );
  assert.equal(child.killCalls, 1);
});

test("surfaces synchronous stdin write failures", async () => {
  const child = createChild();
  child.stdin.write = () => {
    throw new Error("write exploded");
  };
  const client = new GrokAcpClient("grok", { spawnImpl: () => child });

  await assert.rejects(
    client.readBilling(1000),
    /Failed to write Grok ACP request 'initialize': write exploded/
  );
  assert.equal(child.killCalls, 1);
});

test("dispose is idempotent and rejects pending work", async () => {
  const child = createChild((_frame, _process, callback) => callback?.());
  const client = new GrokAcpClient("grok", { spawnImpl: () => child });
  const pending = client.readBilling(1000);

  await new Promise((resolve) => setImmediate(resolve));
  client.dispose();
  client.dispose();

  await assert.rejects(pending, /disposed/);
  assert.equal(child.killCalls, 1);
  assert.equal(child.endCalls, 1);
});
