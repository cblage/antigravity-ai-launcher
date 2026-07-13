"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeClaudeUsage,
  normalizeCodexRateLimits,
  normalizeCodexSessionEvent,
  normalizeGeminiQuotaResponse
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

test("rejects incomplete provider payloads", () => {
  assert.throws(() => normalizeGeminiQuotaResponse({}), /5h\/weekly/);
  assert.throws(() => normalizeCodexRateLimits({}), /primary rate limit/);
  assert.throws(() => normalizeClaudeUsage({}), /five_hour\/seven_day/);
});
