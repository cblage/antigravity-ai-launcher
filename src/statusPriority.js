"use strict";

const STATUS_PRIORITIES = Object.freeze({
  // Antigravity - Settings uses priority 0. Keep this cluster immediately
  // to its left while preserving the cluster's internal order.
  activity: 0.7,
  fiveHour: 0.6,
  sevenDay: 0.5,
  gemini: 0.4,
  claude: 0.3,
  codex: 0.2,
  deepseek: 0.1,
  grok: 0.05,
  sidebarMaximize: 0.025
});

module.exports = { STATUS_PRIORITIES };
