"use strict";

const MAXIMIZE_AUXILIARY_BAR_COMMAND = "workbench.action.maximizeAuxiliaryBar";
const TOGGLE_MAXIMIZED_AUXILIARY_BAR_COMMAND =
  "workbench.action.toggleMaximizedAuxiliaryBar";

async function handleMaximizeAuxiliaryBar(state, options) {
  if (state.sidebarVisible) {
    await options.executeCommand(TOGGLE_MAXIMIZED_AUXILIARY_BAR_COMMAND);
    return { action: "toggled", provider: state.provider };
  }

  const provider = options.isKnownProvider(state.provider)
    ? state.provider
    : "gemini";
  const opened = await options.openProvider(provider);
  if (
    !opened?.executed
    || (options.shouldContinue && !options.shouldContinue(opened))
  ) {
    return { action: "not-opened", provider, opened };
  }

  await options.executeCommand(MAXIMIZE_AUXILIARY_BAR_COMMAND);
  return { action: "opened-maximized", provider, opened };
}

function createMaximizeAuxiliaryBarRunner(getState, options) {
  let queue = Promise.resolve();
  return function run() {
    const operation = queue.then(() =>
      handleMaximizeAuxiliaryBar(getState(), options)
    );
    queue = operation.catch(() => {});
    return operation;
  };
}

module.exports = {
  MAXIMIZE_AUXILIARY_BAR_COMMAND,
  TOGGLE_MAXIMIZED_AUXILIARY_BAR_COMMAND,
  createMaximizeAuxiliaryBarRunner,
  handleMaximizeAuxiliaryBar
};
