# Antigravity AI Launcher

A small local Antigravity IDE extension that keeps Antigravity, Claude Code,
Codex, DeepSeek, and Grok launchers visible even when no editor is open, and shows
the available quota gauges for whichever quota-based provider is selected in
the secondary sidebar. Antigravity and Claude expose separate 5h and 7d gauges;
Codex exposes only its main weekly gauge. The gauges disappear whenever the
sidebar is closed, and remain hidden while DeepSeek or Grok is selected because
neither has a quota source configured in this launcher.

The gauges report **usage** rather than quota remaining:

```text
[5h $(circle-filled)$(circle)$(circle)$(circle)$(circle) 01%]
[7d $(circle-filled)$(circle-filled)$(circle)$(circle)$(circle) 28%]
```

Codex uses only the weekly form and never fabricates a removed 5h bucket:

```text
[7d $(circle-filled)$(circle)$(circle)$(circle)$(circle) 11%]
```

Each five-position bar uses VS Code's filled and hollow circle Codicons
(`$(circle-filled)` and `$(circle)`).
Positive usage is rounded upward to the next circle for visibility; the
adjacent numeric percentage remains exact and authoritative. This avoids the
inconsistent fallback-font metrics used by fractional Unicode Block Elements.

The provider name is intentionally omitted from the gauges. Provider launchers
use plain text with no icons or active-state markers. The launcher currently
selected in the secondary sidebar uses Antigravity's focus/accent color. The VS
Code extension API only permits warning and error status-bar backgrounds, so
the active-state accent is applied to the label foreground.

The visible quota gauges use that same active-provider accent. Warning and error
gauges retain Antigravity's native foreground/background pairing for readability.

It refreshes every minute. Every visible quota gauge is clickable and forces an
immediate refresh, as does **Antigravity AI Launcher: Refresh Active AI Quota**
in the Command Palette. There is no persistent refresh widget. During a manual
refresh, a normally hidden, one-glyph activity item appears immediately to the
left of the gauges, animates with the Braille spinner, and briefly becomes a
success check. Both states use the same focus/accent color as the active
provider and its gauges. The gauges remain visible and unchanged throughout. The
activity item sits farthest left and therefore wraps out before either gauge if
the refresh temporarily exceeds the available width. Further narrowing wraps
the 5h gauge, then the 7d gauge. Codex shows only the 7d gauge. Each gauge
independently receives the warning status-bar color at 70% usage and the error
color at 90% usage.
If no quota snapshot can be loaded, the gauge collapses to
`$(warning) Unable to load quota` with the native warning background; its
tooltip retains the provider error and the item remains clickable to retry.

The complete activity/gauge/launcher cluster uses priorities 0.7 through 0.025,
so it stays grouped immediately to the left of Antigravity's priority-0
**Antigravity - Settings** item. The always-visible `$(eye)` control sits
immediately to the right of Grok.

While the secondary sidebar is active, the global timer checks the selected
provider every minute, but Claude live endpoint reads are limited to once per
five minutes. A fresh Claude Code shared cache always wins and can satisfy
those checks without an endpoint request. The launcher also persists Claude's
last good snapshot, last automatic attempt/error, and active rate-limit backoff
in extension-global state, so installing a VSIX or reloading the window cannot
reset the five-minute guard and immediately hit the endpoint again.

## Launchers

| Button | Target command | Behavior |
| --- | --- | --- |
| Antigravity | `antigravity.agentSidePanel.focus` | Opens and focuses the Antigravity agent view without toggling it closed. |
| Claude | `claude-vscode.sidebar.open` | Runs **Claude Code: Open in Side Bar**, matching the Actions search command exactly. |
| Codex | `chatgpt.openSidebar` | Opens the Codex secondary sidebar. |
| DeepSeek | `cblage.codewhale.openChat` | Opens the cblage CodeWhale extension in the secondary sidebar and hides the quota gauges. |
| Grok | `grok.open` | Opens Grok in the secondary sidebar and hides the quota gauges. |
| `$(eye)` | `workbench.action.toggleMaximizedAuxiliaryBar` | Toggles maximize/restore while the secondary sidebar is open. When it is closed, opens the last selected provider (Antigravity by default) and maximizes it. |

Antigravity and the `$(eye)` control are always visible. Claude, Codex,
DeepSeek, and Grok are shown only while their corresponding extensions are
installed and enabled. The status bar updates immediately when an extension is
installed, uninstalled, enabled, or disabled. If the last selected provider is
no longer available, the eye control falls back to Antigravity.

Each model launcher is a toggle. Clicking an inactive model opens it in the
secondary sidebar. Clicking the active model closes the secondary sidebar;
its launcher immediately returns to the normal neutral status-bar foreground
and the gauges disappear.

The Command Palette also contains **Antigravity AI Launcher: New Antigravity
Conversation**.

## Active-provider detection

VS Code's extension API does not expose the selected secondary-sidebar
container. Antigravity does persist it in the current workspace database under
`workbench.auxiliarybar.activepanelid`, so the extension reads that value with
macOS's `/usr/bin/sqlite3` in read-only mode. A single 40ms loop checks the
database and WAL signatures, querying SQLite only after a storage change or on
the two-second fallback cadence. Opening a launcher suppresses persisted state
for 1100ms, then refuses stale hidden snapshots until persistence confirms the
exact requested visible view. Standard Secondary Side Bar controls invoke
`workbench.action.toggleAuxiliaryBar`; the launcher intercepts that command,
updates its state synchronously, and delegates to the idempotent close or focus
command. Antigravity's custom React close button bypasses workbench commands,
so a serialized 40ms `Cascade.getFocusState()` probe reads its live view-
container visibility directly. SQLite cannot overwrite that live Antigravity
state. X-button changes therefore do not wait for SQLite. Clicking
the active launcher to close uses the same 1100ms suppression before its forced
reconciliation. Reads are serialized, and a read started before an optimistic
action cannot overwrite that newer UI state. Every subsequent launcher click
cancels the prior grace, invalidates reads from that state, and starts a new
1100ms grace for the latest open or closed intent. The optimistic state and
grace begin synchronously at the first line of the click handler, before the
main-thread command-discovery
RPC or target sidebar command runs. Delayed command discovery is discarded if
a newer click has replaced its generation, so async completion order cannot
reorder user intent. Transitional database writes cannot flash an obsolete
state, and completion of an older command never reapplies its intent. The
extension activates eagerly, registers its commands without
waiting for the initial SQLite read, and begins neutral while that read runs in
the background. A first click therefore cannot be interrupted by cold-start
initialization; it invalidates the background read if necessary.

Recognized containers are:

| Provider | Antigravity container ID |
| --- | --- |
| Antigravity | `antigravity.agentViewContainerId` |
| Claude | `workbench.view.extension.claude-sidebar-secondary` |
| Codex | `workbench.view.extension.codexSecondaryViewContainer` |
| DeepSeek | `workbench.view.extension.cblage-codewhale` |
| Grok | `workbench.view.extension.grokSidebar` |

If the secondary sidebar is hidden, no launcher is marked active and all gauges
are hidden. The last-selected provider's quota stays cached so reopening it can
restore the gauges immediately; data older than 15 seconds is refreshed. If
Antigravity changes its internal state key, launcher clicks still select the
correct provider optimistically, but automatic detection will need an update.

An explicit model-button close remains authoritative after its 1100ms grace
until workspace persistence actually confirms that the secondary sidebar is
hidden. Antigravity can defer that workspace-state write beyond the grace
deadline, so stale persisted `visible` values are rejected instead of briefly
reactivating the launcher and gauges. A newer model-button intent immediately
cancels this close confirmation latch. Incomplete SQLite query results preserve
the last known visibility and selection rather than defaulting to active.

## Quota sources

No extra account, API key, or hosted service is required.

| Provider | Source |
| --- | --- |
| Antigravity | Antigravity's authenticated localhost `RetrieveUserQuotaSummary` endpoint, using its real `gemini-5h` and `gemini-weekly` buckets. |
| Claude | Claude Code's local shared usage cache when no more than five minutes old; otherwise the existing Claude Code OAuth credential is used only for `https://api.anthropic.com/api/oauth/usage`. Live endpoint reads have a five-minute memory TTL. HTTP 429 responses honor numeric or HTTP-date `Retry-After`, default to a 15-minute backoff, and double repeated fallback backoffs up to one hour. |
| Codex | The configured Codex CLI's `app-server` and `account/rateLimits/read`; if that is unavailable, the latest main `codex` local session rate-limit event is used. The current weekly-only main bucket is shown and model-specific buckets such as Codex Spark are ignored. The extension honors Antigravity's `chatgpt.cliExecutable` setting, including the Codex.app binary. |
| DeepSeek | No quota source. The launcher hides both gauges because DeepSeek usage is billed per token. |
| Grok | No quota source. The launcher hides both gauges while Grok is active. |

The extension never logs, displays, or stores provider credentials. Antigravity's
CSRF token is read from the local Antigravity language-server process and sent
only back to an authenticated loopback port. The Claude token is read from the
existing credentials file or macOS Keychain and sent only to Anthropic over
HTTPS. Codex authentication remains inside the official Codex CLI.

If Codex Pulse or Claude Control is also installed, their separate status-bar
gauges can be disabled in Settings to avoid duplicate quota displays; this
extension does not change their settings automatically.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `antigravityAiLauncher.quota.enabled` | `true` | Shows the active provider's available gauges while the secondary sidebar is open: 5h and 7d for Antigravity/Claude, weekly only for Codex. |
| `antigravityAiLauncher.quota.showBars` | `true` | Shows five-position filled-and-hollow circle Codicon bars alongside the percentages. |

## Test

```sh
npm run check
npm test
```

The extension has no runtime npm dependencies and requires no build step.

## Package

```sh
npx --yes @vscode/vsce package \
  --no-dependencies \
  --out antigravity-ai-launcher-0.3.66.vsix
```

## Install in Antigravity IDE

Run **Extensions: Install from VSIX...** from Antigravity's Command Palette,
choose `antigravity-ai-launcher-0.3.66.vsix`, and then run **Developer: Reload
Window**.

## Uninstall

```sh
"/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" \
  --uninstall-extension cblage.antigravity-ai-launcher
```

## Compatibility

This is intentionally a local macOS Antigravity integration. The provider
commands, Antigravity workspace-state key, localhost quota endpoint, and Codex
app-server protocol are integration surfaces owned by their respective apps.
Failures preserve the last good quota value and mark it stale rather than
silently replacing it with zero. Manual Claude refreshes bypass ordinary
freshness caching but never bypass an active rate-limit backoff; only a
successful Claude endpoint response resets exponential backoff state.

See `THIRD_PARTY_NOTICES.md` for acknowledgements.
