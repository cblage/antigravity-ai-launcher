"use strict";

const { normalizeKimiManagedUsage } = require("./normalize");

const KIMI_EXTENSION_ID = "moonshot-ai.kimi-code";
const KIMI_USAGE_COMMAND = "_kimi.getManagedUsage";
const KIMI_USAGE_SCHEMA_VERSION = 1;
const MEMORY_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

class KimiQuotaReader {
  constructor(options = {}) {
    this.getExtension = options.getExtension || (() => undefined);
    this.getCommands = options.getCommands || (async () => []);
    this.executeCommand = options.executeCommand || (async () => undefined);
    this.now = options.now || Date.now;
    this.memoryTtlMs = options.memoryTtlMs ?? MEMORY_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.lastGood = undefined;
    this.lastGoodAt = 0;
  }

  async read(options = {}) {
    const now = this.now();
    if (
      !options.force
      && this.lastGood
      && now - this.lastGoodAt < this.memoryTtlMs
    ) {
      return this.lastGood;
    }

    if (!this.getExtension(KIMI_EXTENSION_ID)) {
      throw new Error("Kimi Code is not installed.");
    }

    const commands = await this.getCommands();
    if (!commands.includes(KIMI_USAGE_COMMAND)) {
      throw new Error(
        "Installed Kimi Code does not expose quota data. Update Kimi Code to the matching launcher-compatible build."
      );
    }

    const payload = await withTimeout(
      Promise.resolve(this.executeCommand(KIMI_USAGE_COMMAND)),
      this.timeoutMs
    );
    validateBridgePayload(payload);
    if (payload.kind === "error") {
      throw new Error(providerErrorMessage(payload));
    }

    const snapshot = normalizeKimiManagedUsage(payload);
    this.lastGood = snapshot;
    this.lastGoodAt = now;
    return snapshot;
  }

  dispose() {
    this.lastGood = undefined;
    this.lastGoodAt = 0;
  }
}

function validateBridgePayload(payload) {
  if (payload?.schemaVersion !== KIMI_USAGE_SCHEMA_VERSION) {
    throw new Error(
      "Kimi quota bridge is incompatible. Update Kimi Code and Antigravity AI Launcher together."
    );
  }
  if (payload.kind !== "ok" && payload.kind !== "error") {
    throw new Error(
      "Kimi quota bridge returned an invalid response. Update Kimi Code and Antigravity AI Launcher together."
    );
  }
}

function providerErrorMessage(payload) {
  if (payload.status === 401) {
    return "Kimi quota unavailable: sign in to Kimi Code.";
  }
  if (payload.status === 404) {
    return "Kimi managed usage is unavailable for the current service.";
  }
  const detail = typeof payload.message === "string" && payload.message.length > 0
    ? payload.message
    : "unknown provider error";
  return `Kimi quota unavailable: ${detail}`;
}

function withTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Kimi quota request timed out.")),
      timeoutMs
    );
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  KIMI_EXTENSION_ID,
  KIMI_USAGE_COMMAND,
  KIMI_USAGE_SCHEMA_VERSION,
  KimiQuotaReader,
  MEMORY_TTL_MS,
  REQUEST_TIMEOUT_MS,
  providerErrorMessage,
  validateBridgePayload,
  withTimeout
};
