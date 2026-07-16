"use strict";

const { spawn } = require("node:child_process");

const DEFAULT_ARGS = Object.freeze(["--sandbox", "off", "agent", "stdio"]);
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_STDOUT_BUFFER_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 750;

function errorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error || "Unknown error");
}

class GrokAcpClient {
  constructor(command, options = {}) {
    this.command = command;
    this.args = [...(options.args || DEFAULT_ARGS)];
    this.spawnImpl = options.spawnImpl || spawn;
    this.cwd = options.cwd;
    this.env = options.env || process.env;
    this.shell = options.shell;

    this.buffer = "";
    this.stderr = "";
    this.nextId = 1;
    this.pending = new Map();
    this.child = undefined;
    this.failure = undefined;
    this.disposed = false;
  }

  async start(timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.disposed) {
      throw new Error("Grok ACP client is disposed.");
    }
    if (this.child) {
      return;
    }

    let child;
    try {
      const spawnOptions = {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env
      };
      if (this.cwd !== undefined) {
        spawnOptions.cwd = this.cwd;
      }
      if (this.shell !== undefined) {
        spawnOptions.shell = this.shell;
      }
      child = this.spawnImpl(this.command, this.args, spawnOptions);
    } catch (error) {
      throw new Error(`Failed to start Grok ACP: ${errorMessage(error)}`, {
        cause: error
      });
    }

    if (!child?.stdin || !child?.stdout) {
      try {
        child?.kill?.();
      } catch {
        // The malformed child is already unusable.
      }
      throw new Error("Failed to start Grok ACP: child process has no stdio pipes.");
    }

    this.child = child;
    child.stdout.on("data", (chunk) => this.handleData(chunk));
    child.stderr?.on("data", (chunk) => {
      // Keep diagnostics bounded in case the CLI becomes noisy.
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8192);
    });
    child.once("error", (error) => {
      this.fail(new Error(`Grok ACP process error: ${errorMessage(error)}`, {
        cause: error
      }), child);
    });
    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      const diagnostic = this.stderr.trim();
      this.fail(new Error(
        `Grok ACP exited (${detail})${diagnostic ? `: ${diagnostic}` : "."}`
      ), child);
    });

    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false
        },
        terminal: false
      }
    }, timeoutMs);
  }

  async readBilling(timeoutMs = DEFAULT_TIMEOUT_MS) {
    try {
      await this.start(timeoutMs);
      return await this.request("_x.ai/billing", {}, timeoutMs);
    } finally {
      this.dispose();
    }
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.disposed) {
      return Promise.reject(new Error("Grok ACP client is disposed."));
    }
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("Grok ACP is unavailable."));
    }

    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `Grok ACP request '${method}' timed out after ${timeoutMs}ms.`
        ));
      }, timeoutMs);

      const settle = (callback, value) => {
        clearTimeout(timer);
        callback(value);
      };
      this.pending.set(id, {
        method,
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error)
      });

      const onWrite = (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(new Error(
          `Failed to write Grok ACP request '${method}': ${errorMessage(error)}`,
          { cause: error }
        ));
      };

      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`, onWrite);
      } catch (error) {
        onWrite(error);
      }
    });
  }

  handleData(chunk) {
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_STDOUT_BUFFER_BYTES) {
      this.buffer = "";
      this.fail(new Error("Grok ACP stdout exceeded the 1 MiB line limit."));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }

      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // ACP notifications and responses remain parseable even if the CLI
        // happens to emit an unrelated diagnostic line on stdout.
        continue;
      }

      if (message.id === undefined || message.id === null) {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      this.pending.delete(message.id);

      if (message.error) {
        const code = message.error.code === undefined
          ? ""
          : ` (${message.error.code})`;
        pending.reject(new Error(
          `Grok ACP request '${pending.method}' failed${code}: ${
            message.error.message || "Unknown RPC error"
          }`
        ));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  fail(error, child = this.child) {
    if (child !== this.child) {
      return;
    }
    this.failure = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const child = this.child;
    this.child = undefined;
    const error = new Error("Grok ACP client disposed.");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();

    try {
      child?.stdin?.end?.();
    } catch {
      // Best-effort shutdown; kill below is authoritative.
    }
    if (
      child
      && !child.killed
      && child.exitCode == null
      && child.signalCode == null
    ) {
      try {
        child.kill();
        const hardKillTimer = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) {
            try {
              child.kill("SIGKILL");
            } catch {
              // The process may already have exited between the checks.
            }
          }
        }, KILL_GRACE_MS);
        hardKillTimer.unref?.();
        child.once?.("exit", () => clearTimeout(hardKillTimer));
      } catch {
        // Disposal must remain idempotent even if process cleanup races exit.
      }
    }
  }
}

module.exports = {
  DEFAULT_ARGS,
  DEFAULT_TIMEOUT_MS,
  KILL_GRACE_MS,
  MAX_STDOUT_BUFFER_BYTES,
  GrokAcpClient
};
