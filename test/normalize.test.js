"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeClaudeUsage,
  normalizeCodexRateLimits,
  normalizeCodexSessionEvent,
  normalizeGeminiQuotaResponse,
  normalizeGrokBilling,
  normalizeKimiManagedUsage
} = require("../src/quota/normalize");

test("normalizes Antigravity Gemini 5h and weekly buckets", () => {
  const snapshot = normalizeGeminiQuotaResponse({
    response: {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit",
              window: "weekly",
              remainingFraction: 0.72,
              resetTime: "2026-07-11T23:44:52Z"
            },
            {
              bucketId: "gemini-5h",
              displayName: "Five Hour Limit",
              window: "5h",
              remainingFraction: 0.9945,
              resetTime: "2026-07-10T12:47:39Z"
            }
          ]
        }
      ]
    }
  });

  assert.equal(snapshot.provider, "gemini");
  assert.equal(snapshot.fiveHour.usedPercent, 0.5499999999999972);
  assert.equal(snapshot.sevenDay.usedPercent, 28);
  assert.equal(snapshot.fiveHour.durationMinutes, 300);
  assert.equal(snapshot.sevenDay.durationMinutes, 10080);
  assert.equal(snapshot.fiveHour.resetAt.toISOString(), "2026-07-10T12:47:39.000Z");
});

test("normalizes Codex primary and secondary windows by duration", () => {
  const snapshot = normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        planType: "pro",
        primary: {
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: 1783684800
        },
        secondary: {
          usedPercent: 34,
          windowDurationMins: 10080,
          resetsAt: 1784246400
        }
      }
    }
  });

  assert.equal(snapshot.provider, "codex");
  assert.equal(snapshot.plan, "pro");
  assert.equal(snapshot.fiveHour.usedPercent, 12);
  assert.equal(snapshot.sevenDay.usedPercent, 34);
  assert.equal(snapshot.fiveHour.remainingPercent, 88);
  assert.equal(snapshot.sevenDay.durationMinutes, 10080);
});

test("normalizes only the main weekly Codex bucket when the 5h window is absent", () => {
  const snapshot = normalizeCodexRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: {
        usedPercent: 10,
        windowDurationMins: 10080,
        resetsAt: 1784487814
      },
      secondary: null,
      planType: "pro"
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        limitName: "GPT-5.3-Codex-Spark",
        primary: {
          usedPercent: 99,
          windowDurationMins: 10080,
          resetsAt: 1784518688
        },
        secondary: null
      },
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: 10,
          windowDurationMins: 10080,
          resetsAt: 1784487814
        },
        secondary: null,
        planType: "pro"
      }
    }
  });

  assert.equal(snapshot.provider, "codex");
  assert.equal(snapshot.plan, "pro");
  assert.equal(snapshot.weeklyOnly, true);
  assert.equal(snapshot.fiveHour, undefined);
  assert.equal(snapshot.sevenDay.usedPercent, 10);
  assert.equal(snapshot.sevenDay.remainingPercent, 90);
  assert.equal(snapshot.sevenDay.durationMinutes, 10080);
});

test("normalizes Codex session-log fallback events", () => {
  const snapshot = normalizeCodexSessionEvent({
    timestamp: "2026-07-10T10:00:00Z",
    payload: {
      rate_limits: {
        primary: { used_percent: 10, window_minutes: 300, resets_at: 1783684800 },
        secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1784246400 }
      }
    }
  });

  assert.equal(snapshot.source, "Codex session log");
  assert.equal(snapshot.fiveHour.usedPercent, 10);
  assert.equal(snapshot.sevenDay.usedPercent, 20);
});

test("accepts main weekly-only Codex session events and ignores model buckets", () => {
  const main = normalizeCodexSessionEvent({
    timestamp: "2026-07-13T03:43:02Z",
    payload: {
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 10, window_minutes: 10080, resets_at: 1784487814 },
        secondary: null,
        plan_type: "pro"
      }
    }
  });
  const modelSpecific = normalizeCodexSessionEvent({
    timestamp: "2026-07-13T03:43:03Z",
    payload: {
      rate_limits: {
        limit_id: "codex_bengalfox",
        primary: { used_percent: 0, window_minutes: 10080, resets_at: 1784518688 },
        secondary: null
      }
    }
  });

  assert.equal(main.weeklyOnly, true);
  assert.equal(main.sevenDay.usedPercent, 10);
  assert.equal(main.fiveHour, undefined);
  assert.equal(modelSpecific, undefined);
});

test("normalizes Claude utilization percentages", () => {
  const snapshot = normalizeClaudeUsage({
    five_hour: { utilization: 41.5, resets_at: "2026-07-10T13:00:00Z" },
    seven_day: { utilization: 63.25, resets_at: "2026-07-14T13:00:00Z" }
  });

  assert.equal(snapshot.provider, "claude");
  assert.equal(snapshot.fiveHour.usedPercent, 41.5);
  assert.equal(snapshot.fiveHour.remainingPercent, 58.5);
  assert.equal(snapshot.sevenDay.usedPercent, 63.25);
  assert.equal(snapshot.sevenDay.durationMinutes, 10080);
});

test("normalizes Grok's shared weekly billing period", () => {
  const snapshot = normalizeGrokBilling({
    config: {
      creditUsagePercent: 1,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-12T05:05:41.000673+00:00",
        end: "2026-07-19T05:05:41.000673+00:00"
      }
    },
    subscription_tier: "SuperGrok Heavy"
  }, new Date("2026-07-15T12:00:00Z"));

  assert.equal(snapshot.provider, "grok");
  assert.equal(snapshot.source, "Grok CLI billing");
  assert.equal(snapshot.plan, "SuperGrok Heavy");
  assert.equal(snapshot.weeklyOnly, true);
  assert.equal(snapshot.fiveHour, undefined);
  assert.equal(snapshot.sevenDay.usedPercent, 1);
  assert.equal(snapshot.sevenDay.remainingPercent, 99);
  assert.equal(snapshot.sevenDay.durationMinutes, 10080);
  assert.equal(
    snapshot.sevenDay.resetAt.toISOString(),
    "2026-07-19T05:05:41.000Z"
  );
});

test("treats Grok's omitted fresh-period usage as zero", () => {
  const snapshot = normalizeGrokBilling({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-12T05:05:41Z",
        end: "2026-07-19T05:05:41Z"
      }
    }
  });

  assert.equal(snapshot.sevenDay.usedPercent, 0);
  assert.equal(snapshot.sevenDay.remainingPercent, 100);
});

test("normalizes Kimi 5h, weekly, and Booster usage", () => {
  const snapshot = normalizeKimiManagedUsage({
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
    extraUsage: {
      balanceCents: 500,
      totalCents: 1000,
      monthlyChargeLimitEnabled: true,
      monthlyChargeLimitCents: 2000,
      monthlyUsedCents: 1500,
      currency: "USD"
    }
  });

  assert.equal(snapshot.provider, "kimi");
  assert.equal(snapshot.source, "Kimi Code extension");
  assert.equal(snapshot.fiveHour.usedPercent, 25);
  assert.equal(snapshot.sevenDay.usedPercent, 40);
  assert.equal(snapshot.fiveHour.resetAt.toISOString(), "2026-07-27T14:00:00.000Z");
  assert.equal(snapshot.sevenDay.durationMinutes, 10080);
  assert.deepEqual(snapshot.windows.map(({ id, tooltipLabel }) => ({ id, tooltipLabel })), [
    { id: "fiveHour", tooltipLabel: "5h" },
    { id: "sevenDay", tooltipLabel: "Weekly" }
  ]);
  assert.deepEqual(snapshot.extraUsage, {
    balanceCents: 500,
    totalCents: 1000,
    monthlyChargeLimitEnabled: true,
    monthlyChargeLimitCents: 2000,
    monthlyUsedCents: 1500,
    currency: "USD"
  });
});

test("accepts either Kimi window and does not parse reset hints", () => {
  const weekly = normalizeKimiManagedUsage({
    kind: "ok",
    observedAt: "2026-07-27T10:00:00Z",
    summary: {
      label: "Weekly limit",
      used: 10,
      limit: 100,
      durationMinutes: 10080,
      resetHint: "resets in 4d"
    },
    limits: [],
    extraUsage: null
  });
  assert.equal(weekly.weeklyOnly, true);
  assert.equal(weekly.fiveHour, undefined);
  assert.equal(weekly.sevenDay.resetAt, undefined);
  assert.equal(weekly.windows.length, 1);

  const fiveHour = normalizeKimiManagedUsage({
    kind: "ok",
    observedAt: "2026-07-27T10:00:00Z",
    summary: null,
    limits: [
      {
        label: "5h limit",
        used: 20,
        limit: 100,
        durationMinutes: 300
      }
    ],
    extraUsage: { currency: "USD" }
  });
  assert.equal(fiveHour.fiveHour.usedPercent, 20);
  assert.equal(fiveHour.sevenDay, undefined);
  assert.equal(fiveHour.extraUsage, undefined);
});

test("rejects Kimi payloads without a valid observation or usable window", () => {
  assert.throws(
    () => normalizeKimiManagedUsage({ kind: "ok", observedAt: "invalid" }),
    /observation time/
  );
  assert.throws(
    () => normalizeKimiManagedUsage({
      kind: "ok",
      observedAt: "2026-07-27T10:00:00Z",
      summary: { used: 1, limit: 0 },
      limits: [{ used: NaN, limit: 100, durationMinutes: 300 }]
    }),
    /no usable 5h or weekly/
  );
});

test("rejects malformed Grok billing periods and usage", () => {
  assert.throws(
    () => normalizeGrokBilling({ config: {} }),
    /weekly usage period/
  );
  assert.throws(
    () => normalizeGrokBilling({
      config: {
        creditUsagePercent: "unknown",
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "2026-07-19T05:05:41Z"
        }
      }
    }),
    /invalid weekly usage percentage/
  );
  assert.throws(
    () => normalizeGrokBilling({
      config: {
        creditUsagePercent: 1,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "not-a-date"
        }
      }
    }),
    /valid weekly reset time/
  );
});

test("rejects incomplete provider payloads", () => {
  assert.throws(() => normalizeGeminiQuotaResponse({}), /5h\/weekly/);
  assert.throws(() => normalizeCodexRateLimits({}), /primary rate limit/);
  assert.throws(() => normalizeClaudeUsage({}), /five_hour\/seven_day/);
  assert.throws(() => normalizeGrokBilling({}), /weekly usage period/);
  assert.throws(() => normalizeKimiManagedUsage({}), /managed usage payload/);
});
