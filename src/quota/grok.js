"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GrokAcpClient } = require("./grokAcp");
const { normalizeGrokBilling } = require("./normalize");

const MEMORY_TTL_MS = 5 * 60 * 1000;
const FAILURE_RETRY_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

function expandHome(value, homeDirectory = os.homedir()) {
  if (value === "~") {
    return homeDirectory;
  }
  if (value?.startsWith("~/")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
}

function defaultGrokCommand(configured, options = {}) {
  const homeDirectory = options.homeDirectory || os.homedir();
  if (configured?.trim()) {
    return expandHome(configured.trim(), homeDirectory);
  }
  const userBinary = path.join(homeDirectory, ".grok", "bin", "grok");
  try {
    fs.accessSync(userBinary, fs.constants.X_OK);
    return userBinary;
  } catch {
    return "grok";
  }
}

function reviveDate(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function serializeSnapshot(snapshot) {
  if (!snapshot) {
    return undefined;
  }
  return {
    ...snapshot,
    observedAt: snapshot.observedAt?.toISOString?.() || snapshot.observedAt,
    sevenDay: {
      ...snapshot.sevenDay,
      resetAt: snapshot.sevenDay?.resetAt?.toISOString?.()
        || snapshot.sevenDay?.resetAt
    }
  };
}

function reviveSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const observedAt = reviveDate(snapshot.observedAt);
  const resetAt = reviveDate(snapshot.sevenDay?.resetAt);
  if (!observedAt || !resetAt || snapshot.provider !== "grok") {
    return undefined;
  }
  return {
    ...snapshot,
    observedAt,
    sevenDay: { ...snapshot.sevenDay, resetAt }
  };
}

function isCurrentSnapshot(snapshot, nowMs) {
  const resetAt = snapshot?.sevenDay?.resetAt;
  return resetAt instanceof Date
    && !Number.isNaN(resetAt.getTime())
    && resetAt.getTime() > nowMs;
}

function isRateLimitError(error) {
  return /(?:\b429\b|rate.?limit|too many requests)/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

class GrokQuotaReader {
  constructor(options = {}) {
    this.getConfiguredCommand = options.getConfiguredCommand || (() => undefined);
    this.homeDirectory = options.homeDirectory || os.homedir();
    this.now = options.now || Date.now;
    this.memoryTtlMs = options.memoryTtlMs ?? MEMORY_TTL_MS;
    this.failureRetryMs = options.failureRetryMs ?? FAILURE_RETRY_MS;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.defaultBackoffMs = options.defaultBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.persistState = options.persistState || (async () => {});
    this.createClient = options.createClient || ((command) => (
      new GrokAcpClient(command, { cwd: this.homeDirectory })
    ));

    const persisted = options.persistedState || {};
    this.lastGood = reviveSnapshot(persisted.lastGood);
    this.lastGoodAt = Number.isFinite(persisted.lastGoodAt)
      ? persisted.lastGoodAt
      : 0;
    this.lastAttemptAt = Number.isFinite(persisted.lastAttemptAt)
      ? persisted.lastAttemptAt
      : 0;
    this.lastError = typeof persisted.lastError === "string"
      ? persisted.lastError
      : undefined;
    this.backoffUntil = Number.isFinite(persisted.backoffUntil)
      ? persisted.backoffUntil
      : 0;
    this.nextBackoffMs = Number.isFinite(persisted.nextBackoffMs)
      ? Math.min(
          Math.max(this.defaultBackoffMs, persisted.nextBackoffMs),
          this.maxBackoffMs
        )
      : this.defaultBackoffMs;
  }

  async persist() {
    try {
      await this.persistState({
        version: 1,
        lastGood: serializeSnapshot(this.lastGood),
        lastGoodAt: this.lastGoodAt,
        lastAttemptAt: this.lastAttemptAt,
        lastError: this.lastError,
        backoffUntil: this.backoffUntil,
        nextBackoffMs: this.nextBackoffMs
      });
    } catch {
      // Quota loading must continue even if extension state cannot be written.
    }
  }

  async read(options = {}) {
    const now = this.now();
    const hasCurrentLastGood = isCurrentSnapshot(this.lastGood, now);
    if (now < this.backoffUntil) {
      if (hasCurrentLastGood) {
        return { ...this.lastGood, stale: true };
      }
      throw new Error(this.lastError || "Grok billing is rate-limited.");
    }
    if (
      !options.force
      && hasCurrentLastGood
      && now - this.lastGoodAt < this.memoryTtlMs
    ) {
      return this.lastGood;
    }
    if (
      !options.force
      && this.lastAttemptAt > 0
      && now - this.lastAttemptAt < this.failureRetryMs
    ) {
      if (hasCurrentLastGood) {
        return { ...this.lastGood, stale: true };
      }
      throw new Error(
        this.lastError || "Grok quota was refreshed recently; waiting before retrying."
      );
    }

    this.lastAttemptAt = now;
    await this.persist();
    const command = defaultGrokCommand(this.getConfiguredCommand(), {
      homeDirectory: this.homeDirectory
    });
    const client = this.createClient(command);
    this.client = client;
    try {
      const payload = await client.readBilling(this.timeoutMs);
      const snapshot = normalizeGrokBilling(payload, new Date(now));
      this.lastGood = snapshot;
      this.lastGoodAt = now;
      this.lastError = undefined;
      this.backoffUntil = 0;
      this.nextBackoffMs = this.defaultBackoffMs;
      await this.persist();
      return snapshot;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastError = `Grok quota unavailable: ${detail}`;
      if (isRateLimitError(error)) {
        this.backoffUntil = now + this.nextBackoffMs;
        this.nextBackoffMs = Math.min(
          this.nextBackoffMs * 2,
          this.maxBackoffMs
        );
      }
      await this.persist();
      if (isCurrentSnapshot(this.lastGood, this.now())) {
        return { ...this.lastGood, stale: true };
      }
      throw new Error(this.lastError);
    } finally {
      client.dispose();
      if (this.client === client) {
        this.client = undefined;
      }
    }
  }

  dispose() {
    this.client?.dispose();
    this.client = undefined;
  }
}

module.exports = {
  DEFAULT_BACKOFF_MS,
  FAILURE_RETRY_MS,
  GrokQuotaReader,
  MAX_BACKOFF_MS,
  MEMORY_TTL_MS,
  REQUEST_TIMEOUT_MS,
  defaultGrokCommand,
  expandHome,
  isCurrentSnapshot,
  isRateLimitError,
  reviveSnapshot,
  serializeSnapshot
};
