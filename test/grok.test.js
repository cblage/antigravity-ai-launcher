"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BACKOFF_MS,
  FAILURE_RETRY_MS,
  GrokQuotaReader,
  MEMORY_TTL_MS,
  defaultGrokCommand
} = require("../src/quota/grok");

function billingPayload(usedPercent = 12) {
  return {
    config: {
      creditUsagePercent: usedPercent,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-12T00:00:00Z",
        end: "2026-07-19T00:00:00Z"
      }
    },
    subscription_tier: "SuperGrok"
  };
}

function clientFactory(handler, calls) {
  return (command) => {
    const client = {
      disposed: 0,
      async readBilling(timeoutMs) {
        calls.push({ command, timeoutMs, client });
        return handler();
      },
      dispose() {
        this.disposed += 1;
      }
    };
    return client;
  };
}

test("uses five-minute Grok success and failure guards", () => {
  assert.equal(MEMORY_TTL_MS, 5 * 60 * 1000);
  assert.equal(FAILURE_RETRY_MS, 5 * 60 * 1000);
  assert.equal(DEFAULT_BACKOFF_MS, 15 * 60 * 1000);
});

test("discovers configured, user-local, then PATH Grok commands", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-command-"));
  try {
    assert.equal(
      defaultGrokCommand("~/custom/grok", { homeDirectory: home }),
      path.join(home, "custom", "grok")
    );
    assert.equal(defaultGrokCommand("/missing/configured", {
      homeDirectory: home
    }), "/missing/configured");
    assert.equal(defaultGrokCommand(undefined, { homeDirectory: home }), "grok");

    const userBinary = path.join(home, ".grok", "bin", "grok");
    fs.mkdirSync(path.dirname(userBinary), { recursive: true });
    fs.writeFileSync(userBinary, "#!/bin/sh\n");
    fs.chmodSync(userBinary, 0o755);
    assert.equal(defaultGrokCommand(undefined, { homeDirectory: home }), userBinary);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("caches automatic Grok reads and force refresh bypasses freshness", async () => {
  let now = Date.parse("2026-07-15T00:00:00Z");
  let responses = 0;
  const calls = [];
  const reader = new GrokQuotaReader({
    now: () => now,
    getConfiguredCommand: () => "~/bin/grok-custom",
    homeDirectory: "/test-home",
    createClient: clientFactory(() => billingPayload(++responses), calls)
  });

  const first = await reader.read();
  now += MEMORY_TTL_MS - 1;
  const cached = await reader.read();
  const forced = await reader.read({ force: true });

  assert.equal(first.sevenDay.usedPercent, 1);
  assert.equal(cached.sevenDay.usedPercent, 1);
  assert.equal(forced.sevenDay.usedPercent, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "/test-home/bin/grok-custom");
  assert.equal(calls[0].client.disposed, 1);
  assert.equal(calls[1].client.disposed, 1);
});

test("persists and restores the last good Grok snapshot", async () => {
  const now = Date.parse("2026-07-15T00:00:00Z");
  let persisted;
  const first = new GrokQuotaReader({
    now: () => now,
    createClient: clientFactory(() => billingPayload(27), []),
    persistState: async (state) => {
      persisted = JSON.parse(JSON.stringify(state));
    }
  });
  await first.read();

  let clientCreations = 0;
  const restarted = new GrokQuotaReader({
    now: () => now + 1000,
    persistedState: persisted,
    createClient: () => {
      clientCreations += 1;
      throw new Error("must not spawn");
    }
  });
  const restored = await restarted.read();

  assert.equal(restored.sevenDay.usedPercent, 27);
  assert.ok(restored.observedAt instanceof Date);
  assert.ok(restored.sevenDay.resetAt instanceof Date);
  assert.equal(clientCreations, 0);
});

test("guards failed automatic reads but permits a manual retry", async () => {
  const now = Date.parse("2026-07-15T00:00:00Z");
  let attempts = 0;
  const reader = new GrokQuotaReader({
    now: () => now,
    createClient: clientFactory(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("not authenticated");
      }
      return billingPayload(4);
    }, [])
  });

  await assert.rejects(reader.read(), /Grok quota unavailable.*not authenticated/);
  await assert.rejects(reader.read(), /not authenticated/);
  assert.equal(attempts, 1);
  const recovered = await reader.read({ force: true });
  assert.equal(recovered.sevenDay.usedPercent, 4);
  assert.equal(attempts, 2);
});

test("returns a current last-good value as stale after an ordinary failure", async () => {
  let now = Date.parse("2026-07-15T00:00:00Z");
  let fail = false;
  const reader = new GrokQuotaReader({
    now: () => now,
    createClient: clientFactory(() => {
      if (fail) {
        throw new Error("temporary transport failure");
      }
      return billingPayload(19);
    }, [])
  });

  await reader.read();
  fail = true;
  now += MEMORY_TTL_MS + 1;
  const stale = await reader.read();
  assert.equal(stale.stale, true);
  assert.equal(stale.sevenDay.usedPercent, 19);
});

test("never reuses a last-good snapshot after its weekly reset", async () => {
  let now = Date.parse("2026-07-18T23:59:00Z");
  let fail = false;
  const reader = new GrokQuotaReader({
    now: () => now,
    createClient: clientFactory(() => {
      if (fail) {
        throw new Error("offline");
      }
      return billingPayload(81);
    }, [])
  });
  await reader.read();

  fail = true;
  now = Date.parse("2026-07-19T00:00:01Z");
  await assert.rejects(reader.read({ force: true }), /offline/);
});

test("rate-limit errors enforce backoff even for forced refreshes", async () => {
  let now = Date.parse("2026-07-15T00:00:00Z");
  let attempts = 0;
  const reader = new GrokQuotaReader({
    now: () => now,
    createClient: clientFactory(() => {
      attempts += 1;
      throw new Error("RPC 429: rate limit exceeded");
    }, [])
  });

  await assert.rejects(reader.read(), /429/);
  await assert.rejects(reader.read({ force: true }), /429/);
  assert.equal(attempts, 1);

  now += DEFAULT_BACKOFF_MS + 1;
  await assert.rejects(reader.read({ force: true }), /429/);
  assert.equal(attempts, 2);
});
