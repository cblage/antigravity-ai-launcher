"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ActiveProviderTracker, isProviderActive } = require("../src/activeProvider");
const {
  CLOSE_AUXILIARY_BAR_COMMAND,
  FOCUS_AUXILIARY_BAR_COMMAND,
  handleAuxiliaryBarToggle
} = require("../src/auxiliaryBar");

test("the Secondary Side Bar X clears an unconfirmed opening immediately", async () => {
  const tracker = new ActiveProviderTracker(undefined, "gemini");
  const executed = [];

  tracker.setOptimistic("gemini");
  assert.equal(tracker.awaitingVisibleProvider, "gemini");
  assert.equal(isProviderActive(tracker.state, "gemini"), true);

  const closing = handleAuxiliaryBarToggle(tracker, async (command) => {
    executed.push(command);
  });

  assert.equal(isProviderActive(tracker.state, "gemini"), false);
  assert.equal(tracker.awaitingVisibleProvider, undefined);
  assert.equal(tracker.awaitingHiddenConfirmation, true);
  await closing;
  assert.deepEqual(executed, [CLOSE_AUXILIARY_BAR_COMMAND]);
  tracker.dispose();
});

test("the global auxiliary-bar toggle still opens when currently hidden", async () => {
  const tracker = new ActiveProviderTracker(undefined, "codex");
  const executed = [];

  await handleAuxiliaryBarToggle(tracker, async (command) => {
    executed.push(command);
  });

  assert.equal(isProviderActive(tracker.state, "codex"), true);
  assert.equal(tracker.awaitingVisibleProvider, "codex");
  assert.deepEqual(executed, [FOCUS_AUXILIARY_BAR_COMMAND]);
  tracker.dispose();
});

test("a failed delegated toggle restores the prior tracker state", async () => {
  const tracker = new ActiveProviderTracker(undefined, "gemini");
  const failure = new Error("delegate failed");

  await assert.rejects(
    handleAuxiliaryBarToggle(tracker, async () => {
      throw failure;
    }),
    failure
  );

  assert.equal(isProviderActive(tracker.state, "gemini"), false);
  assert.equal(tracker.awaitingVisibleProvider, undefined);
  assert.equal(tracker.awaitingHiddenConfirmation, false);
  tracker.dispose();
});
