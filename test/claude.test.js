"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ClaudeQuotaReader,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MEMORY_TTL_MS,
  SHARED_CACHE_MAX_AGE_MS,
  parseRetryAfterMs
} = require("../src/quota/claude");

const usagePayload = {
  five_hour: {
    utilization: 42,
    resets_at: "2026-07-10T22:00:00Z"
  },
  seven_day: {
    utilization: 58,
    resets_at: "2026-07-14T20:00:00Z"
  }
};

function lastGoodSnapshot(source = "test last good") {
  return {
    provider: "claude",
    source,
    observedAt: new Date("2026-07-10T20:00:00Z"),
    fiveHour: {
      usedPercent: 12,
      remainingPercent: 88,
      resetAt: new Date("2026-07-10T22:00:00Z"),
      disabled: false
    },
    sevenDay: {
      usedPercent: 18,
      remainingPercent: 82,
      resetAt: new Date("2026-07-14T20:00:00Z"),
      disabled: false
    }
  };
}

test("uses five-minute Claude memory and shared-cache windows", () => {
  assert.equal(MEMORY_TTL_MS, 5 * 60 * 1000);
  assert.equal(SHARED_CACHE_MAX_AGE_MS, 5 * 60 * 1000);
});

test("parses numeric and HTTP-date Retry-After values", () => {
  const now = Date.UTC(2026, 6, 10, 20, 0, 0);
  assert.equal(parseRetryAfterMs("120", now), 120000);
  assert.equal(
    parseRetryAfterMs(new Date(now + 5 * 60 * 1000).toUTCString(), now),
    5 * 60 * 1000
  );
  assert.equal(parseRetryAfterMs("not-a-date", now), undefined);
  assert.equal(parseRetryAfterMs(undefined, now), undefined);
});

test("limits live Claude endpoint reads to once per five minutes", async () => {
  let now = Date.UTC(2026, 6, 10, 20, 0, 0);
  let fetchCalls = 0;
  const reader = new ClaudeQuotaReader({
    now: () => now,
    readSharedCache: () => undefined,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => {
      fetchCalls += 1;
      return { statusCode: 200, headers: {}, payload: usagePayload };
    }
  });

  await reader.read();
  now += MEMORY_TTL_MS - 1;
  await reader.read();
  assert.equal(fetchCalls, 1);

  now += 2;
  await reader.read();
  assert.equal(fetchCalls, 2);
});

test("restores a successful quota snapshot across extension-host reloads", async () => {
  const now = Date.UTC(2026, 6, 10, 20, 0, 0);
  let persisted;
  const first = new ClaudeQuotaReader({
    now: () => now,
    readSharedCache: () => undefined,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => ({
      statusCode: 200,
      headers: {},
      payload: usagePayload
    }),
    persistState: async (state) => {
      persisted = JSON.parse(JSON.stringify(state));
    }
  });

  await first.read();
  let restartedFetchCalls = 0;
  const restarted = new ClaudeQuotaReader({
    now: () => now + 1000,
    persistedState: persisted,
    readSharedCache: () => undefined,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => {
      restartedFetchCalls += 1;
      return { statusCode: 200, headers: {}, payload: usagePayload };
    }
  });

  const restored = await restarted.read();
  assert.equal(restored.fiveHour.usedPercent, 42);
  assert.ok(restored.observedAt instanceof Date);
  assert.ok(restored.fiveHour.resetAt instanceof Date);
  assert.equal(restartedFetchCalls, 0);
});

test("persists an in-progress automatic attempt before network work begins", async () => {
  const now = Date.UTC(2026, 6, 10, 20, 0, 0);
  const persistedStates = [];
  const reader = new ClaudeQuotaReader({
    now: () => now,
    readSharedCache: () => undefined,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => ({
      statusCode: 200,
      headers: {},
      payload: usagePayload
    }),
    persistState: async (state) => {
      persistedStates.push(JSON.parse(JSON.stringify(state)));
    }
  });

  await reader.read();
  assert.equal(persistedStates[0].lastAttemptAt, now);
  assert.equal(persistedStates[0].lastGood, undefined);
});

test("an interrupted persisted attempt cannot immediately retry after reload", async () => {
  const now = Date.UTC(2026, 6, 10, 20, 0, 0);
  let fetchCalls = 0;
  const reader = new ClaudeQuotaReader({
    now: () => now + 1000,
    persistedState: { lastAttemptAt: now },
    readSharedCache: () => undefined,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => {
      fetchCalls += 1;
      return { statusCode: 200, headers: {}, payload: usagePayload };
    }
  });

  await assert.rejects(reader.read(), /waiting before retrying/);
  assert.equal(fetchCalls, 0);
});

test("revives snapshots whose reset timestamps are unavailable", async () => {
  const now = Date.UTC(2026, 6, 10, 20, 0, 0);
  const snapshot = lastGoodSnapshot();
  snapshot.fiveHour.resetAt = undefined;
  snapshot.sevenDay.resetAt = null;
  const reader = new ClaudeQuotaReader({
    now: () => now,
    persistedState: {
      lastGood: JSON.parse(JSON.stringify(snapshot)),
      lastGoodAt: now
    },
    readSharedCache: () => undefined,
    fetchUsage: async () => {
      throw new Error("must not fetch");
    }
  });

  const restored = await reader.read();
  assert.equal(restored.fiveHour.resetAt, undefined);
  assert.equal(restored.sevenDay.resetAt, undefined);
});

test("persists Claude rate-limit backoff across extension-host reloads", async () => {
  const now = Date.UTC(2026, 6, 10, 20, 0, 0);
  let persisted;
  const first = new ClaudeQuotaReader({
    now: () => now,
    readSharedCache: () => undefined,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => ({ statusCode: 429, headers: {}, payload: {} }),
    persistState: async (state) => {
      persisted = JSON.parse(JSON.stringify(state));
    }
  });
  await assert.rejects(first.read(), /rate-limited/);

  let restartedFetchCalls = 0;
  const restarted = new ClaudeQuotaReader({
    now: () => now + 1000,
    persistedState: persisted,
    readSharedCache: () => undefined,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => {
      restartedFetchCalls += 1;
      return { statusCode: 200, headers: {}, payload: usagePayload };
    }
  });

  await assert.rejects(restarted.read({ force: true }), /rate-limited/);
  assert.equal(restartedFetchCalls, 0);
});

test("caches a failed automatic attempt across extension-host reloads", async () => {
  let now = Date.UTC(2026, 6, 10, 20, 0, 0);
  let persisted;
  const first = new ClaudeQuotaReader({
    now: () => now,
    readSharedCache: () => undefined,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => ({ statusCode: 503, headers: {}, payload: {} }),
    persistState: async (state) => {
      persisted = JSON.parse(JSON.stringify(state));
    }
  });
  await assert.rejects(first.read(), /HTTP 503/);

  let restartedFetchCalls = 0;
  const restarted = new ClaudeQuotaReader({
    now: () => now + 1000,
    persistedState: persisted,
    readSharedCache: () => undefined,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => {
      restartedFetchCalls += 1;
      return { statusCode: 200, headers: {}, payload: usagePayload };
    }
  });
  await assert.rejects(restarted.read(), /HTTP 503/);
  assert.equal(restartedFetchCalls, 0);

  now += MEMORY_TTL_MS + 1;
  await restarted.read();
  assert.equal(restartedFetchCalls, 1);
});

test("honors Retry-After and grows repeated default backoff to one hour", async () => {
  let now = Date.UTC(2026, 6, 10, 20, 0, 0);
  let shared;
  let fetchCalls = 0;
  const responses = [
    { statusCode: 429, headers: {}, payload: {} },
    { statusCode: 429, headers: {}, payload: {} },
    { statusCode: 429, headers: {}, payload: {} },
    { statusCode: 200, headers: {}, payload: usagePayload }
  ];
  const reader = new ClaudeQuotaReader({
    now: () => now,
    readSharedCache: () => shared,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => {
      const response = responses[fetchCalls];
      fetchCalls += 1;
      return response;
    }
  });
  reader.lastGood = lastGoodSnapshot();
  reader.lastGoodAt = now - MEMORY_TTL_MS - 1;

  const first = await reader.read({ force: true });
  assert.equal(first.stale, true);
  assert.equal(reader.backoffUntil - now, DEFAULT_BACKOFF_MS);
  assert.equal(reader.nextBackoffMs, 2 * DEFAULT_BACKOFF_MS);
  assert.equal(fetchCalls, 1);

  now += 60 * 1000;
  await reader.read({ force: true });
  assert.equal(fetchCalls, 1, "forced refresh must respect active backoff");

  const firstBackoffUntil = reader.backoffUntil;
  shared = lastGoodSnapshot("fresh Claude shared cache");
  const fromSharedCache = await reader.read();
  assert.equal(fromSharedCache.source, "fresh Claude shared cache");
  assert.equal(reader.backoffUntil, firstBackoffUntil);

  shared = undefined;
  await reader.read({ force: true });
  assert.equal(fetchCalls, 1, "shared cache must not clear endpoint backoff");

  now = firstBackoffUntil + 1;
  await reader.read({ force: true });
  assert.equal(reader.backoffUntil - now, 2 * DEFAULT_BACKOFF_MS);
  assert.equal(reader.nextBackoffMs, MAX_BACKOFF_MS);
  assert.equal(fetchCalls, 2);

  now = reader.backoffUntil + 1;
  await reader.read({ force: true });
  assert.equal(reader.backoffUntil - now, MAX_BACKOFF_MS);
  assert.equal(reader.nextBackoffMs, MAX_BACKOFF_MS);
  assert.equal(fetchCalls, 3);

  now = reader.backoffUntil + 1;
  const recovered = await reader.read({ force: true });
  assert.equal(recovered.fiveHour.usedPercent, 42);
  assert.equal(reader.backoffUntil, 0);
  assert.equal(reader.nextBackoffMs, DEFAULT_BACKOFF_MS);
  assert.equal(fetchCalls, 4);
});

test("uses a server Retry-After value for the current 429", async () => {
  const now = Date.UTC(2026, 6, 10, 20, 0, 0);
  const reader = new ClaudeQuotaReader({
    now: () => now,
    readSharedCache: () => undefined,
    tokenProvider: async () => "test-token",
    fetchUsage: async () => ({
      statusCode: 429,
      headers: { "retry-after": "120" },
      payload: {}
    })
  });

  await assert.rejects(
    reader.read({ force: true }),
    /rate-limited/
  );
  assert.equal(reader.backoffUntil - now, 120000);
  assert.equal(reader.nextBackoffMs, DEFAULT_BACKOFF_MS);
});
