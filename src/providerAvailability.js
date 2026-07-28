"use strict";

const PROVIDER_EXTENSION_IDS = Object.freeze({
  claude: "anthropic.claude-code",
  codex: "openai.chatgpt",
  deepseek: "cblage.codewhale-vscode",
  grok: "pawelhuryn.grok-vscode-phuryn",
  kimi: "moonshot-ai.kimi-code"
});

function isProviderAvailable(provider, getExtension) {
  const extensionId = PROVIDER_EXTENSION_IDS[provider];
  return !extensionId || Boolean(getExtension(extensionId));
}

function renderProviderAvailability(buttons, getExtension) {
  for (const [provider, button] of Object.entries(buttons)) {
    if (isProviderAvailable(provider, getExtension)) {
      button.show();
    } else {
      button.hide();
    }
  }
}

module.exports = {
  PROVIDER_EXTENSION_IDS,
  isProviderAvailable,
  renderProviderAvailability
};
