# ⚡ Tab Discarder

A Chrome extension (Manifest V3) that discards inactive tabs using the native
`chrome.tabs.discard()` API — **no fake parking pages, no content scripts, no
host permissions.**

---

## Installation (Load unpacked)

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the root folder of this project (the one containing `manifest.json`)
5. The extension icon appears in the toolbar — click it to open the popup

---

## Architecture

```
chrome-discard-extension/
├── manifest.json        – MV3 manifest (permissions: tabs, tabGroups, storage, alarms, contextMenus)
├── service_worker.js    – Background logic: discard engine, alarms, badge, context menu
├── popup.html / .js     – Toolbar popup with 3 quick-action buttons
├── options.html / .js   – Full settings page (rules, toggles, ignored lists, export/import)
├── styles.css           – Shared dark-mode UI for both popup and options page
└── icons/               – 16 / 32 / 48 / 128 px PNGs
```

### Service worker responsibilities

| Concern | Detail |
|---|---|
| Tab activity | `tabs.onActivated` + `windows.onFocusChanged` → timestamp map persisted to `storage.local` |
| Alarm | `chrome.alarms` fires every 1 minute; actual threshold is the user-configured inactivity value |
| Discard engine | Pure `chrome.tabs.discard(tabId)` — Chrome unloads the renderer; the tab remains in the bar and reloads on click |
| Badge | Red number showing how many tabs currently match discard criteria |
| Context menu | Right-click the extension icon → "Discard inactive tabs in this group" / "Discard all inactive tabs" |
| Messages | Popup sends `{action}` messages; worker responds with `{count}` |

### Rule model

```json
{
  "id": "rule-abc123",
  "enabled": true,
  "mode": "include",
  "matchType": "substring",
  "field": "url",
  "pattern": "docs.google.com",
  "minInactiveMinutes": 30
}
```

- **mode `include`** — matching tabs are candidates for discard
- **mode `exclude`** — matching tabs are always protected (wins over include)
- **field** — one of `url`, `title`, `groupName`
- **matchType** — `substring` or `regex` (validated; invalid regex is ignored gracefully)
- **minInactiveMinutes** — `0` means "no inactivity requirement for this rule"

### Discard decision flow

```
globalProtection(tab, settings)
  → active / audible / discarded / pinned (unless allowed) / non-http(s) / ignored URL  → skip

ignoredGroups  → skip

applyRules:
  exclude rule matches  → protect
  include rule matches + inactivity ok  → discard candidate
  no include rules at all  → fall back to global inactivity threshold
```

---

## Features

| Feature | Description |
|---|---|
| Manual discard all | Discards all inactive tabs across all windows |
| Manual discard group | Discards inactive tabs in the active tab group |
| Run rules now | Applies include rules immediately (ignores inactivity threshold) |
| Auto discard | Runs every minute via `chrome.alarms`; discards tabs inactive > N min |
| Badge | Shows count of tabs currently eligible for discard |
| Context menu | Right-click action icon for quick group or all-tab discard |
| Export / Import | Settings serialised as JSON for backup or migration |

### Protections (never discarded)

- Active tab
- Audible tab (playing media / on a call)
- Pinned tab (unless explicitly enabled in settings)
- `file://` tabs (unless explicitly enabled)
- Non-http(s) tabs (chrome://, about:, data:, …)
- URLs matching the ignored-URL-patterns list
- Tabs in groups matching the ignored-groups list
- Tabs matching any enabled `exclude` rule

---

## Why no full web access is needed

Chrome's `chrome.tabs.discard(tabId)` only requires the **`tabs`** permission.
The extension reads tab metadata (URL, title, pinned, active, groupId, audible)
that is part of the `Tab` object returned by the Tabs API — no content script,
no `<all_urls>`, no `scripting` permission is involved at any point.

### What the extension CAN see

| Data | Source |
|---|---|
| Tab URL | `Tab.url` (Tabs API — requires `tabs` permission) |
| Tab title | `Tab.title` |
| Tab status (active, pinned, audible, discarded) | `Tab` object fields |
| Tab group name & color | `chrome.tabGroups.get()` |
| Extension's own storage | `chrome.storage.local` |

### What the extension CANNOT see

- Page DOM / HTML content
- Network requests made by pages
- Cookies, localStorage, passwords
- Form inputs or user interactions inside pages
- Any data from other extensions

---

## Known limitations

1. **`chrome.alarms` granularity** — Chrome enforces a minimum alarm period of
   ~1 minute, so the auto-discard check cannot run more frequently than that.

2. **Tab activity before first install** — On fresh install the extension seeds
   all open tabs with the current timestamp, so no tab is considered "inactive"
   until inactivity accrues from that point forward.

3. **Grouped tabs without a group name** — Chrome allows unnamed groups (the
   user sees a coloured dot). Group-name rules simply won't match these; they
   are not protected by group-name ignore rules either.

4. **chrome.tabs.discard() limitations** — Chrome may refuse to discard certain
   internal tabs (e.g., NTP, PDF viewer). The error is caught and silently
   ignored.

5. **Service worker lifecycle** — MV3 service workers can be terminated by
   Chrome at any time. Tab activity timestamps are persisted to `storage.local`
   after every change to survive restarts.

6. **No cross-profile support** — Each Chrome profile runs its own extension
   instance with separate storage.

---

## Permissions justification

| Permission | Why it's needed |
|---|---|
| `tabs` | Read tab metadata (URL, title, state) and call `chrome.tabs.discard()` |
| `tabGroups` | Read group name for group-based rules and actions |
| `storage` | Persist settings and tab-activity timestamps |
| `alarms` | Schedule periodic automatic discard checks |
| `contextMenus` | Add right-click actions on the extension icon |

No `host_permissions`, no `<all_urls>`, no `scripting`, no content scripts.
