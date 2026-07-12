"use strict";

const AUXILIARY_BAR_TOGGLE_COMMAND = "workbench.action.toggleAuxiliaryBar";
const CLOSE_AUXILIARY_BAR_COMMAND = "workbench.action.closeAuxiliaryBar";
const FOCUS_AUXILIARY_BAR_COMMAND = "workbench.action.focusAuxiliaryBar";

async function handleAuxiliaryBarToggle(tracker, executeCommand) {
  const previousState = { ...tracker.state };
  const closing = tracker.state.sidebarVisible;
  const generation = closing
    ? tracker.setOptimisticHidden()
    : tracker.setOptimistic(tracker.state.provider);
  const target = closing
    ? CLOSE_AUXILIARY_BAR_COMMAND
    : FOCUS_AUXILIARY_BAR_COMMAND;

  try {
    return await executeCommand(target);
  } catch (error) {
    tracker.cancelIntent(generation, previousState);
    throw error;
  }
}

module.exports = {
  AUXILIARY_BAR_TOGGLE_COMMAND,
  CLOSE_AUXILIARY_BAR_COMMAND,
  FOCUS_AUXILIARY_BAR_COMMAND,
  handleAuxiliaryBarToggle
};
