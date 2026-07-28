"use strict";

const PROVIDERS = Object.freeze({
  gemini: { label: "Antigravity", openLabel: "Antigravity" },
  codex: { label: "Codex", openLabel: "Codex", weeklyOnly: true },
  claude: { label: "Claude", openLabel: "Claude Code" },
  deepseek: {
    label: "DeepSeek",
    openLabel: "DeepSeek",
    showsUsageGauges: false
  },
  grok: {
    label: "Grok",
    openLabel: "Grok",
    weeklyOnly: true
  },
  kimi: {
    label: "Kimi",
    openLabel: "Kimi Code"
  }
});
const DEFAULT_USAGE_THRESHOLDS = Object.freeze({
  warning: 70,
  error: 90
});
const FILLED_GAUGE_ICON = "$(circle-filled)";
const EMPTY_GAUGE_ICON = "$(circle)";
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

function miniBar(percent, slots = 5) {
  const safeSlots = Math.max(1, Math.floor(slots));
  const numericPercent = Number(percent);
  const safePercent = Number.isFinite(numericPercent)
    ? Math.max(0, Math.min(100, numericPercent))
    : 0;
  const filled = safePercent > 0
    ? Math.ceil(safePercent / 100 * safeSlots)
    : 0;

  return `${FILLED_GAUGE_ICON.repeat(filled)}${EMPTY_GAUGE_ICON.repeat(safeSlots - filled)}`;
}

function roundPercent(value) {
  return Math.round(Number(value) || 0);
}

function formatPercent(value) {
  return String(roundPercent(value)).padStart(2, "0");
}

function statePrefix(options = {}) {
  const staleMarker = options.stale ? "$(history) " : "";
  return staleMarker;
}

function weeklyQuotaPace(window, observedAt) {
  if (window?.disabled) {
    return undefined;
  }
  const reference = observedAt instanceof Date ? observedAt : new Date(observedAt);
  const resetAt = window?.resetAt instanceof Date
    ? window.resetAt
    : new Date(window?.resetAt);
  const durationMinutes = Number(
    window?.durationMinutes ?? WEEKLY_WINDOW_MINUTES
  );
  const usedPercent = Number(window?.usedPercent);
  if (
    Number.isNaN(reference.getTime())
    || Number.isNaN(resetAt.getTime())
    || !Number.isFinite(durationMinutes)
    || durationMinutes <= 0
    || !Number.isFinite(usedPercent)
  ) {
    return undefined;
  }

  const durationMs = durationMinutes * 60 * 1000;
  const remainingMs = resetAt.getTime() - reference.getTime();
  if (remainingMs <= 0 || remainingMs > durationMs) {
    return undefined;
  }

  const elapsedPercent = Math.max(
    0,
    Math.min(100, (1 - remainingMs / durationMs) * 100)
  );
  const deltaPercentPoints = usedPercent - elapsedPercent;
  return {
    usedPercent,
    elapsedPercent,
    deltaPercentPoints,
    overConsuming: deltaPercentPoints > 0
  };
}

function weeklyPaceIcon(pace) {
  if (!pace) {
    return "";
  }
  return pace.overConsuming ? "$(warning)" : "$(pass-filled)";
}

function formatWindowGaugeText(label, window, options = {}) {
  const prefix = options.showStateIcons === false ? "" : statePrefix(options);
  const usedPercent = roundPercent(window.usedPercent);
  const percentText = formatPercent(usedPercent);
  const paceIcon = weeklyPaceIcon(options.pace);
  const suffix = paceIcon ? ` ${paceIcon}` : "";
  if (options.showBars === false) {
    return `${prefix}${label} ${percentText}%${suffix}`;
  }
  return `${prefix}${label} ${miniBar(usedPercent)} ${percentText}%${suffix}`;
}

function quotaWindowEntries(snapshot) {
  if (Array.isArray(snapshot?.windows) && snapshot.windows.length > 0) {
    return snapshot.windows.filter((entry) => entry?.window);
  }
  return [
    {
      id: "fiveHour",
      label: "5h",
      tooltipLabel: "5h",
      window: snapshot?.fiveHour
    },
    {
      id: "sevenDay",
      label: "7d",
      tooltipLabel: snapshot?.weeklyOnly ? "Weekly" : "7d",
      window: snapshot?.sevenDay
    }
  ].filter((entry) => entry.window);
}

function formatGaugeText(snapshot, options = {}) {
  return quotaWindowEntries(snapshot)
    .map((entry, index) => {
      const pace = entry.id === "sevenDay" && options.sidebarVisible !== false
        ? weeklyQuotaPace(entry.window, snapshot.observedAt)
        : undefined;
      return formatWindowGaugeText(entry.label, entry.window, {
        ...options,
        pace,
        showStateIcons: index === 0 && options.showStateIcons !== false
      });
    })
    .join(" · ");
}

function formatLauncherTooltip(provider, active = false) {
  const metadata = PROVIDERS[provider] || {
    openLabel: provider || "AI"
  };
  const tooltip = `Open ${metadata.openLabel}`;
  return active ? `${tooltip}\n\nActive` : tooltip;
}

function formatLauncherText(provider) {
  return PROVIDERS[provider]?.label || provider || "AI";
}

function shouldShowUsageGauges(provider, sidebarVisible = true) {
  return sidebarVisible !== false
    && PROVIDERS[provider]?.showsUsageGauges !== false;
}

function formatRefreshButtonLabel(provider, verb = "Refresh") {
  const metadata = PROVIDERS[provider] || { label: provider || "AI" };
  if (metadata.weeklyOnly) {
    return `${verb} ${metadata.label}'s weekly quota`;
  }
  return `${verb} ${metadata.label}'s 5h and 7d quota`;
}

function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "unknown";
  }
  return date.toLocaleString();
}

function formatWindowLine(label, window) {
  const disabled = window.disabled ? " (currently disabled)" : "";
  return `- **${label}:** ${window.usedPercent.toFixed(1)}% used · ${window.remainingPercent.toFixed(1)}% remaining${disabled} · resets ${formatDate(window.resetAt)}`;
}

function formatWeeklyPaceLine(pace) {
  if (!pace) {
    return undefined;
  }
  const state = pace.overConsuming ? "Over-consuming" : "In the green";
  const difference = Math.abs(pace.deltaPercentPoints);
  const comparison = difference < 0.05
    ? "exactly on pace"
    : `${difference.toFixed(1)} percentage points ${pace.overConsuming ? "over" : "under"} pace`;
  return `- **Weekly pace:** ${state} — ${pace.usedPercent.toFixed(1)}% used vs ${pace.elapsedPercent.toFixed(1)}% of the window elapsed (${comparison}).`;
}

function formatMoney(cents, currency) {
  const amount = Number(cents) / 100;
  const code = typeof currency === "string" ? currency.toUpperCase() : "";
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code || "currency units"}`;
  }
}

function formatBoosterLines(extraUsage) {
  if (!extraUsage) {
    return [];
  }
  const balance = formatMoney(extraUsage.balanceCents, extraUsage.currency);
  const total = formatMoney(extraUsage.totalCents, extraUsage.currency);
  const monthlyUsed = formatMoney(extraUsage.monthlyUsedCents, extraUsage.currency);
  if (!balance || !total || !monthlyUsed) {
    return [];
  }
  const monthlyLimit = formatMoney(
    extraUsage.monthlyChargeLimitCents,
    extraUsage.currency
  );
  const monthlyLine = extraUsage.monthlyChargeLimitEnabled && monthlyLimit
    ? `- **Monthly Booster spend:** ${monthlyUsed} of ${monthlyLimit} cap.`
    : `- **Monthly Booster spend:** ${monthlyUsed} (no monthly cap).`;
  return [
    `- **Booster balance:** ${balance} remaining of ${total}.`,
    monthlyLine
  ];
}

function formatGaugeTooltip(snapshot, options = {}) {
  const provider = PROVIDERS[snapshot.provider] || { label: snapshot.provider || "AI" };
  const sidebar = options.sidebarVisible === false
    ? "Secondary sidebar hidden; showing the last-selected provider."
    : "Selected in the secondary sidebar.";
  const freshness = options.stale
    ? `Stale after refresh error: ${options.error || "unknown error"}`
    : "Current";

  const windowLines = quotaWindowEntries(snapshot).flatMap((entry) => {
    const pace = entry.id === "sevenDay"
      ? weeklyQuotaPace(entry.window, snapshot.observedAt)
      : undefined;
    return [
      formatWindowLine(entry.tooltipLabel || entry.label, entry.window),
      formatWeeklyPaceLine(pace)
    ].filter(Boolean);
  });
  const boosterLines = formatBoosterLines(snapshot.extraUsage);

  return [
    `### ${provider.label} quota`,
    "",
    ...windowLines,
    ...boosterLines,
    "",
    `- **State:** ${freshness}`,
    `- **Sidebar:** ${sidebar}`,
    `- **Source:** ${snapshot.source}`,
    `- **Checked:** ${formatDate(options.checkedAt || snapshot.observedAt)}`,
    "",
    "Click any quota gauge to refresh now."
  ].join("\n");
}

function windowSeverity(window, thresholds = DEFAULT_USAGE_THRESHOLDS) {
  if (window.disabled) {
    return "normal";
  }
  const usage = Number(window.usedPercent) || 0;
  if (usage >= thresholds.error) {
    return "error";
  }
  if (usage >= thresholds.warning) {
    return "warning";
  }
  return "normal";
}

module.exports = {
  DEFAULT_USAGE_THRESHOLDS,
  PROVIDERS,
  formatGaugeText,
  formatGaugeTooltip,
  formatMoney,
  formatLauncherText,
  formatLauncherTooltip,
  formatPercent,
  formatRefreshButtonLabel,
  formatWindowGaugeText,
  formatWeeklyPaceLine,
  miniBar,
  quotaWindowEntries,
  shouldShowUsageGauges,
  weeklyQuotaPace,
  windowSeverity
};
