"use strict";

const PROVIDER_SECONDARY_SIDEBAR_SETTINGS = Object.freeze({
  kimi: Object.freeze({
    section: "kimi",
    setting: "openInSecondarySidebar"
  })
});

async function ensureProviderSecondarySidebar(provider, options) {
  const setting = PROVIDER_SECONDARY_SIDEBAR_SETTINGS[provider];
  if (!setting) {
    return false;
  }

  const configuration = options.getConfiguration(setting.section);
  if (configuration.get(setting.setting, false)) {
    return false;
  }

  await configuration.update(
    setting.setting,
    true,
    options.configurationTarget
  );
  return true;
}

module.exports = {
  PROVIDER_SECONDARY_SIDEBAR_SETTINGS,
  ensureProviderSecondarySidebar
};
