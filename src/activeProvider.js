"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ACTIVE_PANEL_KEY = "workbench.auxiliarybar.activepanelid";
const HIDDEN_KEY = "workbench.auxiliaryBar.hidden";
const FALLBACK_REFRESH_INTERVAL_MS = 2000;
const OPEN_STATE_GRACE_MS = 1100;
const CLOSE_STATE_GRACE_MS = OPEN_STATE_GRACE_MS;
const STATE_POLL_INTERVAL_MS = 40;
const PANEL_TO_PROVIDER = Object.freeze({
  "antigravity.agentViewContainerId": "gemini",
  "workbench.view.extension.codexSecondaryViewContainer": "codex",
  "workbench.view.extension.claude-sidebar-secondary": "claude",
  "workbench.view.extension.cblage-codewhale": "deepseek",
  "workbench.view.extension.grokSidebar": "grok",
  "workbench.view.extension.kimi-secondary-sidebar": "kimi"
});

const QUERY = [
  "SELECT key || char(9) || value",
  "FROM ItemTable",
  `WHERE key IN ('${ACTIVE_PANEL_KEY}', '${HIDDEN_KEY}')`,
  "ORDER BY key;"
].join(" ");

function providerFromPanelId(panelId) {
  return PANEL_TO_PROVIDER[panelId];
}

function isProviderActive(state, provider) {
  return Boolean(
    state?.sidebarVisible
    && state.recognizedPanel !== false
    && state.provider === provider
  );
}

function parseSqliteSnapshot(
  output,
  fallbackProvider = "gemini",
  fallbackSidebarVisible = false,
  fallbackRecognizedPanel = false
) {
  const values = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const separator = line.indexOf("\t");
    if (separator > 0) {
      values.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }

  const hasPanel = values.has(ACTIVE_PANEL_KEY);
  const selected = providerFromPanelId(values.get(ACTIVE_PANEL_KEY));
  const hiddenValue = values.get(HIDDEN_KEY);
  const hasHidden = hiddenValue === "true" || hiddenValue === "false";
  return {
    state: {
      provider: selected || fallbackProvider,
      sidebarVisible: hasHidden
        ? hiddenValue === "false"
        : fallbackSidebarVisible,
      recognizedPanel: hasPanel
        ? Boolean(selected)
        : fallbackRecognizedPanel
    },
    persistedHidden: hasHidden ? hiddenValue === "true" : undefined,
    persistedProvider: hasPanel ? selected : undefined
  };
}

function parseSqliteOutput(
  output,
  fallbackProvider = "gemini",
  fallbackSidebarVisible = false,
  fallbackRecognizedPanel = false
) {
  return parseSqliteSnapshot(
    output,
    fallbackProvider,
    fallbackSidebarVisible,
    fallbackRecognizedPanel
  ).state;
}

function findNearbyDatabase(storagePath) {
  let current = storagePath;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const candidate = path.join(current, "state.vscdb");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

function findWorkspaceDatabase(context, workspaceFolders = []) {
  const fromStorageUri = context.storageUri?.fsPath
    ? findNearbyDatabase(context.storageUri.fsPath)
    : undefined;
  if (fromStorageUri) {
    return fromStorageUri;
  }

  const globalPath = context.globalStorageUri?.fsPath;
  if (!globalPath) {
    return undefined;
  }
  const userDirectory = path.dirname(path.dirname(globalPath));
  const workspaceStorage = path.join(userDirectory, "workspaceStorage");
  const wantedUris = new Set(workspaceFolders.map((folder) => folder.uri.toString()));

  let directories;
  try {
    directories = fs.readdirSync(workspaceStorage, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const matches = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) {
      continue;
    }
    const root = path.join(workspaceStorage, directory.name);
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(root, "workspace.json"), "utf8"));
      if (wantedUris.has(metadata.folder) || wantedUris.has(metadata.workspace)) {
        const database = path.join(root, "state.vscdb");
        const stat = fs.statSync(database);
        matches.push({ database, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Ignore stale/incomplete workspace-storage entries.
    }
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0]?.database;
}

function readWorkspaceState(databasePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/sqlite3",
      ["-readonly", databasePath, QUERY],
      { encoding: "utf8", timeout: 2000 },
      (error, stdout) => error ? reject(error) : resolve(stdout)
    );
  });
}

function readStorageSignature(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return "missing";
      }
    })
    .join("|");
}

class ActiveProviderTracker {
  constructor(databasePath, fallbackProvider = "gemini", options = {}) {
    this.databasePath = databasePath;
    this.readState = options.readWorkspaceState || readWorkspaceState;
    this.readStorageSignature = options.readStorageSignature
      || readStorageSignature;
    this.now = options.now || Date.now;
    this.openStateGraceMs = options.openStateGraceMs ?? OPEN_STATE_GRACE_MS;
    this.closeStateGraceMs = options.closeStateGraceMs ?? CLOSE_STATE_GRACE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? STATE_POLL_INTERVAL_MS;
    this.fallbackRefreshIntervalMs = options.fallbackRefreshIntervalMs
      ?? FALLBACK_REFRESH_INTERVAL_MS;
    this.state = {
      provider: fallbackProvider,
      // Stay neutral until the first persisted-state read completes. This also
      // prevents restored status items from flashing active during cold start.
      sidebarVisible: false,
      recognizedPanel: false
    };
    this.listeners = new Set();
    this.stateGeneration = 0;
    this.lastRefreshAt = 0;
    this.suppressPersistedUntil = 0;
    this.graceReconciliationPending = false;
    this.awaitingVisibleProvider = undefined;
    this.awaitingHiddenConfirmation = false;
    this.liveProviderStates = new Map();
    this.refreshQueued = false;
    this.disposed = false;
  }

  onDidChange(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  start() {
    if (this.databasePath) {
      this.lastStorageSignature = this.readStorageSignature(this.databasePath);
    }
    this.interval = setInterval(
      () => void this.pollPersistedState(),
      this.pollIntervalMs
    );
    this.interval.unref?.();
  }

  pollPersistedState() {
    if (!this.databasePath || this.disposed) {
      return Promise.resolve(this.state);
    }

    const now = this.now();
    const signature = this.readStorageSignature(this.databasePath);
    const storageChanged = signature !== this.lastStorageSignature;
    this.lastStorageSignature = signature;

    if (now < this.suppressPersistedUntil) {
      return Promise.resolve(this.state);
    }

    const graceEnded = this.graceReconciliationPending;
    this.graceReconciliationPending = false;
    const fallbackDue = now - this.lastRefreshAt >= this.fallbackRefreshIntervalMs;
    if (
      graceEnded
      || this.awaitingVisibleProvider
      || this.awaitingHiddenConfirmation
      || storageChanged
      || fallbackDue
    ) {
      return this.refresh();
    }
    return Promise.resolve(this.state);
  }

  refresh() {
    if (!this.databasePath || this.disposed || this.now() < this.suppressPersistedUntil) {
      return Promise.resolve(this.state);
    }
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }

    const generation = this.stateGeneration;
    const operation = this.performRefresh(generation);
    this.refreshInFlight = operation;
    void operation.then(() => {
      if (this.refreshInFlight !== operation) {
        return;
      }
      this.refreshInFlight = undefined;
      if (this.refreshQueued && !this.disposed) {
        this.refreshQueued = false;
        void this.refresh();
      }
    });
    return operation;
  }

  async performRefresh(generation) {
    try {
      const output = await this.readState(this.databasePath);
      if (generation !== this.stateGeneration) {
        return this.state;
      }
      this.lastRefreshAt = this.now();
      const parsed = parseSqliteSnapshot(
        output,
        this.state.provider,
        this.state.sidebarVisible,
        this.state.recognizedPanel
      );
      let next = parsed.state;
      const liveVisibleProvider = [...this.liveProviderStates.entries()]
        .find(([, live]) => live.generation === generation && live.visible)?.[0];
      if (liveVisibleProvider) {
        // A live workbench visibility probe is newer and more authoritative
        // than delayed SQLite persistence.
        next = {
          provider: liveVisibleProvider,
          sidebarVisible: true,
          recognizedPanel: true
        };
      } else {
        const live = this.liveProviderStates.get(next.provider);
        if (live?.generation === generation && live.visible === false) {
          next = { ...next, sidebarVisible: false };
        }
      }
      if (this.awaitingVisibleProvider) {
        const awaitedProvider = this.awaitingVisibleProvider;
        const live = this.liveProviderStates.get(awaitedProvider);
        if (live?.generation === generation) {
          // Once grace has elapsed, the latest exact workbench sample wins
          // even if an entire open/close happened between two 40 ms probes.
          this.awaitingVisibleProvider = undefined;
          next = {
            provider: awaitedProvider,
            sidebarVisible: live.visible,
            recognizedPanel: true
          };
        } else {
          const visibleProviderConfirmed = parsed.persistedHidden === false
            && parsed.persistedProvider === awaitedProvider;
          if (!visibleProviderConfirmed) {
            // Opening persistence can trail the workbench UI beyond the grace
            // deadline. Ignore stale hidden and incomplete snapshots until the
            // exact requested visible view has been committed.
            return this.state;
          }
          this.awaitingVisibleProvider = undefined;
        }
      }
      if (this.awaitingHiddenConfirmation) {
        if (liveVisibleProvider) {
          // The close command did not take effect: restore the exact live view
          // only after the close grace has protected the optimistic state.
          this.awaitingHiddenConfirmation = false;
          next = {
            provider: liveVisibleProvider,
            sidebarVisible: true,
            recognizedPanel: true
          };
        } else {
          const live = this.liveProviderStates.get(this.state.provider);
          if (live?.generation === generation && live.visible === false) {
            this.awaitingHiddenConfirmation = false;
            next = { ...next, sidebarVisible: false };
          } else {
            if (parsed.persistedHidden !== true) {
              // Workspace-state persistence can lag an explicit close well
              // beyond grace. Never replay a stale or incomplete snapshot.
              return this.state;
            }
            this.awaitingHiddenConfirmation = false;
          }
        }
      }
      this.update(next);
    } catch {
      // An IDE write can briefly lock/replace the database. Keep last good state.
    }
    return this.state;
  }

  applyLiveVisibility(provider, visible, generation = this.stateGeneration) {
    if (generation !== this.stateGeneration || this.disposed) {
      return this.state;
    }

    const withinGrace = this.now() < this.suppressPersistedUntil;

    if (visible) {
      if (
        this.awaitingVisibleProvider
        && this.awaitingVisibleProvider !== provider
      ) {
        // A newer intent is opening a different provider.
        return this.state;
      }

      this.liveProviderStates.set(provider, {
        generation,
        visible: true
      });
      if (this.awaitingHiddenConfirmation && withinGrace) {
        // Cache the contradictory exact state, but protect the synchronous
        // close intent until its grace expires.
        return this.state;
      }
      if (this.awaitingHiddenConfirmation) {
        this.awaitingHiddenConfirmation = false;
      }
      if (this.awaitingVisibleProvider === provider) {
        this.awaitingVisibleProvider = undefined;
      }
      this.update({
        provider,
        sidebarVisible: true,
        recognizedPanel: true
      });
      return this.state;
    }

    this.liveProviderStates.set(provider, {
      generation,
      visible: false
    });
    if (this.awaitingVisibleProvider === provider && withinGrace) {
      // Cache a pre-open false so it can resolve the intent at the deadline,
      // but do not flash white while the open command reaches the workbench.
      return this.state;
    }
    if (this.awaitingVisibleProvider === provider) {
      this.awaitingVisibleProvider = undefined;
    }
    if (this.state.provider === provider) {
      this.awaitingHiddenConfirmation = false;
      this.update({ ...this.state, sidebarVisible: false });
    }
    return this.state;
  }

  setOptimistic(provider) {
    // A newer open intent replaces any pending close confirmation.
    this.awaitingHiddenConfirmation = false;
    this.awaitingVisibleProvider = provider;
    this.restartGracePeriod(this.openStateGraceMs);
    this.update({
      ...this.state,
      provider,
      sidebarVisible: true,
      recognizedPanel: true
    });
    return this.stateGeneration;
  }

  setOptimisticHidden() {
    // Keep the explicit close authoritative until persistence confirms hidden.
    this.awaitingVisibleProvider = undefined;
    this.awaitingHiddenConfirmation = true;
    this.restartGracePeriod(this.closeStateGraceMs);
    this.update({ ...this.state, sidebarVisible: false });
    return this.stateGeneration;
  }

  cancelIntent(generation, fallbackState) {
    if (generation !== this.stateGeneration) {
      return;
    }
    this.stateGeneration += 1;
    this.awaitingVisibleProvider = undefined;
    this.awaitingHiddenConfirmation = false;
    this.suppressPersistedUntil = 0;
    this.graceReconciliationPending = false;
    this.refreshQueued = false;
    this.update(fallbackState);
    void this.refresh();
  }

  restartGracePeriod(durationMs) {
    // Every new intent replaces the previous grace and invalidates its reads.
    this.stateGeneration += 1;
    this.suppressPersistedUntil = this.now() + durationMs;
    this.graceReconciliationPending = true;
    this.refreshQueued = false;
  }

  update(next) {
    const changed =
      next.provider !== this.state.provider ||
      next.sidebarVisible !== this.state.sidebarVisible ||
      next.recognizedPanel !== this.state.recognizedPanel;
    this.state = next;
    if (changed) {
      for (const listener of this.listeners) {
        listener(this.state);
      }
    }
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.interval);
    this.awaitingVisibleProvider = undefined;
    this.awaitingHiddenConfirmation = false;
    this.liveProviderStates.clear();
    this.refreshQueued = false;
    this.listeners.clear();
  }
}

module.exports = {
  ACTIVE_PANEL_KEY,
  CLOSE_STATE_GRACE_MS,
  FALLBACK_REFRESH_INTERVAL_MS,
  HIDDEN_KEY,
  OPEN_STATE_GRACE_MS,
  PANEL_TO_PROVIDER,
  ActiveProviderTracker,
  STATE_POLL_INTERVAL_MS,
  findWorkspaceDatabase,
  isProviderActive,
  parseSqliteOutput,
  providerFromPanelId,
  readStorageSignature,
  readWorkspaceState
};
