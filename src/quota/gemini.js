"use strict";

const http = require("node:http");
const https = require("node:https");
const { execFile } = require("node:child_process");
const { normalizeGeminiQuotaResponse } = require("./normalize");

const QUOTA_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const REQUEST_TIMEOUT_MS = 5000;

function runFile(command, args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

function parseLanguageServers(output) {
  const candidates = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const command = match[2];
    if (
      !/\/extensions\/antigravity\/bin\/language_server_macos/.test(command) ||
      !/--app_data_dir(?:=|\s+)antigravity-ide/.test(command)
    ) {
      continue;
    }
    const token = command.match(
      /--csrf_token(?:=|\s+)["']?([A-Za-z0-9_.-]+)["']?/
    )?.[1];
    const advertisedPort = Number(command.match(
      /--extension_server_port(?:=|\s+)(\d+)/
    )?.[1]);
    const workspaceId = command.match(
      /--workspace_id(?:=|\s+)["']?([A-Za-z0-9_.-]+)["']?/
    )?.[1];
    if (token) {
      candidates.push({
        pid: Number(match[1]),
        token,
        advertisedPort: Number.isFinite(advertisedPort) ? advertisedPort : undefined,
        workspaceId
      });
    }
  }
  return candidates;
}

function workspaceIdForPath(filePath) {
  return `file${filePath.replace(/[^A-Za-z0-9]/g, "_")}`;
}

function orderForWorkspace(candidates, workspacePaths = []) {
  const wanted = new Set(workspacePaths.map(workspaceIdForPath));
  return [...candidates].sort((left, right) => {
    const leftScore = wanted.has(left.workspaceId) ? 0 : left.workspaceId ? 1 : 2;
    const rightScore = wanted.has(right.workspaceId) ? 0 : right.workspaceId ? 1 : 2;
    return leftScore - rightScore;
  });
}

async function listeningPorts(candidate) {
  const ports = new Set();
  if (candidate.advertisedPort) {
    ports.add(candidate.advertisedPort);
  }
  try {
    const output = await runFile("/usr/sbin/lsof", [
      "-nP",
      "-a",
      "-iTCP",
      "-sTCP:LISTEN",
      "-p",
      String(candidate.pid)
    ]);
    for (const match of output.matchAll(/TCP [^:]+:(\d+) \(LISTEN\)/g)) {
      ports.add(Number(match[1]));
    }
  } catch {
    // The advertised port is retained as a final fallback.
  }
  return [...ports];
}

function requestQuota(connection, forceRefresh) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ request: {}, forceRefresh: Boolean(forceRefresh) });
    const client = connection.protocol === "https" ? https : http;
    const request = client.request({
      hostname: "127.0.0.1",
      port: connection.port,
      path: QUOTA_PATH,
      method: "POST",
      rejectUnauthorized: false,
      headers: {
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Codeium-Csrf-Token": connection.token
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
      response.on("end", () => resolve({
        statusCode: response.statusCode || 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Antigravity quota request timed out.")));
    request.end(body);
  });
}

async function tryConnection(connection, forceRefresh) {
  const response = await requestQuota(connection, forceRefresh);
  if (response.statusCode !== 200) {
    throw new Error(`Antigravity quota endpoint returned HTTP ${response.statusCode}.`);
  }
  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error("Antigravity quota endpoint returned invalid JSON.");
  }
  return normalizeGeminiQuotaResponse(payload);
}

class GeminiQuotaReader {
  constructor(options = {}) {
    this.workspacePaths = options.workspacePaths || [];
  }

  async read(options = {}) {
    if (this.connection) {
      try {
        return await tryConnection(this.connection, options.force);
      } catch {
        this.connection = undefined;
      }
    }

    let processOutput;
    try {
      processOutput = await runFile("/bin/ps", ["-axo", "pid=,command="], 5000);
    } catch {
      throw new Error("Could not inspect the local Antigravity language server.");
    }
    const candidates = orderForWorkspace(
      parseLanguageServers(processOutput),
      this.workspacePaths
    );
    if (!candidates.length) {
      throw new Error("No local Antigravity language server was found.");
    }

    for (const candidate of candidates) {
      const ports = await listeningPorts(candidate);
      for (const port of ports) {
        for (const protocol of ["https", "http"]) {
          const connection = {
            pid: candidate.pid,
            port,
            protocol,
            token: candidate.token
          };
          try {
            const snapshot = await tryConnection(connection, options.force);
            this.connection = connection;
            return snapshot;
          } catch {
            // Continue until the authenticated endpoint is found.
          }
        }
      }
    }

    throw new Error("Antigravity's quota endpoint could not be reached.");
  }

  dispose() {
    this.connection = undefined;
  }
}

module.exports = {
  GeminiQuotaReader,
  listeningPorts,
  orderForWorkspace,
  parseLanguageServers,
  requestQuota,
  workspaceIdForPath
};
