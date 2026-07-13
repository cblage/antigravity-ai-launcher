"use strict";

const PROVIDERS = Object.freeze({
  gemini: { label: "Antigravity", openLabel: "Antigravity" },
  codex: { label: "Codex", openLabel: "Codex" },
  claude: { label: "Claude", openLabel: "Claude Code" },
  deepseek: {
    label: "DeepSeek",
    openLabel: "DeepSeek",
    showsUsageGauges: false
  },
  grok: {
    label: "Grok",
    openLabel: "Grok",
    showsUsageGauges: false
  }
});
const DEFAULT_USAGE_THRESHOLDS = Object.freeze({
  warning: 70,
  error: 90
});
const FILLED_GAUGE_ICON = "$(circle-filled)";
const EMPTY_GAUGE_ICON = "$(circle)";

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

function formatWindowGaugeText(label, window, options = {}) {
  const prefix = options.showStateIcons === false ? "" : statePrefix(options);
  const usedPercent = roundPercent(window.usedPercent);
  const percentText = formatPercent(usedPercent);
  if (options.showBars === false) {
    return `${prefix}${label} ${percentText}%`;
  }
  return `${prefix}${label} ${miniBar(usedPercent)} ${percentText}%`;
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
    .map((entry, index) => formatWindowGaugeText(entry.label, entry.window, {
      ...options,
      showStateIcons: index === 0 && options.showStateIcons !== false
    }))
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
  if (provider === "codex") {
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

function formatGaugeTooltip(snapshot, options = {}) {
  const provider = PROVIDERS[snapshot.provider] || { label: snapshot.provider || "AI" };
  const sidebar = options.sidebarVisible === false
    ? "Secondary sidebar hidden; showing the last-selected provider."
    : "Selected in the secondary sidebar.";
  const freshness = options.stale
    ? `Stale after refresh error: ${options.error || "unknown error"}`
    : "Current";

  return [
    `### ${provider.label} quota`,
    "",
    ...quotaWindowEntries(snapshot).map((entry) =>
      formatWindowLine(entry.tooltipLabel || entry.label, entry.window)
    ),
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
  formatLauncherText,
  formatLauncherTooltip,
  formatPercent,
  formatRefreshButtonLabel,
  formatWindowGaugeText,
  miniBar,
  quotaWindowEntries,
  shouldShowUsageGauges,
  windowSeverity
};
