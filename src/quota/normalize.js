"use strict";

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(100, number));
}

function asDate(value, epochUnit = "milliseconds") {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const normalized = typeof value === "number" && epochUnit === "seconds"
    ? value * 1000
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function createWindow({
  usedPercent,
  remainingPercent,
  resetAt,
  durationMinutes,
  disabled = false
}) {
  const hasUsed = usedPercent !== undefined && usedPercent !== null;
  const hasRemaining = remainingPercent !== undefined && remainingPercent !== null;
  const used = hasUsed
    ? clampPercent(usedPercent)
    : clampPercent(100 - Number(remainingPercent));
  const remaining = hasRemaining
    ? clampPercent(remainingPercent)
    : clampPercent(100 - used);
  const duration = Number(durationMinutes);

  return {
    usedPercent: used,
    remainingPercent: remaining,
    resetAt: asDate(resetAt),
    durationMinutes: Number.isFinite(duration) && duration > 0
      ? duration
      : undefined,
    disabled: Boolean(disabled)
  };
}

function normalizeGeminiQuotaResponse(payload, observedAt = new Date()) {
  const groups = payload?.response?.groups || payload?.groups || [];
  const group = groups.find((candidate) =>
    /gemini/i.test(candidate?.displayName || "") ||
    candidate?.buckets?.some((bucket) => /^gemini-/i.test(bucket?.bucketId || ""))
  );

  const buckets = group?.buckets || [];
  const fiveHour = buckets.find((bucket) =>
    bucket?.window === "5h" || /five.?hour|5h/i.test(bucket?.displayName || "")
  );
  const sevenDay = buckets.find((bucket) =>
    bucket?.window === "weekly" || /week|7d/i.test(bucket?.displayName || "")
  );

  if (!fiveHour || !sevenDay) {
    throw new Error("Antigravity returned no Gemini 5h/weekly quota buckets.");
  }

  return {
    provider: "gemini",
    source: "Antigravity quota summary",
    observedAt: asDate(observedAt),
    fiveHour: createWindow({
      remainingPercent: Number(fiveHour.remainingFraction) * 100,
      resetAt: fiveHour.resetTime,
      durationMinutes: 300,
      disabled: fiveHour.disabled
    }),
    sevenDay: createWindow({
      remainingPercent: Number(sevenDay.remainingFraction) * 100,
      resetAt: sevenDay.resetTime,
      durationMinutes: 10080,
      disabled: sevenDay.disabled
    })
  };
}

function normalizeCodexRateLimits(payload, observedAt = new Date(), source = "Codex app-server") {
  const limits = payload?.rateLimitsByLimitId?.codex || payload?.rateLimits || payload;
  if (!limits?.primary) {
    throw new Error("Codex returned no primary rate limit.");
  }

  const windows = [limits.primary, limits.secondary].filter(Boolean).map((window) => ({
    raw: window,
    minutes: Number(
      window.windowDurationMins ??
      window.window_minutes ??
      window.windowMinutes ??
      0
    )
  }));
  function normalizeWindow(window) {
    const raw = window.raw;
    const resetEpoch = raw.resetsAt ?? raw.resets_at ?? raw.reset_at;
    return createWindow({
      usedPercent: raw.usedPercent ?? raw.used_percent,
      resetAt: asDate(Number(resetEpoch), "seconds"),
      durationMinutes: window.minutes
    });
  }

  const base = {
    provider: "codex",
    source,
    observedAt: asDate(observedAt),
    plan: limits.planType || limits.plan_type
  };

  if (!limits.secondary) {
    const primary = windows[0];
    const key = primary.minutes === 10080 ? "sevenDay" : "fiveHour";
    return {
      ...base,
      weeklyOnly: key === "sevenDay",
      [key]: normalizeWindow(primary)
    };
  }

  const fiveHour = windows.find((window) => window.minutes === 300) || windows[0];
  const sevenDay = windows.find((window) => window.minutes === 10080) || windows[1];

  return {
    ...base,
    fiveHour: normalizeWindow(fiveHour),
    sevenDay: normalizeWindow(sevenDay)
  };
}

function normalizeCodexSessionEvent(event) {
  const limits = event?.payload?.rate_limits;
  const limitId = limits?.limitId ?? limits?.limit_id;
  if (!limits?.primary || (limitId && limitId !== "codex")) {
    return undefined;
  }
  const observedAt = asDate(event.timestamp) || new Date();
  return normalizeCodexRateLimits(limits, observedAt, "Codex session log");
}

function normalizeClaudeUsage(payload, observedAt = new Date(), source = "Anthropic OAuth usage") {
  if (!payload?.five_hour || !payload?.seven_day) {
    throw new Error("Claude returned no five_hour/seven_day usage.");
  }

  return {
    provider: "claude",
    source,
    observedAt: asDate(observedAt),
    fiveHour: createWindow({
      usedPercent: payload.five_hour.utilization,
      resetAt: payload.five_hour.resets_at,
      durationMinutes: 300
    }),
    sevenDay: createWindow({
      usedPercent: payload.seven_day.utilization,
      resetAt: payload.seven_day.resets_at,
      durationMinutes: 10080
    })
  };
}

module.exports = {
  asDate,
  clampPercent,
  createWindow,
  normalizeClaudeUsage,
  normalizeCodexRateLimits,
  normalizeCodexSessionEvent,
  normalizeGeminiQuotaResponse
};
