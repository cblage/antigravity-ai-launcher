"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PROVIDER_SECONDARY_SIDEBAR_SETTINGS,
  ensureProviderSecondarySidebar
} = require("../src/providerSidebar");

test("maps Kimi to its secondary-sidebar setting", () => {
  assert.deepEqual(PROVIDER_SECONDARY_SIDEBAR_SETTINGS, {
    kimi: {
      section: "kimi",
      setting: "openInSecondarySidebar"
    }
  });
});

test("enables Kimi's secondary sidebar globally before opening it", async () => {
  const updates = [];
  const changed = await ensureProviderSecondarySidebar("kimi", {
    getConfiguration: (section) => {
      assert.equal(section, "kimi");
      return {
        get: (setting, fallback) => {
          assert.equal(setting, "openInSecondarySidebar");
          assert.equal(fallback, false);
          return false;
        },
        update: async (...args) => updates.push(args)
      };
    },
    configurationTarget: "global"
  });

  assert.equal(changed, true);
  assert.deepEqual(updates, [
    ["openInSecondarySidebar", true, "global"]
  ]);
});

test("does not rewrite an already-enabled Kimi setting", async () => {
  let updateCalls = 0;
  const changed = await ensureProviderSecondarySidebar("kimi", {
    getConfiguration: () => ({
      get: () => true,
      update: async () => {
        updateCalls += 1;
      }
    }),
    configurationTarget: "global"
  });

  assert.equal(changed, false);
  assert.equal(updateCalls, 0);
});

test("leaves providers without a sidebar-setting contract untouched", async () => {
  let configurationReads = 0;
  const changed = await ensureProviderSecondarySidebar("grok", {
    getConfiguration: () => {
      configurationReads += 1;
    },
    configurationTarget: "global"
  });

  assert.equal(changed, false);
  assert.equal(configurationReads, 0);
});
