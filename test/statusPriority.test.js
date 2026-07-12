"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STATUS_PRIORITIES } = require("../src/statusPriority");

test("keeps the complete launcher cluster immediately left of Antigravity Settings", () => {
  assert.deepEqual(STATUS_PRIORITIES, {
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
});
