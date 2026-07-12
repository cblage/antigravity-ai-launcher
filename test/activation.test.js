"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../package.json");

test("activates eagerly and reconciles initial state without blocking commands", () => {
  assert.deepEqual(manifest.activationEvents, ["*"]);

  const source = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");
  const activeProviderSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "activeProvider.js"),
    "utf8"
  );
  assert.match(source, /function activate\(context\)/);
  assert.doesNotMatch(source, /async function activate\(context\)/);
  assert.doesNotMatch(source, /await tracker\.refresh\(\)/);
  assert.match(source, /void tracker\.refresh\(\)/);
  assert.doesNotMatch(source, /beforeExecute/);
  assert.match(source, /"antigravity\.agentSidePanel\.focus"/);
  assert.match(source, /"cblage\.codewhale\.openChat"/);
  assert.match(source, /"workbench\.view\.extension\.cblage-codewhale"/);
  assert.match(source, /"grok\.open"/);
  assert.match(source, /claude: \[PROVIDER_EXTENSION_IDS\.claude\]/);
  assert.match(source, /codex: \[PROVIDER_EXTENSION_IDS\.codex\]/);
  assert.match(source, /deepseek: \[PROVIDER_EXTENSION_IDS\.deepseek\]/);
  assert.match(source, /grok: \[PROVIDER_EXTENSION_IDS\.grok\]/);
  assert.match(source, /vscode\.extensions\.getExtension\(id\)/);
  assert.match(source, /await extension\.activate\(\)/);
  assert.match(source, /vscode\.extensions\.onDidChange\(updateProviderAvailability\)/);
  assert.match(source, /renderProviderAvailability/);
  assert.match(source, /text: "\$\(eye\)"/);
  assert.match(source, /STATUS_PRIORITIES\.sidebarMaximize/);
  assert.match(source, /registerSidebarMaximizeCommand\(context, tracker\)/);
  assert.match(source, /"\$\(warning\) Unable to load quota"/);
  assert.match(source, /quotaUnavailable\s*\?\s*new vscode\.ThemeColor\("statusBarItem\.warningBackground"\)/);
  assert.match(source, /context\.globalState\.get\(CLAUDE_QUOTA_STATE_KEY\)/);
  assert.match(source, /context\.globalState\.update\(CLAUDE_QUOTA_STATE_KEY, state\)/);
  assert.ok(
    manifest.contributes.commands.some(
      ({ command }) =>
        command === "antigravityAiLauncher.toggleMaximizedSecondarySidebar"
    )
  );
  assert.match(activeProviderSource, /"workbench\.view\.extension\.grokSidebar"/);
  assert.ok(
    manifest.contributes.commands.some(
      ({ command }) => command === "antigravityAiLauncher.openGrok"
    )
  );
  assert.doesNotMatch(source, /"deepcode\.openView"/);
  assert.doesNotMatch(source, /"workbench\.view\.extension\.deepcode"/);
  assert.doesNotMatch(source, /"antigravity\.(?:openAgent|toggleChatFocus)"/);
  assert.match(source, /registerCommand\(\s*AUXILIARY_BAR_TOGGLE_COMMAND/);
  assert.match(source, /handleAuxiliaryBarToggle/);
  assert.match(source, /new CascadeVisibilityMonitor\(tracker, cascade\)/);
  assert.match(source, /typeof cascade\?\.getFocusState === "function"/);
  assert.match(source, /initialLiveProbe\.then\(startPersistedTracking\)/);
  assert.ok(
    source.indexOf("initialLiveProbe = cascadeVisibility.start()")
      < source.indexOf("tracker.start()")
  );
  assert.ok(
    source.indexOf("const generation = closing")
      < source.indexOf("if (closing)")
  );
});
