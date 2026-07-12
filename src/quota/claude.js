"use strict";

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { normalizeClaudeUsage } = require("./normalize");

const MEMORY_TTL_MS = 5 * 60 * 1000;
const SHARED_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

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
    fiveHour: {
      ...snapshot.fiveHour,
      resetAt: snapshot.fiveHour?.resetAt?.toISOString?.()
        || snapshot.fiveHour?.resetAt
    },
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
  const fiveHourResetAt = reviveDate(snapshot.fiveHour?.resetAt);
  const sevenDayResetAt = reviveDate(snapshot.sevenDay?.resetAt);
  if (!observedAt) {
    return undefined;
  }
  return {
    ...snapshot,
    observedAt,
    fiveHour: { ...snapshot.fiveHour, resetAt: fiveHourResetAt },
    sevenDay: { ...snapshot.sevenDay, resetAt: sevenDayResetAt }
  };
}

function readSharedCache(cachePath, maxAgeMs = SHARED_CACHE_MAX_AGE_MS) {
  try {
    const stat = fs.statSync(cachePath);
    if (Date.now() - stat.mtimeMs > maxAgeMs) {
      return undefined;
    }
    const payload = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return normalizeClaudeUsage(payload, new Date(stat.mtimeMs), "Claude shared usage cache");
  } catch {
    return undefined;
  }
}

function tokenFromCredentialsFile(claudeDirectory) {
  try {
    const credentials = JSON.parse(
      fs.readFileSync(path.join(claudeDirectory, ".credentials.json"), "utf8")
    );
    return credentials?.claudeAiOauth?.accessToken;
  } catch {
    return undefined;
  }
}

function tokenFromMacKeychain() {
  if (process.platform !== "darwin") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", timeout: 3000 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(stdout)?.claudeAiOauth?.accessToken);
        } catch {
          resolve(undefined);
        }
      }
    );
  });
}

function fetchUsage(token) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json"
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 1024 * 1024) {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          payload = undefined;
        }
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          payload
        });
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Claude usage request timed out.")));
    request.end();
  });
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(String(raw));
  if (!Number.isFinite(retryAt)) {
    return undefined;
  }
  const delay = retryAt - nowMs;
  return delay > 0 ? delay : undefined;
}

class ClaudeQuotaReader {
  constructor(options = {}) {
    this.claudeDirectory = options.claudeDirectory || path.join(os.homedir(), ".claude");
    this.sharedCachePath = options.sharedCachePath || path.join(os.tmpdir(), "claude_oauth_usage.json");
    this.now = options.now || Date.now;
    this.fetchUsage = options.fetchUsage || fetchUsage;
    this.readSharedCache = options.readSharedCache || readSharedCache;
    this.tokenProvider = options.tokenProvider || (async () => (
      tokenFromCredentialsFile(this.claudeDirectory) || await tokenFromMacKeychain()
    ));
    this.memoryTtlMs = options.memoryTtlMs ?? MEMORY_TTL_MS;
    this.sharedCacheMaxAgeMs = options.sharedCacheMaxAgeMs ?? SHARED_CACHE_MAX_AGE_MS;
    this.defaultBackoffMs = options.defaultBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.persistState = options.persistState || (async () => {});
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

    if (!options.force) {
      const shared = this.readSharedCache(
        this.sharedCachePath,
        this.sharedCacheMaxAgeMs
      );
      if (shared) {
        this.lastGood = shared;
        this.lastGoodAt = now;
        await this.persist();
        return shared;
      }
    }

    if (now < this.backoffUntil) {
      if (this.lastGood) {
        return { ...this.lastGood, stale: true };
      }
      throw new Error("Claude usage endpoint is rate-limited.");
    }

    if (!options.force && this.lastGood && now - this.lastGoodAt < this.memoryTtlMs) {
      return this.lastGood;
    }

    if (
      !options.force
      && this.lastAttemptAt > 0
      && now - this.lastAttemptAt < this.memoryTtlMs
    ) {
      if (this.lastGood) {
        return { ...this.lastGood, stale: true };
      }
      throw new Error(
        this.lastError || "Claude quota was refreshed recently; waiting before retrying."
      );
    }

    this.lastAttemptAt = now;
    await this.persist();
    let token;
    try {
      token = await this.tokenProvider();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.persist();
      throw error;
    }
    if (!token) {
      this.lastError = "Claude Code OAuth credentials were not found.";
      await this.persist();
      throw new Error(this.lastError);
    }

    let response;
    try {
      response = await this.fetchUsage(token);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.persist();
      if (this.lastGood) {
        return { ...this.lastGood, stale: true };
      }
      throw error;
    }

    if (response.statusCode === 429) {
      const retryAfterMs = parseRetryAfterMs(
        response.headers?.["retry-after"],
        now
      );
      const backoffMs = retryAfterMs ?? this.nextBackoffMs;
      this.backoffUntil = now + backoffMs;
      this.nextBackoffMs = Math.min(
        Math.max(this.defaultBackoffMs, backoffMs * 2),
        this.maxBackoffMs
      );
      this.lastError = "Claude usage endpoint is rate-limited.";
      await this.persist();
      if (this.lastGood) {
        return { ...this.lastGood, stale: true };
      }
      throw new Error(this.lastError);
    }

    if (response.statusCode !== 200) {
      this.lastError = `Claude usage endpoint returned HTTP ${response.statusCode}.`;
      await this.persist();
      if (this.lastGood) {
        return { ...this.lastGood, stale: true };
      }
      throw new Error(this.lastError);
    }

    let snapshot;
    try {
      snapshot = normalizeClaudeUsage(response.payload);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.persist();
      if (this.lastGood) {
        return { ...this.lastGood, stale: true };
      }
      throw error;
    }
    this.lastGood = snapshot;
    this.lastGoodAt = now;
    this.lastError = undefined;
    this.backoffUntil = 0;
    this.nextBackoffMs = this.defaultBackoffMs;
    await this.persist();
    return snapshot;
  }

  dispose() {}
}

module.exports = {
  ClaudeQuotaReader,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MEMORY_TTL_MS,
  SHARED_CACHE_MAX_AGE_MS,
  fetchUsage,
  parseRetryAfterMs,
  readSharedCache,
  reviveSnapshot,
  serializeSnapshot,
  tokenFromCredentialsFile,
  tokenFromMacKeychain
};
