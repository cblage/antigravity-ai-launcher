"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ActiveProviderTracker, isProviderActive } = require("../src/activeProvider");
const { runFirstAvailable } = require("../src/commandRunner");

test("keeps synchronous intent while command execution is pending", async () => {
  const hidden = [
    "workbench.auxiliaryBar.hidden\ttrue",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  let now = 0;
  let reads = 0;
  let finishCommand;
  let reportCommandStarted;
  const commandStarted = new Promise((resolve) => {
    reportCommandStarted = resolve;
  });
  const commandFinished = new Promise((resolve) => {
    finishCommand = resolve;
  });
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "codex", {
    now: () => now,
    readStorageSignature: () => "transitional-write",
    readWorkspaceState: async () => {
      reads += 1;
      return hidden;
    }
  });

  tracker.setOptimistic("codex");
  const opening = runFirstAvailable(["open-codex"], {
    getCommands: async () => ["open-codex"],
    executeCommand: async () => {
      assert.equal(isProviderActive(tracker.state, "codex"), true);
      reportCommandStarted();
      await commandFinished;
    }
  });

  await commandStarted;
  now = 100;
  await tracker.pollPersistedState();
  assert.equal(reads, 0, "transitional writes must be suppressed during opening");
  assert.equal(isProviderActive(tracker.state, "codex"), true);

  tracker.setOptimisticHidden();
  assert.equal(isProviderActive(tracker.state, "codex"), false);
  finishCommand();
  await opening;

  assert.equal(
    isProviderActive(tracker.state, "codex"),
    false,
    "completion of an older open command must not replay its state"
  );
  tracker.dispose();
});

test("does not execute when no target command is available", async () => {
  let executeCalls = 0;
  const result = await runFirstAvailable(["missing"], {
    getCommands: async () => ["something-else"],
    executeCommand: async () => {
      executeCalls += 1;
    }
  });

  assert.deepEqual(result, {
    executed: false,
    reason: "unavailable",
    target: undefined
  });
  assert.equal(executeCalls, 0);
});

test("activates a lazy target extension and retries command discovery", async () => {
  let activated = false;
  let activationCalls = 0;
  const executed = [];
  const result = await runFirstAvailable(["open-codex"], {
    getCommands: async () => activated ? ["open-codex"] : [],
    activateExtensions: async () => {
      activationCalls += 1;
      activated = true;
    },
    executeCommand: async (target) => executed.push(target)
  });

  assert.deepEqual(result, {
    executed: true,
    reason: undefined,
    target: "open-codex"
  });
  assert.equal(activationCalls, 1);
  assert.deepEqual(executed, ["open-codex"]);
});

test("does not activate an extension when its command is already available", async () => {
  let activationCalls = 0;
  const result = await runFirstAvailable(["grok.open"], {
    getCommands: async () => ["grok.open"],
    activateExtensions: async () => {
      activationCalls += 1;
    },
    executeCommand: async () => {}
  });

  assert.equal(result.executed, true);
  assert.equal(activationCalls, 0);
});

test("does not execute a lazy command when activation is superseded", async () => {
  let current = true;
  let commandReads = 0;
  let executeCalls = 0;
  const result = await runFirstAvailable(["open-codex"], {
    getCommands: async () => {
      commandReads += 1;
      return commandReads === 1 ? [] : ["open-codex"];
    },
    activateExtensions: async () => {
      current = false;
    },
    shouldExecute: () => current,
    executeCommand: async () => {
      executeCalls += 1;
    }
  });

  assert.deepEqual(result, {
    executed: false,
    reason: "superseded",
    target: undefined
  });
  assert.equal(commandReads, 1);
  assert.equal(executeCalls, 0);
});

test("a dispatched command rejection does not roll back optimistic state", async () => {
  const visible = [
    "workbench.auxiliaryBar.hidden\tfalse",
    "workbench.auxiliarybar.activepanelid\tworkbench.view.extension.codexSecondaryViewContainer"
  ].join("\n");
  const commandError = new Error("rejected after opening");
  let now = 0;
  let reads = 0;
  const observedActiveStates = [];
  const tracker = new ActiveProviderTracker("/tmp/test-state.vscdb", "codex", {
    now: () => now,
    readStorageSignature: () => `write-${reads}`,
    readWorkspaceState: async () => {
      reads += 1;
      return visible;
    }
  });
  tracker.onDidChange((state) => {
    observedActiveStates.push(isProviderActive(state, "codex"));
  });

  tracker.setOptimistic("codex");
  const result = await runFirstAvailable(["open-codex"], {
    getCommands: async () => ["open-codex"],
    executeCommand: async () => {
      assert.equal(isProviderActive(tracker.state, "codex"), true);
      throw commandError;
    }
  });

  assert.deepEqual(result, {
    executed: true,
    reason: "execution-error",
    target: "open-codex",
    error: commandError
  });
  now = 10;
  await tracker.pollPersistedState();
  assert.equal(reads, 0);
  assert.equal(isProviderActive(tracker.state, "codex"), true);

  now = 1100;
  await tracker.pollPersistedState();
  assert.equal(reads, 1);
  assert.equal(isProviderActive(tracker.state, "codex"), true);
  assert.deepEqual(observedActiveStates, [true]);
  tracker.dispose();
});

test("superseded command discovery cannot execute an older intent", async () => {
  let generation = 0;
  let resolveFirstCommands;
  let resolveSecondCommands;
  const executed = [];
  const firstCommands = new Promise((resolve) => {
    resolveFirstCommands = resolve;
  });
  const secondCommands = new Promise((resolve) => {
    resolveSecondCommands = resolve;
  });

  const firstGeneration = ++generation;
  const first = runFirstAvailable(["open"], {
    getCommands: () => firstCommands,
    shouldExecute: () => generation === firstGeneration,
    executeCommand: async (target) => executed.push(target)
  });
  const secondGeneration = ++generation;
  const second = runFirstAvailable(["close"], {
    getCommands: () => secondCommands,
    shouldExecute: () => generation === secondGeneration,
    executeCommand: async (target) => executed.push(target)
  });

  resolveSecondCommands(["close"]);
  assert.deepEqual(await second, {
    executed: true,
    reason: undefined,
    target: "close"
  });
  resolveFirstCommands(["open"]);
  assert.deepEqual(await first, {
    executed: false,
    reason: "superseded",
    target: "open"
  });
  assert.deepEqual(executed, ["close"]);
});
