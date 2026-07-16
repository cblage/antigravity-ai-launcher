"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PROVIDERS,
  formatGaugeText,
  formatGaugeTooltip,
  formatLauncherText,
  formatLauncherTooltip,
  formatPercent,
  formatRefreshButtonLabel,
  formatWeeklyPaceLine,
  formatWindowGaugeText,
  miniBar,
  shouldShowUsageGauges,
  weeklyQuotaPace,
  windowSeverity
} = require("../src/quota/format");

const snapshot = {
  provider: "gemini",
  source: "test",
  observedAt: new Date("2026-07-10T10:00:00Z"),
  fiveHour: {
    usedPercent: 1,
    remainingPercent: 99,
    resetAt: new Date("2026-07-10T13:00:00Z"),
    disabled: false
  },
  sevenDay: {
    usedPercent: 28,
    remainingPercent: 72,
    resetAt: new Date("2026-07-12T13:00:00Z"),
    disabled: false
  }
};

test("renders five-slot circle Codicon usage bars", () => {
  const filled = "$(circle-filled)";
  const empty = "$(circle)";
  assert.equal(miniBar(0), empty.repeat(5));
  assert.equal(miniBar(8), `${filled}${empty.repeat(4)}`);
  assert.equal(miniBar(29), `${filled.repeat(2)}${empty.repeat(3)}`);
  assert.equal(miniBar(50), `${filled.repeat(3)}${empty.repeat(2)}`);
  assert.equal(miniBar(100), filled.repeat(5));
  assert.equal(
    formatGaugeText(snapshot),
    `5h ${filled}${empty.repeat(4)} 01% · 7d ${filled.repeat(2)}${empty.repeat(3)} 28% $(pass-filled)`
  );
  assert.equal(
    formatWindowGaugeText("7d", snapshot.sevenDay, { showStateIcons: false }),
    `7d ${filled.repeat(2)}${empty.repeat(3)} 28%`
  );
});

test("pads single-digit percentages without padding double digits", () => {
  assert.equal(formatPercent(0), "00");
  assert.equal(formatPercent(5), "05");
  assert.equal(formatPercent(9), "09");
  assert.equal(formatPercent(10), "10");
  assert.equal(formatPercent(100), "100");
});

test("uses terse, normalized provider launcher tooltips", () => {
  assert.equal(formatLauncherTooltip("gemini"), "Open Antigravity");
  assert.equal(formatLauncherTooltip("codex"), "Open Codex");
  assert.equal(formatLauncherTooltip("claude"), "Open Claude Code");
  assert.equal(formatLauncherTooltip("deepseek"), "Open DeepSeek");
  assert.equal(formatLauncherTooltip("grok"), "Open Grok");
  assert.equal(
    formatLauncherTooltip("claude", true),
    "Open Claude Code\n\nActive"
  );
});

test("uses plain provider labels regardless of active state", () => {
  assert.equal(formatLauncherText("gemini"), "Antigravity");
  assert.equal(formatLauncherText("claude"), "Claude");
  assert.equal(formatLauncherText("codex"), "Codex");
  assert.equal(formatLauncherText("deepseek"), "DeepSeek");
  assert.equal(formatLauncherText("grok"), "Grok");
  assert.equal(formatLauncherText("grok", true), "Grok");
});

test("only shows usage gauges for active quota-based providers", () => {
  assert.equal(shouldShowUsageGauges("gemini"), true);
  assert.equal(shouldShowUsageGauges("claude"), true);
  assert.equal(shouldShowUsageGauges("codex"), true);
  assert.equal(shouldShowUsageGauges("deepseek"), false);
  assert.equal(shouldShowUsageGauges("grok"), true);
  assert.equal(shouldShowUsageGauges("gemini", false), false);
  assert.equal(shouldShowUsageGauges("claude", false), false);
  assert.equal(shouldShowUsageGauges("codex", false), false);
  assert.equal(shouldShowUsageGauges("grok", false), false);
});

test("names the refresh action for the selected provider", () => {
  assert.equal(
    formatRefreshButtonLabel("claude"),
    "Refresh Claude's 5h and 7d quota"
  );
  assert.equal(
    formatRefreshButtonLabel("gemini"),
    "Refresh Antigravity's 5h and 7d quota"
  );
  assert.equal(
    formatRefreshButtonLabel("codex"),
    "Refresh Codex's weekly quota"
  );
  assert.equal(
    formatRefreshButtonLabel("grok"),
    "Refresh Grok's weekly quota"
  );
});

test("renders a single weekly gauge for the new Codex quota shape", () => {
  const codex = {
    provider: "codex",
    source: "Codex app-server",
    observedAt: new Date("2026-07-13T03:43:02Z"),
    weeklyOnly: true,
    sevenDay: {
      usedPercent: 10,
      remainingPercent: 90,
      resetAt: new Date("2026-07-19T18:43:34Z"),
      disabled: false
    }
  };
  const filled = "$(circle-filled)";
  const empty = "$(circle)";

  assert.equal(
    formatGaugeText(codex),
    `7d ${filled}${empty.repeat(4)} 10% $(warning)`
  );
  const tooltip = formatGaugeTooltip(codex);
  assert.match(tooltip, /\*\*Weekly:\*\* 10\.0% used/);
  assert.match(tooltip, /\*\*Weekly pace:\*\* Over-consuming/);
  assert.match(tooltip, /10\.0% used vs 5\.4% of the window elapsed/);
  assert.doesNotMatch(tooltip, /\*\*5h:/);
});

test("renders Grok as a weekly-only provider", () => {
  const grok = {
    provider: "grok",
    source: "Grok CLI billing",
    observedAt: new Date("2026-07-15T12:00:00Z"),
    weeklyOnly: true,
    sevenDay: {
      usedPercent: 1,
      remainingPercent: 99,
      resetAt: new Date("2026-07-19T05:05:41Z"),
      durationMinutes: 10080,
      disabled: false
    }
  };

  assert.match(formatGaugeText(grok), /^7d .* 01%/);
  const tooltip = formatGaugeTooltip(grok);
  assert.match(tooltip, /### Grok quota/);
  assert.match(tooltip, /\*\*Weekly:\*\* 1\.0% used/);
  assert.doesNotMatch(tooltip, /\*\*5h:/);
});

test("compares weekly usage against elapsed quota-window time", () => {
  const observedAt = new Date("2026-07-04T12:00:00Z");
  const window = {
    usedPercent: 50,
    resetAt: new Date("2026-07-08T00:00:00Z"),
    durationMinutes: 10080,
    disabled: false
  };
  const equal = weeklyQuotaPace(window, observedAt);
  const over = weeklyQuotaPace({ ...window, usedPercent: 50.1 }, observedAt);

  assert.equal(equal.elapsedPercent, 50);
  assert.equal(equal.deltaPercentPoints, 0);
  assert.equal(equal.overConsuming, false);
  assert.equal(over.overConsuming, true);
  assert.equal(over.deltaPercentPoints, 0.10000000000000142);
  assert.match(formatWeeklyPaceLine(equal), /In the green.*exactly on pace/);
  assert.match(formatWeeklyPaceLine(over), /Over-consuming.*0\.1 percentage points over pace/);
});

test("omits weekly pace when timing data is invalid or expired", () => {
  const validWindow = {
    usedPercent: 10,
    resetAt: new Date("2026-07-08T00:00:00Z"),
    durationMinutes: 10080,
    disabled: false
  };

  assert.equal(weeklyQuotaPace(
    { ...validWindow, disabled: true },
    new Date("2026-07-04T12:00:00Z")
  ), undefined);
  assert.equal(weeklyQuotaPace(
    { ...validWindow, resetAt: undefined },
    new Date("2026-07-04T12:00:00Z")
  ), undefined);
  assert.equal(weeklyQuotaPace(validWindow, undefined), undefined);
  assert.equal(weeklyQuotaPace(
    { ...validWindow, durationMinutes: 0 },
    new Date("2026-07-04T12:00:00Z")
  ), undefined);
  assert.equal(weeklyQuotaPace(
    validWindow,
    new Date("2026-07-08T00:00:00Z")
  ), undefined);
  assert.equal(weeklyQuotaPace(
    validWindow,
    new Date("2026-06-30T23:59:59Z")
  ), undefined);
});

test("weekly pace rendering is provider-independent", () => {
  for (const provider of ["gemini", "claude", "codex", "grok"]) {
    const providerSnapshot = {
      provider,
      observedAt: new Date("2026-07-04T12:00:00Z"),
      sevenDay: {
        usedPercent: 40,
        remainingPercent: 60,
        resetAt: new Date("2026-07-08T00:00:00Z"),
        durationMinutes: 10080,
        disabled: false
      }
    };
    assert.match(formatGaugeText(providerSnapshot), /40% \$\(pass-filled\)$/);
    assert.match(formatGaugeTooltip(providerSnapshot), /Weekly pace.*In the green/);
  }
});

test("does not add an icon when the sidebar is hidden", () => {
  assert.equal(
    formatGaugeText(snapshot, { sidebarVisible: false, showBars: false }),
    "5h 01% · 7d 28%"
  );
});

test("tooltip contains both windows, source, and stale state", () => {
  const tooltip = formatGaugeTooltip(snapshot, {
    sidebarVisible: false,
    stale: true,
    error: "offline",
    checkedAt: new Date("2026-07-10T10:01:00Z")
  });
  assert.match(tooltip, /\*\*5h:\*\* 1\.0% used/);
  assert.match(tooltip, /\*\*7d:\*\* 28\.0% used/);
  assert.match(tooltip, /\*\*Weekly pace:\*\* In the green/);
  assert.match(tooltip, /28\.0% used vs 69\.6% of the window elapsed/);
  assert.match(tooltip, /last-selected provider/);
  assert.match(tooltip, /offline/);
  assert.match(tooltip, /Click any quota gauge to refresh now/);
});

test("disabled windows do not trigger severity", () => {
  const disabled = {
    ...snapshot.fiveHour,
    usedPercent: 100,
    disabled: true
  };
  assert.equal(windowSeverity(disabled), "normal");
});

test("applies warning and error severity at exact boundaries", () => {
  const withUsage = (usedPercent) => ({ ...snapshot.sevenDay, usedPercent });

  assert.equal(windowSeverity(withUsage(69.99)), "normal");
  assert.equal(windowSeverity(withUsage(70)), "warning");
  assert.equal(windowSeverity(withUsage(89.99)), "warning");
  assert.equal(windowSeverity(withUsage(90)), "error");
});

test("evaluates 5h and 7d window severity independently", () => {
  const thresholds = { warning: 15, error: 25 };
  assert.equal(
    windowSeverity({ ...snapshot.fiveHour, usedPercent: 8 }, thresholds),
    "normal"
  );
  assert.equal(
    windowSeverity({ ...snapshot.sevenDay, usedPercent: 29 }, thresholds),
    "error"
  );
});
