"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActiveProviderTracker,
  isProviderActive,
  parseSqliteOutput,
  providerFromPanelId
} = require("../src/activeProvider");
const {
  orderForWorkspace,
  parseLanguageServers,
  workspaceIdForPath
} = require("../src/quota/gemini");

test("maps Antigravity secondary-sidebar container IDs", () => {
  assert.equal(providerFromPanelId("antigravity.agentViewContainerId"), "gemini");
  assert.equal(
    providerFromPanelId("workbench.view.extension.codexSecondaryViewContainer"),
    "codex"
  );
  assert.equal(
    providerFromPanelId("workbench.view.extension.claude-sidebar-secondary"),
    "claude"
  );
  assert.equal(
    providerFromPanelId("workbench.view.extension.cblage-codewhale"),
    "deepseek"
  );
  assert.equal(
    providerFromPanelId("workbench.view.extension.grokSidebar"),
    "grok"
  );
  assert.equal(
    providerFromPanelId("workbench.view.extension.kimi-secondary-sidebar"),
    "kimi"
  );
  assert.equal(
    providerFromPanelId("workbench.view.extension.deepcode"),
    undefined
  );
});

test("parses DeepSeek as the active secondary-sidebar provider", () => {
  const state = parseSqliteOutput([
    "workbench.auxiliaryBar.hidden\tfalse",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.cblage-codewhale"
  ].join("\n"));
  assert.deepEqual(state, {
    provider: "deepseek",
    sidebarVisible: true,
    recognizedPanel: true
  });
});

test("parses Grok as the active secondary-sidebar provider", () => {
  const state = parseSqliteOutput([
    "workbench.auxiliaryBar.hidden\tfalse",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.grokSidebar"
  ].join("\n"));
  assert.deepEqual(state, {
    provider: "grok",
    sidebarVisible: true,
    recognizedPanel: true
  });
});

test("parses Kimi as the active secondary-sidebar provider", () => {
  const state = parseSqliteOutput([
    "workbench.auxiliaryBar.hidden\tfalse",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.kimi-secondary-sidebar"
  ].join("\n"));
  assert.deepEqual(state, {
    provider: "kimi",
    sidebarVisible: true,
    recognizedPanel: true
  });
});

test("only treats a visible selected provider as active", () => {
  assert.equal(isProviderActive({ provider: "codex", sidebarVisible: true }, "codex"), true);
  assert.equal(isProviderActive({
    provider: "codex",
    sidebarVisible: true,
    recognizedPanel: false
  }, "codex"), false);
  assert.equal(isProviderActive({ provider: "codex", sidebarVisible: false }, "codex"), false);
  assert.equal(isProviderActive({ provider: "claude", sidebarVisible: true }, "codex"), false);
});

test("starts neutral until persisted sidebar state is known", () => {
  const tracker = new ActiveProviderTracker(undefined, "codex");
  assert.deepEqual(tracker.state, {
    provider: "codex",
    sidebarVisible: false,
    recognizedPanel: false
  });
  assert.equal(isProviderActive(tracker.state, "codex"), false);
  tracker.dispose();
});

test("optimistic launcher state opens providers and neutralizes them on close", () => {
  const tracker = new ActiveProviderTracker(undefined, "gemini");
  tracker.setOptimistic("codex");
  assert.deepEqual(tracker.state, {
    provider: "codex",
    sidebarVisible: true,
    recognizedPanel: true
  });

  tracker.setOptimisticHidden();
  assert.deepEqual(tracker.state, {
    provider: "codex",
    sidebarVisible: false,
    recognizedPanel: true
  });
  tracker.dispose();
});

test("one poll loop holds opening through grace and catches X on the next tick", async () => {
  const visible = [
    "workbench.auxiliaryBar.hidden\tfalse",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  const hidden = [
    "workbench.auxiliaryBar.hidden\ttrue",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  const outputs = [visible, hidden];
  let now = 0;
  let signature = "initial";
  let reads = 0;
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "codex", {
    now: () => now,
    readStorageSignature: () => signature,
    readWorkspaceState: async () => {
      reads += 1;
      return outputs.shift();
    }
  });

  tracker.setOptimistic("codex");
  signature = "opening-write";
  now = 100;
  await tracker.pollPersistedState();
  assert.equal(reads, 0);
  assert.equal(isProviderActive(tracker.state, "codex"), true);

  now = 1099;
  await tracker.pollPersistedState();
  assert.equal(reads, 0);
  assert.equal(isProviderActive(tracker.state, "codex"), true);

  now = 1100;
  await tracker.pollPersistedState();
  assert.equal(reads, 1);
  assert.equal(isProviderActive(tracker.state, "codex"), true);

  signature = "close-write";
  now = 1140;
  await tracker.pollPersistedState();
  assert.equal(reads, 2);
  assert.equal(isProviderActive(tracker.state, "codex"), false);
  tracker.dispose();
});

test("opening ignores stale hidden snapshots until its exact view is confirmed", async () => {
  const incompleteVisible = "workbench.auxiliaryBar.hidden\tfalse";
  const hidden = [
    "workbench.auxiliaryBar.hidden\ttrue",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  const visible = [
    "workbench.auxiliaryBar.hidden\tfalse",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  const outputs = [incompleteVisible, hidden, visible];
  let now = 0;
  let reads = 0;
  const observedActiveStates = [];
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "codex", {
    now: () => now,
    readStorageSignature: () => `write-${reads}`,
    readWorkspaceState: async () => {
      reads += 1;
      return outputs.shift();
    }
  });
  tracker.onDidChange((state) => {
    observedActiveStates.push(isProviderActive(state, "codex"));
  });

  tracker.setOptimistic("codex");
  for (const tick of [1100, 1140, 1180]) {
    now = tick;
    await tracker.pollPersistedState();
    assert.equal(isProviderActive(tracker.state, "codex"), true);
  }

  assert.equal(reads, 3);
  assert.deepEqual(observedActiveStates, [true]);
  tracker.dispose();
});

test("rapid model-button close replaces an unconfirmed opening intent", async () => {
  const hidden = [
    "workbench.auxiliaryBar.hidden\ttrue",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  let now = 0;
  let signature = "initial";
  let reads = 0;
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "codex", {
    now: () => now,
    readStorageSignature: () => signature,
    readWorkspaceState: async () => {
      reads += 1;
      return hidden;
    }
  });

  tracker.setOptimistic("codex");
  now = 500;
  tracker.setOptimisticHidden();
  signature = "final-hidden-write";
  await tracker.pollPersistedState();
  assert.equal(reads, 0);
  assert.equal(isProviderActive(tracker.state, "codex"), false);

  now = 1599;
  await tracker.pollPersistedState();
  assert.equal(reads, 0);
  assert.equal(isProviderActive(tracker.state, "codex"), false);

  now = 1600;
  await tracker.pollPersistedState();
  assert.equal(reads, 1);
  assert.equal(isProviderActive(tracker.state, "codex"), false);
  tracker.dispose();
});

test("active-button deactivation uses the same 1100ms grace", async () => {
  const hidden = [
    "workbench.auxiliaryBar.hidden\ttrue",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  let now = 0;
  let signature = "initial";
  let reads = 0;
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "codex", {
    now: () => now,
    readStorageSignature: () => signature,
    readWorkspaceState: async () => {
      reads += 1;
      return hidden;
    }
  });

  tracker.setOptimisticHidden();
  signature = "closing-write";
  now = 1099;
  await tracker.pollPersistedState();
  assert.equal(reads, 0);
  assert.equal(isProviderActive(tracker.state, "codex"), false);

  now = 1100;
  await tracker.pollPersistedState();
  assert.equal(reads, 1);
  assert.equal(isProviderActive(tracker.state, "codex"), false);
  tracker.dispose();
});

test("deactivation never reactivates while persisted hidden state catches up", async () => {
  const visible = [
    "workbench.auxiliaryBar.hidden\tfalse",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  const hidden = [
    "workbench.auxiliaryBar.hidden\ttrue",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  const outputs = [visible, visible, hidden];
  let now = 0;
  let reads = 0;
  const observedActiveStates = [];
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "codex", {
    now: () => now,
    readStorageSignature: () => `write-${reads}`,
    readWorkspaceState: async () => {
      reads += 1;
      return outputs.shift();
    }
  });
  tracker.update({
    provider: "codex",
    sidebarVisible: true,
    recognizedPanel: true
  });
  tracker.onDidChange((state) => {
    observedActiveStates.push(isProviderActive(state, "codex"));
  });

  tracker.setOptimisticHidden();
  assert.deepEqual(observedActiveStates, [false]);

  for (const tick of [1100, 1140, 1180]) {
    now = tick;
    await tracker.pollPersistedState();
    assert.equal(
      isProviderActive(tracker.state, "codex"),
      false,
      `deactivation must remain inactive at ${tick}ms`
    );
  }

  assert.equal(reads, 3);
  assert.deepEqual(observedActiveStates, [false]);
  tracker.dispose();
});

test("every rapid toggle cancels the previous grace and starts a new one", async () => {
  const visible = [
    "workbench.auxiliaryBar.hidden\tfalse",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  let now = 0;
  let signature = "initial";
  let reads = 0;
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "codex", {
    now: () => now,
    readStorageSignature: () => signature,
    readWorkspaceState: async () => {
      reads += 1;
      return visible;
    }
  });

  tracker.setOptimisticHidden();
  assert.equal(isProviderActive(tracker.state, "codex"), false);
  now = 200;
  tracker.setOptimistic("codex");
  assert.equal(isProviderActive(tracker.state, "codex"), true);
  now = 400;
  tracker.setOptimisticHidden();
  assert.equal(isProviderActive(tracker.state, "codex"), false);
  now = 600;
  tracker.setOptimistic("codex");
  assert.equal(isProviderActive(tracker.state, "codex"), true);
  signature = "final-visible-write";

  for (const obsoleteDeadline of [1100, 1300, 1500, 1699]) {
    now = obsoleteDeadline;
    await tracker.pollPersistedState();
    assert.equal(reads, 0);
    assert.equal(isProviderActive(tracker.state, "codex"), true);
  }

  now = 1700;
  await tracker.pollPersistedState();
  assert.equal(reads, 1);
  assert.equal(isProviderActive(tracker.state, "codex"), true);
  tracker.dispose();
});

test("a read started before opening cannot erase the optimistic accent", async () => {
  const hidden = [
    "workbench.auxiliaryBar.hidden\ttrue",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  let resolveRead;
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "codex", {
    readWorkspaceState: () => new Promise((resolve) => {
      resolveRead = resolve;
    })
  });

  const staleRead = tracker.refresh();
  tracker.setOptimistic("codex");
  resolveRead(hidden);
  await staleRead;

  assert.equal(isProviderActive(tracker.state, "codex"), true);
  tracker.dispose();
});

test("parses selected provider and auxiliary-bar visibility", () => {
  const state = parseSqliteOutput([
    "workbench.auxiliaryBar.hidden\tfalse",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer",
    ""
  ].join("\n"));
  assert.deepEqual(state, {
    provider: "codex",
    sidebarVisible: true,
    recognizedPanel: true
  });
});

test("retains fallback provider for unknown or hidden containers", () => {
  const state = parseSqliteOutput([
    "workbench.auxiliaryBar.hidden\ttrue",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.somethingElse"
  ].join("\n"), "claude");
  assert.deepEqual(state, {
    provider: "claude",
    sidebarVisible: false,
    recognizedPanel: false
  });
});

test("incomplete SQLite output preserves the last known state", () => {
  assert.deepEqual(
    parseSqliteOutput("", "codex", true, true),
    {
      provider: "codex",
      sidebarVisible: true,
      recognizedPanel: true
    }
  );
  assert.deepEqual(
    parseSqliteOutput(
      "workbench.auxiliaryBar.hidden\tfalse",
      "claude",
      false,
      true
    ),
    {
      provider: "claude",
      sidebarVisible: true,
      recognizedPanel: true
    }
  );
});

test("parses and prioritizes the current Antigravity language server", () => {
  const output = [
    "101 /Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token alpha --extension_server_port 5001 --app_data_dir antigravity-ide --workspace_id file_Users_someone_Other",
    "202 /Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token beta --extension_server_port 5002 --app_data_dir antigravity-ide --workspace_id file_Users_carlos_Documents_Scifi"
  ].join("\n");
  const candidates = parseLanguageServers(output);
  const ordered = orderForWorkspace(candidates, ["/Users/carlos/Documents/Scifi"]);
  assert.equal(workspaceIdForPath("/Users/carlos/Documents/Scifi"), "file_Users_carlos_Documents_Scifi");
  assert.equal(ordered[0].pid, 202);
  assert.equal(ordered[0].token, "beta");
});
