"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexAppServer } = require("./codexAppServer");
const {
  normalizeCodexRateLimits,
  normalizeCodexSessionEvent
} = require("./normalize");

const SESSION_TAIL_BYTES = 2 * 1024 * 1024;
const SESSION_FILE_LIMIT = 120;

function expandHome(value) {
  if (value === "~") {
    return os.homedir();
  }
  if (value?.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function defaultCodexCommand(configured) {
  if (configured?.trim()) {
    return expandHome(configured.trim());
  }
  const appBinary = "/Applications/Codex.app/Contents/Resources/codex";
  return process.platform === "darwin" && fs.existsSync(appBinary)
    ? appBinary
    : "codex";
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function listSessionFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function readSessionTail(filePath) {
  const stat = safeStat(filePath);
  if (!stat?.size) {
    return undefined;
  }
  const start = Math.max(0, stat.size - SESSION_TAIL_BYTES);
  const length = stat.size - start;
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const snapshot = normalizeCodexSessionEvent(JSON.parse(lines[index]));
        if (snapshot) {
          return snapshot;
        }
      } catch {
        // Keep scanning older events.
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return undefined;
}

function readLatestSessionQuota(codexHome = path.join(os.homedir(), ".codex")) {
  const root = path.join(codexHome, "sessions");
  const files = listSessionFiles(root)
    .map((filePath) => ({ filePath, mtimeMs: safeStat(filePath)?.mtimeMs || 0 }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, SESSION_FILE_LIMIT);

  for (const file of files) {
    const snapshot = readSessionTail(file.filePath);
    if (snapshot) {
      return snapshot;
    }
  }
  return undefined;
}

class CodexQuotaReader {
  constructor(options = {}) {
    this.getConfiguredCommand = options.getConfiguredCommand || (() => undefined);
    this.codexHome = options.codexHome || path.join(os.homedir(), ".codex");
    this.timeoutMs = options.timeoutMs || 12000;
  }

  async read() {
    const command = defaultCodexCommand(this.getConfiguredCommand());
    if (!this.client || this.command !== command) {
      this.client?.dispose();
      this.command = command;
      this.client = new CodexAppServer(command);
    }

    try {
      const response = await this.client.readRateLimits(this.timeoutMs);
      return normalizeCodexRateLimits(response);
    } catch (realtimeError) {
      this.client.dispose();
      this.client = undefined;
      const fallback = readLatestSessionQuota(this.codexHome);
      if (fallback) {
        return fallback;
      }
      throw new Error(`Codex quota unavailable: ${realtimeError.message}`);
    }
  }

  dispose() {
    this.client?.dispose();
    this.client = undefined;
  }
}

module.exports = {
  CodexQuotaReader,
  defaultCodexCommand,
  readLatestSessionQuota,
  readSessionTail
};
