"use strict";

async function runFirstAvailable(candidates, options) {
  let availableCommands = new Set(await options.getCommands());
  let target = candidates.find((command) => availableCommands.has(command));

  if (!target && options.activateExtensions) {
    if (options.shouldExecute && !options.shouldExecute()) {
      return { executed: false, reason: "superseded", target: undefined };
    }

    await options.activateExtensions();

    if (options.shouldExecute && !options.shouldExecute()) {
      return { executed: false, reason: "superseded", target: undefined };
    }

    availableCommands = new Set(await options.getCommands());
    target = candidates.find((command) => availableCommands.has(command));
  }

  if (!target) {
    return { executed: false, reason: "unavailable", target: undefined };
  }

  if (options.shouldExecute && !options.shouldExecute()) {
    return { executed: false, reason: "superseded", target };
  }

  try {
    await options.executeCommand(target);
  } catch (error) {
    // The command may have changed the workbench before its promise rejected.
    // Report that it was dispatched so callers do not roll back UI intent.
    return { executed: true, reason: "execution-error", target, error };
  }
  return { executed: true, reason: undefined, target };
}

module.exports = { runFirstAvailable };
