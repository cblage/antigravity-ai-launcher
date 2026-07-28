"use strict";

const vscode = require("vscode");
const {
  ActiveProviderTracker,
  findWorkspaceDatabase,
  isProviderActive
} = require("./src/activeProvider");
const {
  AUXILIARY_BAR_TOGGLE_COMMAND,
  handleAuxiliaryBarToggle
} = require("./src/auxiliaryBar");
const { CascadeVisibilityMonitor } = require("./src/cascadeVisibility");
const { ClaudeQuotaReader } = require("./src/quota/claude");
const { CodexQuotaReader } = require("./src/quota/codex");
const {
  PROVIDERS,
  formatGaugeTooltip,
  formatLauncherText,
  formatLauncherTooltip,
  formatRefreshButtonLabel,
  formatWindowGaugeText,
  quotaWindowEntries,
  shouldShowUsageGauges,
  weeklyQuotaPace,
  windowSeverity
} = require("./src/quota/format");
const { GeminiQuotaReader } = require("./src/quota/gemini");
const { GrokQuotaReader } = require("./src/quota/grok");
const { KimiQuotaReader } = require("./src/quota/kimi");
const { STATUS_PRIORITIES } = require("./src/statusPriority");
const { runFirstAvailable } = require("./src/commandRunner");
const {
  createMaximizeAuxiliaryBarRunner
} = require("./src/maximizeAuxiliaryBar");
const {
  PROVIDER_EXTENSION_IDS,
  isProviderAvailable,
  renderProviderAvailability
} = require("./src/providerAvailability");
const {
  ensureProviderSecondarySidebar
} = require("./src/providerSidebar");

const REFRESH_INTERVAL_MS = 60000;
const SPINNER_INTERVAL_MS = 80;
const ACTIVE_PROVIDER_COLOR = "focusBorder";
const CLAUDE_QUOTA_STATE_KEY = "claudeQuotaState.v1";
const GROK_QUOTA_STATE_KEY = "grokQuotaState.v1";
const SPINNER_FRAMES = Object.freeze([
  "⣾",
  "⣽",
  "⣻",
  "⢿",
  "⡿",
  "⣟",
  "⣯",
  "⣷"
]);
const QUOTA_WINDOWS = Object.freeze({
  fiveHour: {
    id: "antigravityAiLauncher.quotaGauge.fiveHour",
    label: "5h",
    name: "Active AI 5-hour quota",
    priority: STATUS_PRIORITIES.fiveHour
  },
  sevenDay: {
    id: "antigravityAiLauncher.quotaGauge.sevenDay",
    label: "7d",
    name: "Active AI 7-day quota",
    priority: STATUS_PRIORITIES.sevenDay
  }
});
const TARGET_COMMANDS = Object.freeze({
  gemini: [
    "antigravity.agentSidePanel.focus"
  ],
  newGeminiConversation: [
    "antigravity.startNewConversation"
  ],
  closeSecondarySidebar: [
    "workbench.action.closeAuxiliaryBar"
  ],
  codex: [
    "chatgpt.openSidebar"
  ],
  deepseek: [
    "cblage.codewhale.openChat",
    "workbench.view.extension.cblage-codewhale"
  ],
  grok: [
    "grok.open"
  ],
  kimi: [
    "kimi.openInSideBar"
  ],
  claudeSidebar: [
    "claude-vscode.sidebar.open"
  ]
});
const TARGET_EXTENSIONS = Object.freeze({
  claude: [PROVIDER_EXTENSION_IDS.claude],
  codex: [PROVIDER_EXTENSION_IDS.codex],
  deepseek: [PROVIDER_EXTENSION_IDS.deepseek],
  grok: [PROVIDER_EXTENSION_IDS.grok],
  kimi: [PROVIDER_EXTENSION_IDS.kimi]
});
const SIDEBAR_MAXIMIZE_BUTTON = Object.freeze({
  id: "antigravityAiLauncher.button.sidebarMaximize",
  text: "$(eye)",
  name: "Open or maximize the Secondary Side Bar",
  tooltip: "Open the last selected provider maximized, or toggle maximize/restore",
  priority: STATUS_PRIORITIES.sidebarMaximize,
  command: "antigravityAiLauncher.toggleMaximizedSecondarySidebar"
});
const LAUNCHER_BUTTONS = Object.freeze({
  gemini: {
    id: "antigravityAiLauncher.button.gemini",
    text: formatLauncherText("gemini"),
    name: "Open Antigravity",
    tooltip: formatLauncherTooltip("gemini"),
    priority: STATUS_PRIORITIES.gemini,
    command: "antigravityAiLauncher.openGemini"
  },
  claude: {
    id: "antigravityAiLauncher.button.claude",
    text: formatLauncherText("claude"),
    name: "Open Claude Code",
    tooltip: formatLauncherTooltip("claude"),
    priority: STATUS_PRIORITIES.claude,
    command: "antigravityAiLauncher.openClaude"
  },
  codex: {
    id: "antigravityAiLauncher.button.codex",
    text: formatLauncherText("codex"),
    name: "Open Codex",
    tooltip: formatLauncherTooltip("codex"),
    priority: STATUS_PRIORITIES.codex,
    command: "antigravityAiLauncher.openCodex"
  },
  deepseek: {
    id: "antigravityAiLauncher.button.deepseek",
    text: formatLauncherText("deepseek"),
    name: "Open DeepSeek",
    tooltip: formatLauncherTooltip("deepseek"),
    priority: STATUS_PRIORITIES.deepseek,
    command: "antigravityAiLauncher.openDeepSeek"
  },
  grok: {
    id: "antigravityAiLauncher.button.grok",
    text: formatLauncherText("grok"),
    name: "Open Grok",
    tooltip: formatLauncherTooltip("grok"),
    priority: STATUS_PRIORITIES.grok,
    command: "antigravityAiLauncher.openGrok"
  },
  kimi: {
    id: "antigravityAiLauncher.button.kimi",
    text: formatLauncherText("kimi"),
    name: "Open Kimi Code",
    tooltip: formatLauncherTooltip("kimi"),
    priority: STATUS_PRIORITIES.kimi,
    command: "antigravityAiLauncher.openKimi"
  }
});

async function executeFirstAvailable(label, candidates, options = {}) {
  try {
    const result = await runFirstAvailable(candidates, {
      getCommands: () => vscode.commands.getCommands(false),
      executeCommand: (target) => vscode.commands.executeCommand(target),
      activateExtensions: options.extensionIds?.length
        ? async () => {
            for (const id of options.extensionIds) {
              const extension = vscode.extensions.getExtension(id);
              if (extension && !extension.isActive) {
                await extension.activate();
              }
            }
          }
        : undefined,
      shouldExecute: options.shouldExecute
    });
    if (result.reason === "unavailable") {
      options.onUnavailable?.();
      void vscode.window.showErrorMessage(
        `${label} is unavailable. Expected one of: ${candidates.join(", ")}`
      );
    } else if (result.reason === "execution-error") {
      const detail = result.error instanceof Error
        ? result.error.message
        : String(result.error);
      void vscode.window.showErrorMessage(`Could not open ${label}: ${detail}`);
    }
    return result;
  } catch (error) {
    options.onError?.(error);
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Could not open ${label}: ${detail}`);
    return { executed: false, reason: "error", target: undefined, error };
  }
}

async function executeProviderOpen(tracker, label, provider, candidates) {
  const previousState = { ...tracker.state };
  const generation = tracker.setOptimistic(provider);
  try {
    await ensureProviderSecondarySidebar(provider, {
      getConfiguration: (section) =>
        vscode.workspace.getConfiguration(section),
      configurationTarget: vscode.ConfigurationTarget.Global
    });
  } catch (error) {
    tracker.cancelIntent(generation, previousState);
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Could not open ${label}: ${detail}`);
    return {
      executed: false,
      reason: "configuration-error",
      target: undefined,
      error,
      generation
    };
  }
  if (tracker.stateGeneration !== generation) {
    return {
      executed: false,
      reason: "superseded",
      target: undefined,
      generation
    };
  }
  const result = await executeFirstAvailable(label, candidates, {
    extensionIds: TARGET_EXTENSIONS[provider],
    shouldExecute: () => tracker.stateGeneration === generation,
    onUnavailable: () => tracker.cancelIntent(generation, previousState),
    onError: () => tracker.cancelIntent(generation, previousState)
  });
  return { ...result, generation };
}

function registerLauncherCommand(
  context,
  tracker,
  command,
  label,
  candidates,
  onInvoke
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      command,
      () => {
        const previousState = { ...tracker.state };
        const generation = onInvoke?.();
        return executeFirstAvailable(label, candidates, {
          shouldExecute: generation === undefined
            ? undefined
            : () => tracker.stateGeneration === generation,
          onUnavailable: () => tracker.cancelIntent(generation, previousState),
          onError: () => tracker.cancelIntent(generation, previousState)
        });
      }
    )
  );
}

function registerProviderLauncherCommand(
  context,
  tracker,
  command,
  label,
  provider,
  candidates
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(command, () => {
      const previousState = { ...tracker.state };
      const closing = isProviderActive(tracker.state, provider);
      const generation = closing
        ? tracker.setOptimisticHidden()
        : undefined;
      const options = {
        shouldExecute: () => tracker.stateGeneration === generation,
        onUnavailable: () => tracker.cancelIntent(generation, previousState),
        onError: () => tracker.cancelIntent(generation, previousState)
      };

      if (closing) {
        return executeFirstAvailable(
          "the Secondary Side Bar",
          TARGET_COMMANDS.closeSecondarySidebar,
          options
        );
      }
      return executeProviderOpen(tracker, label, provider, candidates);
    })
  );
}

function registerSidebarMaximizeCommand(context, tracker) {
  const runMaximizeAction = createMaximizeAuxiliaryBarRunner(
    () => tracker.state,
    {
      isKnownProvider: (provider) =>
        Object.hasOwn(PROVIDERS, provider)
        && isProviderAvailable(
          provider,
          (id) => vscode.extensions.getExtension(id)
        ),
      openProvider: (provider) => executeProviderOpen(
        tracker,
        PROVIDERS[provider].openLabel,
        provider,
        TARGET_COMMANDS[provider]
      ),
      shouldContinue: ({ generation }) =>
        tracker.stateGeneration === generation,
      executeCommand: (command) => vscode.commands.executeCommand(command)
    }
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      SIDEBAR_MAXIMIZE_BUTTON.command,
      async () => {
        try {
          return await runMaximizeAction();
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(
            `Could not resize the Secondary Side Bar: ${detail}`
          );
          return undefined;
        }
      }
    )
  );
}

function createLauncherButton(
  context,
  { id, text, name, tooltip, priority, command },
  visible = true
) {
  const button = vscode.window.createStatusBarItem(
    id,
    vscode.StatusBarAlignment.Right,
    priority
  );
  button.text = text;
  button.name = name;
  button.tooltip = tooltip;
  button.command = command;
  if (visible) {
    button.show();
  }
  context.subscriptions.push(button);
  return button;
}

function renderActiveLauncher(buttons, state) {
  for (const [provider, button] of Object.entries(buttons)) {
    const active = isProviderActive(state, provider);
    button.text = formatLauncherText(provider);
    button.tooltip = formatLauncherTooltip(provider, active);
    button.backgroundColor = undefined;
    button.color = active
      ? new vscode.ThemeColor(ACTIVE_PROVIDER_COLOR)
      : undefined;
  }
}

function quotaSettings() {
  const configuration = vscode.workspace.getConfiguration("antigravityAiLauncher");
  return {
    enabled: configuration.get("quota.enabled", true),
    showBars: configuration.get("quota.showBars", true)
  };
}

class QuotaGauge {
  constructor(context, tracker, readers) {
    this.context = context;
    this.tracker = tracker;
    this.readers = readers;
    this.cache = new Map();
    this.inFlight = new Map();
    this.activeState = tracker.state;
    this.feedbackTimer = undefined;
    this.spinnerTimer = undefined;
    this.spinnerFrame = 0;

    this.items = Object.fromEntries(
      Object.entries(QUOTA_WINDOWS).map(([key, definition]) => {
        const item = vscode.window.createStatusBarItem(
          definition.id,
          vscode.StatusBarAlignment.Right,
          definition.priority
        );
        item.name = definition.name;
        item.command = "antigravityAiLauncher.refreshQuota";
        context.subscriptions.push(item);
        return [key, item];
      })
    );
    this.activityItem = vscode.window.createStatusBarItem(
      "antigravityAiLauncher.quotaGauge.activity",
      vscode.StatusBarAlignment.Right,
      STATUS_PRIORITIES.activity
    );
    this.activityItem.name = "Quota refresh activity";
    context.subscriptions.push(this.activityItem);

    context.subscriptions.push(
      tracker.onDidChange((state) => this.onProviderState(state)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("antigravityAiLauncher.quota")) {
          this.render();
          if (quotaSettings().enabled) {
            void this.refresh(false);
          }
        }
      })
    );

    this.interval = setInterval(() => void this.refresh(false), REFRESH_INTERVAL_MS);
    this.interval.unref?.();
    context.subscriptions.push(this);
  }

  hideGaugeItems() {
    for (const item of Object.values(this.items)) {
      item.hide();
    }
  }

  clearFeedback() {
    this.stopSpinner();
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = undefined;
    this.activityItem.hide();
  }

  hideAll() {
    this.clearFeedback();
    this.hideGaugeItems();
  }

  start() {
    this.render();
    void this.refresh(false);
  }

  onProviderState(state) {
    const becameActive = state.sidebarVisible && !this.activeState.sidebarVisible;
    const providerChanged = state.provider !== this.activeState.provider;
    this.activeState = state;
    void this.context.workspaceState.update("lastProvider", state.provider);
    this.render();

    const cached = this.cache.get(state.provider);
    const age = cached?.checkedAt ? Date.now() - cached.checkedAt.getTime() : Infinity;
    if ((providerChanged || becameActive) && age > 15000) {
      void this.refresh(false);
    }
  }

  async refresh(force, notify = false) {
    const settings = quotaSettings();
    if (!settings.enabled) {
      this.hideAll();
      return;
    }

    const provider = this.activeState.provider;
    if (!shouldShowUsageGauges(
      provider,
      isProviderActive(this.activeState, provider)
    )) {
      this.hideAll();
      return;
    }
    const reader = this.readers[provider];
    if (!reader) {
      this.hideAll();
      return;
    }
    if (this.inFlight.has(provider)) {
      if (notify) {
        this.render({ loading: true });
      }
      return this.inFlight.get(provider);
    }

    const existing = this.cache.get(provider);
    if (notify || !existing?.snapshot) {
      this.render({ loading: true });
    }

    let showSuccess = false;
    const operation = (async () => {
      try {
        const snapshot = await reader.read({ force });
        this.cache.set(provider, {
          snapshot,
          checkedAt: new Date(),
          error: snapshot.stale ? "Provider returned the last good value." : undefined
        });
        if (notify) {
          if (snapshot.stale) {
            void vscode.window.showWarningMessage(
              `${PROVIDERS[provider].label} quota is still stale; showing the last good value.`
            );
          } else {
            showSuccess = true;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.cache.set(provider, {
          ...existing,
          checkedAt: existing?.checkedAt || new Date(),
          error: message
        });
        if (notify) {
          void vscode.window.showWarningMessage(message);
        }
      } finally {
        this.inFlight.delete(provider);
        if (provider === this.activeState.provider) {
          if (showSuccess) {
            this.render();
            this.showTransientFeedback(
              provider,
              "$(check)",
              PROVIDERS[provider].weeklyOnly
                ? `${PROVIDERS[provider].label}'s weekly quota refreshed.`
                : `${PROVIDERS[provider].label}'s 5h and 7d quota refreshed.`,
              2500
            );
          } else {
            this.render();
          }
        }
      }
    })();

    this.inFlight.set(provider, operation);
    return operation;
  }

  showTransientFeedback(provider, text, tooltip, durationMs) {
    this.clearFeedback();
    if (
      provider !== this.activeState.provider
      || !quotaSettings().enabled
      || !shouldShowUsageGauges(
        provider,
        isProviderActive(this.activeState, provider)
      )
    ) {
      this.render();
      return;
    }

    this.activityItem.backgroundColor = undefined;
    this.activityItem.color = new vscode.ThemeColor(ACTIVE_PROVIDER_COLOR);
    this.activityItem.text = text;
    this.activityItem.name = tooltip.replace(/\.$/, "");
    this.activityItem.tooltip = tooltip;
    this.activityItem.accessibilityInformation = {
      label: tooltip.replace(/\.$/, "")
    };
    this.activityItem.show();
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = undefined;
      this.activityItem.hide();
    }, durationMs);
    this.feedbackTimer.unref?.();
  }

  startSpinner(provider) {
    this.stopSpinner();
    this.spinnerFrame = 0;

    const update = () => {
      if (
        provider !== this.activeState.provider
        || !shouldShowUsageGauges(
          provider,
          isProviderActive(this.activeState, provider)
        )
      ) {
        this.stopSpinner();
        this.render();
        return;
      }

      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
      this.spinnerFrame += 1;
      this.activityItem.backgroundColor = undefined;
      this.activityItem.color = new vscode.ThemeColor(ACTIVE_PROVIDER_COLOR);
      this.activityItem.text = frame;
      const label = formatRefreshButtonLabel(provider, "Refreshing");
      this.activityItem.name = label;
      this.activityItem.tooltip = `${label}…`;
      this.activityItem.accessibilityInformation = {
        label
      };
      this.activityItem.show();
    };

    update();
    this.spinnerTimer = setInterval(update, SPINNER_INTERVAL_MS);
    this.spinnerTimer.unref?.();
  }

  stopSpinner() {
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  render(options = {}) {
    this.clearFeedback();
    const settings = quotaSettings();
    if (!settings.enabled) {
      this.hideGaugeItems();
      return;
    }

    const provider = this.activeState.provider;
    if (!shouldShowUsageGauges(
      provider,
      isProviderActive(this.activeState, provider)
    )) {
      this.hideGaugeItems();
      return;
    }
    const metadata = PROVIDERS[provider];
    const refreshLabel = formatRefreshButtonLabel(provider);
    const cached = this.cache.get(provider);

    if (cached?.snapshot) {
      const stale = Boolean(cached.error || cached.snapshot.stale);
      const tooltip = new vscode.MarkdownString(
        formatGaugeTooltip(cached.snapshot, {
          sidebarVisible: this.activeState.sidebarVisible,
          checkedAt: cached.checkedAt,
          stale,
          error: cached.error
        })
      );
      tooltip.isTrusted = false;

      const windowEntries = quotaWindowEntries(cached.snapshot);
      for (const [key, definition] of Object.entries(QUOTA_WINDOWS)) {
        const item = this.items[key];
        const entry = windowEntries.find((candidate) => candidate.id === key);
        if (!entry) {
          item.hide();
          continue;
        }
        const window = entry.window;
        const pace = key === "sevenDay"
          ? weeklyQuotaPace(window, cached.snapshot.observedAt)
          : undefined;
        item.backgroundColor = undefined;
        item.color = this.activeState.sidebarVisible
          ? new vscode.ThemeColor(ACTIVE_PROVIDER_COLOR)
          : undefined;
        item.text = formatWindowGaugeText(entry.label || definition.label, window, {
          showBars: settings.showBars,
          sidebarVisible: this.activeState.sidebarVisible,
          stale,
          pace,
          showStateIcons: entry === windowEntries[0]
        });
        item.name = refreshLabel;
        item.tooltip = tooltip;
        item.accessibilityInformation = {
          label: `${metadata.label} ${entry.tooltipLabel || entry.label || definition.label} quota: ${Math.round(window.usedPercent)} percent used.${pace ? ` ${pace.overConsuming ? "Over-consuming" : "In the green"}: ${pace.usedPercent.toFixed(1)} percent used versus ${pace.elapsedPercent.toFixed(1)} percent of the window elapsed.` : ""} Activate to refresh.`
        };

        const severity = windowSeverity(window);
        if (severity === "error") {
          item.color = undefined;
          item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        } else if (severity === "warning") {
          item.color = undefined;
          item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        }
        item.show();
      }
    } else {
      this.hideGaugeItems();
    }

    if (options.loading) {
      this.startSpinner(provider);
      return;
    }

    if (!cached?.snapshot) {
      const item = metadata.weeklyOnly ? this.items.sevenDay : this.items.fiveHour;
      const quotaUnavailable = Boolean(cached?.error);
      item.backgroundColor = quotaUnavailable
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
      item.color = undefined;
      item.text = quotaUnavailable
        ? "$(warning) Unable to load quota"
        : `$(warning) ${metadata.label} quota`;
      item.name = quotaUnavailable ? "Unable to load quota" : refreshLabel;
      item.tooltip = quotaUnavailable
        ? `${cached.error}\n\nClick to retry.`
        : `Waiting for ${metadata.label} quota data. Click to refresh.`;
      item.accessibilityInformation = {
        label: quotaUnavailable
          ? "Unable to load quota. Activate to retry."
          : `Waiting for ${metadata.label} quota data. Activate to refresh.`
      };
      item.show();
    }
  }

  dispose() {
    clearInterval(this.interval);
    clearTimeout(this.feedbackTimer);
    this.stopSpinner();
    for (const reader of Object.values(this.readers)) {
      reader.dispose?.();
    }
  }
}

function activate(context) {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const lastProvider = context.workspaceState.get("lastProvider", "gemini");
  const fallbackProvider = Object.hasOwn(PROVIDERS, lastProvider)
    ? lastProvider
    : "gemini";
  const tracker = new ActiveProviderTracker(
    findWorkspaceDatabase(context, workspaceFolders),
    fallbackProvider
  );
  context.subscriptions.push(tracker);

  // Standard Secondary Side Bar controls run this toggle command. Shadow the
  // built-in so the tracker receives the exact close/open event, then delegate
  // to idempotent built-ins rather than waiting for SQLite persistence.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      AUXILIARY_BAR_TOGGLE_COMMAND,
      () => handleAuxiliaryBarToggle(
        tracker,
        (command) => vscode.commands.executeCommand(command)
      )
    )
  );

  // Antigravity's custom React close button bypasses workbench commands. Its
  // undocumented runtime Cascade API exposes the exact live container state
  // without a proposed-API gate, so use it as the authoritative Gemini signal.
  const cascade = vscode.Cascade;
  let initialLiveProbe;
  if (typeof cascade?.getFocusState === "function") {
    const cascadeVisibility = new CascadeVisibilityMonitor(tracker, cascade);
    context.subscriptions.push(cascadeVisibility);
    initialLiveProbe = cascadeVisibility.start();
  }

  const startPersistedTracking = () => {
    if (tracker.disposed) {
      return;
    }
    tracker.start();
    // Do not block cold command activation on SQLite. A click increments the
    // generation and invalidates this read if it is still in flight.
    void tracker.refresh();
  };
  if (initialLiveProbe) {
    // Keep startup neutral until Antigravity's exact state is known; otherwise
    // a stale database row can flash blue before the first live probe returns.
    void initialLiveProbe.then(startPersistedTracking);
  } else {
    startPersistedTracking();
  }

  const quotaGauge = new QuotaGauge(context, tracker, {
    gemini: new GeminiQuotaReader({
      workspacePaths: workspaceFolders.map((folder) => folder.uri.fsPath)
    }),
    codex: new CodexQuotaReader({
      getConfiguredCommand: () =>
        vscode.workspace.getConfiguration("chatgpt").get("cliExecutable")
    }),
    claude: new ClaudeQuotaReader({
      persistedState: context.globalState.get(CLAUDE_QUOTA_STATE_KEY),
      persistState: (state) =>
        context.globalState.update(CLAUDE_QUOTA_STATE_KEY, state)
    }),
    grok: new GrokQuotaReader({
      getConfiguredCommand: () =>
        vscode.workspace.getConfiguration("grok").get("cliPath", ""),
      persistedState: context.globalState.get(GROK_QUOTA_STATE_KEY),
      persistState: (state) =>
        context.globalState.update(GROK_QUOTA_STATE_KEY, state)
    }),
    kimi: new KimiQuotaReader({
      getExtension: (id) => vscode.extensions.getExtension(id),
      getCommands: () => vscode.commands.getCommands(false),
      executeCommand: (command) => vscode.commands.executeCommand(command)
    })
  });

  registerProviderLauncherCommand(
    context,
    tracker,
    "antigravityAiLauncher.openGemini",
    "Antigravity",
    "gemini",
    TARGET_COMMANDS.gemini
  );
  registerLauncherCommand(
    context,
    tracker,
    "antigravityAiLauncher.newGeminiConversation",
    "a new Antigravity conversation",
    TARGET_COMMANDS.newGeminiConversation,
    () => tracker.setOptimistic("gemini")
  );
  registerProviderLauncherCommand(
    context,
    tracker,
    "antigravityAiLauncher.openCodex",
    "Codex",
    "codex",
    TARGET_COMMANDS.codex
  );
  registerProviderLauncherCommand(
    context,
    tracker,
    "antigravityAiLauncher.openDeepSeek",
    "DeepSeek",
    "deepseek",
    TARGET_COMMANDS.deepseek
  );
  registerProviderLauncherCommand(
    context,
    tracker,
    "antigravityAiLauncher.openGrok",
    "Grok",
    "grok",
    TARGET_COMMANDS.grok
  );
  registerProviderLauncherCommand(
    context,
    tracker,
    "antigravityAiLauncher.openKimi",
    "Kimi Code",
    "kimi",
    TARGET_COMMANDS.kimi
  );
  registerProviderLauncherCommand(
    context,
    tracker,
    "antigravityAiLauncher.openClaude",
    "Claude Code in the sidebar",
    "claude",
    TARGET_COMMANDS.claudeSidebar
  );
  registerSidebarMaximizeCommand(context, tracker);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "antigravityAiLauncher.refreshQuota",
      () => quotaGauge.refresh(true, true)
    )
  );

  const launcherButtons = Object.fromEntries(
    Object.entries(LAUNCHER_BUTTONS).map(([provider, definition]) => [
      provider,
      createLauncherButton(context, definition, false)
    ])
  );
  createLauncherButton(context, SIDEBAR_MAXIMIZE_BUTTON);
  renderActiveLauncher(launcherButtons, tracker.state);
  const updateProviderAvailability = () => renderProviderAvailability(
    launcherButtons,
    (id) => vscode.extensions.getExtension(id)
  );
  updateProviderAvailability();
  context.subscriptions.push(
    tracker.onDidChange((state) => renderActiveLauncher(launcherButtons, state)),
    vscode.extensions.onDidChange(updateProviderAvailability)
  );

  quotaGauge.start();
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
