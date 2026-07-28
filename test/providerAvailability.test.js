"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PROVIDER_EXTENSION_IDS,
  isProviderAvailable,
  renderProviderAvailability
} = require("../src/providerAvailability");

test("maps optional providers to their exact extension identifiers", () => {
  assert.deepEqual(PROVIDER_EXTENSION_IDS, {
    claude: "anthropic.claude-code",
    codex: "openai.chatgpt",
    deepseek: "cblage.codewhale-vscode",
    grok: "pawelhuryn.grok-vscode-phuryn",
    kimi: "moonshot-ai.kimi-code"
  });
});

test("Antigravity remains available without a separate extension", () => {
  assert.equal(isProviderAvailable("gemini", () => undefined), true);
});

test("optional providers require an installed and enabled extension", () => {
  const installed = new Set([
    "anthropic.claude-code",
    "openai.chatgpt"
  ]);
  const getExtension = (id) => installed.has(id) ? { id } : undefined;

  assert.equal(isProviderAvailable("claude", getExtension), true);
  assert.equal(isProviderAvailable("codex", getExtension), true);
  assert.equal(isProviderAvailable("deepseek", getExtension), false);
  assert.equal(isProviderAvailable("grok", getExtension), false);
  assert.equal(isProviderAvailable("kimi", getExtension), false);
});

test("availability rendering shows and hides existing status items", () => {
  const calls = [];
  const button = (provider) => ({
    show: () => calls.push(`${provider}:show`),
    hide: () => calls.push(`${provider}:hide`)
  });
  const buttons = {
    gemini: button("gemini"),
    claude: button("claude"),
    grok: button("grok"),
    kimi: button("kimi")
  };

  renderProviderAvailability(
    buttons,
    (id) => id === "anthropic.claude-code" ? { id } : undefined
  );
  assert.deepEqual(calls, [
    "gemini:show",
    "claude:show",
    "grok:hide",
    "kimi:hide"
  ]);
});
