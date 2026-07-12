"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAXIMIZE_AUXILIARY_BAR_COMMAND,
  TOGGLE_MAXIMIZED_AUXILIARY_BAR_COMMAND,
  createMaximizeAuxiliaryBarRunner,
  handleMaximizeAuxiliaryBar
} = require("../src/maximizeAuxiliaryBar");

function knownProvider(provider) {
  return ["gemini", "codex", "grok"].includes(provider);
}

test("an open secondary sidebar toggles its maximized state", async () => {
  const commands = [];
  let openCalls = 0;
  const result = await handleMaximizeAuxiliaryBar(
    { provider: "codex", sidebarVisible: true },
    {
      isKnownProvider: knownProvider,
      openProvider: async () => {
        openCalls += 1;
      },
      executeCommand: async (command) => commands.push(command)
    }
  );

  assert.deepEqual(result, { action: "toggled", provider: "codex" });
  assert.equal(openCalls, 0);
  assert.deepEqual(commands, [TOGGLE_MAXIMIZED_AUXILIARY_BAR_COMMAND]);
});

test("a hidden secondary sidebar opens its last provider then maximizes", async () => {
  const commands = [];
  const openedProviders = [];
  const opened = { executed: true, generation: 4 };
  const result = await handleMaximizeAuxiliaryBar(
    { provider: "grok", sidebarVisible: false },
    {
      isKnownProvider: knownProvider,
      openProvider: async (provider) => {
        openedProviders.push(provider);
        return opened;
      },
      shouldContinue: ({ generation }) => generation === 4,
      executeCommand: async (command) => commands.push(command)
    }
  );

  assert.deepEqual(result, {
    action: "opened-maximized",
    provider: "grok",
    opened
  });
  assert.deepEqual(openedProviders, ["grok"]);
  assert.deepEqual(commands, [MAXIMIZE_AUXILIARY_BAR_COMMAND]);
});

test("an unknown last provider falls back to Antigravity", async () => {
  const openedProviders = [];
  await handleMaximizeAuxiliaryBar(
    { provider: undefined, sidebarVisible: false },
    {
      isKnownProvider: knownProvider,
      openProvider: async (provider) => {
        openedProviders.push(provider);
        return { executed: true };
      },
      executeCommand: async () => {}
    }
  );

  assert.deepEqual(openedProviders, ["gemini"]);
});

test("an unavailable last provider falls back to Antigravity", async () => {
  const openedProviders = [];
  await handleMaximizeAuxiliaryBar(
    { provider: "codex", sidebarVisible: false },
    {
      isKnownProvider: (provider) => provider === "gemini",
      openProvider: async (provider) => {
        openedProviders.push(provider);
        return { executed: true };
      },
      executeCommand: async () => {}
    }
  );

  assert.deepEqual(openedProviders, ["gemini"]);
});

test("a failed provider open does not maximize the sidebar", async () => {
  const commands = [];
  const opened = { executed: false, reason: "unavailable", generation: 2 };
  const result = await handleMaximizeAuxiliaryBar(
    { provider: "codex", sidebarVisible: false },
    {
      isKnownProvider: knownProvider,
      openProvider: async () => opened,
      executeCommand: async (command) => commands.push(command)
    }
  );

  assert.deepEqual(result, {
    action: "not-opened",
    provider: "codex",
    opened
  });
  assert.deepEqual(commands, []);
});

test("a superseded open cannot maximize after a newer intent", async () => {
  const commands = [];
  const opened = { executed: true, generation: 7 };
  const result = await handleMaximizeAuxiliaryBar(
    { provider: "codex", sidebarVisible: false },
    {
      isKnownProvider: knownProvider,
      openProvider: async () => opened,
      shouldContinue: () => false,
      executeCommand: async (command) => commands.push(command)
    }
  );

  assert.equal(result.action, "not-opened");
  assert.deepEqual(commands, []);
});

test("rapid eye clicks run open, maximize, then toggle in order", async () => {
  let state = { provider: "codex", sidebarVisible: false };
  let reportOpenStarted;
  let finishOpen;
  const openStarted = new Promise((resolve) => {
    reportOpenStarted = resolve;
  });
  const openFinished = new Promise((resolve) => {
    finishOpen = resolve;
  });
  const commands = [];
  const run = createMaximizeAuxiliaryBarRunner(
    () => state,
    {
      isKnownProvider: knownProvider,
      openProvider: async () => {
        state = { provider: "codex", sidebarVisible: true };
        reportOpenStarted();
        await openFinished;
        return { executed: true, generation: 1 };
      },
      shouldContinue: () => true,
      executeCommand: async (command) => commands.push(command)
    }
  );

  const first = run();
  await openStarted;
  const second = run();
  finishOpen();
  await Promise.all([first, second]);

  assert.deepEqual(commands, [
    MAXIMIZE_AUXILIARY_BAR_COMMAND,
    TOGGLE_MAXIMIZED_AUXILIARY_BAR_COMMAND
  ]);
});
