"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ActiveProviderTracker, isProviderActive } = require("../src/activeProvider");
const { CascadeVisibilityMonitor } = require("../src/cascadeVisibility");

test("live Antigravity visibility ignores pre-open false then catches its custom X", () => {
  const tracker = new ActiveProviderTracker(undefined, "gemini");
  const observed = [];
  tracker.onDidChange((state) => {
    observed.push(isProviderActive(state, "gemini"));
  });

  const generation = tracker.setOptimistic("gemini");
  tracker.applyLiveVisibility("gemini", false, generation);
  assert.equal(isProviderActive(tracker.state, "gemini"), true);
  assert.equal(tracker.awaitingVisibleProvider, "gemini");

  tracker.applyLiveVisibility("gemini", true, generation);
  assert.equal(tracker.awaitingVisibleProvider, undefined);
  assert.equal(isProviderActive(tracker.state, "gemini"), true);

  tracker.applyLiveVisibility("gemini", false, generation);
  assert.equal(isProviderActive(tracker.state, "gemini"), false);
  assert.deepEqual(observed, [true, false]);
  tracker.dispose();
});

test("an opening with only exact false samples resolves when grace expires", () => {
  let now = 0;
  const tracker = new ActiveProviderTracker(undefined, "gemini", {
    now: () => now
  });

  const generation = tracker.setOptimistic("gemini");
  tracker.applyLiveVisibility("gemini", false, generation);
  assert.equal(isProviderActive(tracker.state, "gemini"), true);
  assert.equal(tracker.awaitingVisibleProvider, "gemini");

  now = 1100;
  tracker.applyLiveVisibility("gemini", false, generation);
  assert.equal(isProviderActive(tracker.state, "gemini"), false);
  assert.equal(tracker.awaitingVisibleProvider, undefined);
  tracker.dispose();
});

test("an exact visible panel restores a failed close only after close grace", () => {
  let now = 0;
  const tracker = new ActiveProviderTracker(undefined, "gemini", {
    now: () => now
  });
  const openingGeneration = tracker.setOptimistic("gemini");
  tracker.applyLiveVisibility("gemini", true, openingGeneration);

  const closingGeneration = tracker.setOptimisticHidden();
  tracker.applyLiveVisibility("gemini", true, closingGeneration);
  assert.equal(isProviderActive(tracker.state, "gemini"), false);
  assert.equal(tracker.awaitingHiddenConfirmation, true);

  now = 1100;
  tracker.applyLiveVisibility("gemini", true, closingGeneration);
  assert.equal(isProviderActive(tracker.state, "gemini"), true);
  assert.equal(tracker.awaitingHiddenConfirmation, false);
  tracker.dispose();
});

test("live Antigravity state prevents stale SQLite from replaying visibility", async () => {
  const staleHidden = [
    "workbench.auxiliaryBar.hidden\ttrue",
    "workbench.auxiliarybar.activepanelid\tantigravity.agentViewContainerId"
  ].join("\n");
  let now = 0;
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "gemini", {
    now: () => now,
    readStorageSignature: () => "stale-write",
    readWorkspaceState: async () => staleHidden
  });

  const generation = tracker.setOptimistic("gemini");
  tracker.applyLiveVisibility("gemini", true, generation);
  now = 1100;
  await tracker.pollPersistedState();

  assert.equal(isProviderActive(tracker.state, "gemini"), true);
  tracker.dispose();
});

test("a custom-X live false outranks stale visible SQLite", async () => {
  const staleVisible = [
    "workbench.auxiliaryBar.hidden\tfalse",
    "workbench.auxiliarybar.activepanelid\tantigravity.agentViewContainerId"
  ].join("\n");
  let now = 0;
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "gemini", {
    now: () => now,
    readStorageSignature: () => "stale-write",
    readWorkspaceState: async () => staleVisible
  });

  const generation = tracker.setOptimistic("gemini");
  tracker.applyLiveVisibility("gemini", true, generation);
  tracker.applyLiveVisibility("gemini", false, generation);
  now = 1100;
  await tracker.pollPersistedState();

  assert.equal(isProviderActive(tracker.state, "gemini"), false);
  tracker.dispose();
});

test("an obsolete live visibility response cannot override a newer click", () => {
  const tracker = new ActiveProviderTracker(undefined, "gemini");
  const oldGeneration = tracker.setOptimistic("gemini");
  tracker.setOptimisticHidden();

  tracker.applyLiveVisibility("gemini", true, oldGeneration);
  assert.equal(isProviderActive(tracker.state, "gemini"), false);
  tracker.dispose();
});

test("Cascade visibility probes are serialized", async () => {
  const tracker = new ActiveProviderTracker(undefined, "gemini");
  let resolveProbe;
  let calls = 0;
  const cascade = {
    getFocusState: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    }
  };
  const monitor = new CascadeVisibilityMonitor(tracker, cascade);

  const first = monitor.poll();
  const second = monitor.poll();
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveProbe({ isVisible: false });
  await Promise.all([first, second]);

  const third = monitor.poll();
  await Promise.resolve();
  assert.equal(calls, 2);
  resolveProbe({ isVisible: false });
  await third;
  monitor.dispose();
  tracker.dispose();
});

test("a malformed Cascade response cannot masquerade as hidden", async () => {
  const tracker = new ActiveProviderTracker(undefined, "gemini");
  const generation = tracker.setOptimistic("gemini");
  tracker.applyLiveVisibility("gemini", true, generation);
  const monitor = new CascadeVisibilityMonitor(tracker, {
    getFocusState: async () => ({})
  });

  await monitor.poll();
  assert.equal(isProviderActive(tracker.state, "gemini"), true);
  monitor.dispose();
  tracker.dispose();
});
