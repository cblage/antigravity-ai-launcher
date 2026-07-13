"use strict";

const { spawn } = require("node:child_process");
const { version: EXTENSION_VERSION } = require("../../package.json");

class CodexAppServer {
  constructor(command) {
    this.command = command;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
  }

  async start(timeoutMs = 12000) {
    if (this.child && !this.child.killed) {
      return;
    }

    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: process.env
    });
    this.child = child;
    child.stdout.on("data", (chunk) => this.handleData(chunk));
    child.on("error", (error) => this.fail(error));
    child.on("exit", () => this.fail(new Error("Codex app-server stopped.")));

    await this.request("initialize", {
      clientInfo: {
        name: "antigravity-ai-launcher",
        title: "Antigravity AI Launcher",
        version: EXTENSION_VERSION
      },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: []
      }
    }, timeoutMs);
  }

  async readRateLimits(timeoutMs = 12000) {
    await this.start(timeoutMs);
    return this.request("account/rateLimits/read", undefined, timeoutMs);
  }

  request(method, params, timeoutMs) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("Codex app-server is unavailable."));
    }

    const id = this.nextId++;
    const message = { id, method };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          const pending = this.pending.get(id);
          this.pending.delete(id);
          pending?.reject(error);
        }
      });
    });
  }

  handleData(chunk) {
    this.buffer += chunk.toString("utf8");
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
        continue;
      }
      if (message.id === undefined) {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Codex request failed."));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.child = undefined;
  }

  dispose() {
    const child = this.child;
    this.fail(new Error("Codex app-server disposed."));
    child?.kill();
  }
}

module.exports = { CodexAppServer };
