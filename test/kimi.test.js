"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  KIMI_USAGE_COMMAND,
  KimiQuotaReader
} = require("../src/quota/kimi");

function usagePayload(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "ok",
    observedAt: "2026-07-27T10:00:00Z",
    summary: {
      label: "Weekly limit",
      used: 400,
      limit: 1000,
      durationMinutes: 10080,
      resetAt: "2026-08-01T10:00:00Z"
    },
    limits: [
      {
        label: "5h limit",
        used: 25,
        limit: 100,
        durationMinutes: 300,
        resetAt: "2026-07-27T14:00:00Z"
      }
    ],
    extraUsage: null,
    ...overrides
  };
}

function createReader(options = {}) {
  return new KimiQuotaReader({
    getExtension: () => ({}),
    getCommands: async () => [KIMI_USAGE_COMMAND],
    executeCommand: async () => usagePayload(),
    ...options
  });
}

test("reads Kimi through the hidden command and caches automatic refreshes", async () => {
  let now = Date.parse("2026-07-27T10:00:00Z");
  let calls = 0;
  const reader = createReader({
    now: () => now,
    executeCommand: async (command) => {
      assert.equal(command, KIMI_USAGE_COMMAND);
      calls += 1;
      return usagePayload();
    }
  });

  const first = await reader.read();
  assert.equal(first.fiveHour.usedPercent, 25);
  assert.equal(first.sevenDay.usedPercent, 40);
  assert.equal(calls, 1);

  now += 60_000;
  assert.equal(await reader.read(), first);
  assert.equal(calls, 1);

  await reader.read({ force: true });
  assert.equal(calls, 2);
});

test("reports a missing or outdated Kimi extension clearly", async () => {
  await assert.rejects(
    createReader({ getExtension: () => undefined }).read(),
    /Kimi Code is not installed/
  );
  await assert.rejects(
    createReader({ getCommands: async () => [] }).read(),
    /Update Kimi Code to the matching launcher-compatible build/
  );
});

test("rejects incompatible bridge schemas and provider errors", async () => {
  await assert.rejects(
    createReader({
      executeCommand: async () => ({ schemaVersion: 2, kind: "ok" })
    }).read(),
    /Update Kimi Code and Antigravity AI Launcher together/
  );
  await assert.rejects(
    createReader({
      executeCommand: async () => ({
        schemaVersion: 1,
        kind: "error",
        status: 401,
        message: "Authorization failed."
      })
    }).read(),
    /sign in to Kimi Code/
  );
  await assert.rejects(
    createReader({
      executeCommand: async () => ({
        schemaVersion: 1,
        kind: "error",
        status: 404,
        message: "Not found."
      })
    }).read(),
    /managed usage is unavailable/
  );
});

test("times out a stalled cross-host command", async () => {
  const reader = createReader({
    timeoutMs: 10,
    executeCommand: async () => new Promise(() => {})
  });
  await assert.rejects(reader.read(), /request timed out/);
});
