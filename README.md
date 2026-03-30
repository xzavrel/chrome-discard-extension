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
| Periodic alarm | `chrome.alarms` fires every 1 minute; discards tabs inactive > N min |
| Collapsed-group alarm | `chrome.alarms` one-shot per group; fires after configured delay when group is collapsed |
| Discard engine | Pure `chrome.tabs.discard(tabId)` — Chrome unloads the renderer; tab stays in bar and reloads on click |
| Badge | Red number showing how many tabs currently match discard criteria |
| Context menu | Right-click the extension icon → "Discard inactive tabs in this group" / "Discard all inactive tabs" |
| Messages | Popup sends `{action}` messages; worker responds with `{count}` |

### Data models

#### Rule

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
- **mode `exclude`** — matching tabs are always protected (wins over include and collapsed-group logic)
- **field** — one of `url`, `title`, `groupName`
- **matchType** — `substring` or `regex` (validated; invalid regex is ignored gracefully)
- **minInactiveMinutes** — `0` means "no inactivity requirement for this rule"

#### Collapsed-group discard entry

```json
{
  "name": "Research",
  "delayMinutes": 5
}
```

Stored in `settings.collapsedDiscardGroups` as an array of these objects.
Set `delayMinutes` to `0` for immediate discard.

### Discard decision flow

#### Periodic / manual discard (every minute or user-triggered)

```
globalProtection(tab, settings)
  → active / audible / discarded / pinned (unless allowed) / non-http(s) / ignored URL  → skip

ignoredGroups  → skip

applyRules:
  exclude rule matches  → protect
  include rule matches + inactivity ok  → discard candidate
  no include rules at all  → fall back to global inactivity threshold
```

#### Collapsed-group discard (event-driven)

```
chrome.tabGroups.onUpdated fires
  → group.collapsed = true
      → group name found in collapsedDiscardGroups?
          → delayMinutes > 0  → chrome.alarms.create('collapse-group-{id}', { delayInMinutes })
          → delayMinutes = 0  → discardGroupById() immediately
      → group name NOT found  → clear any stale alarm, do nothing

  → group.collapsed = false (expanded before alarm fires)
      → chrome.alarms.clear('collapse-group-{id}')  → pending discard cancelled

chrome.alarms.onAlarm fires ('collapse-group-{id}')
  → group still collapsed?  → discardGroupById()
  → group no longer exists  → silently ignored

discardGroupById():
  → for each tab in group: globalProtection() check + exclude rules → chrome.tabs.discard()
```

---

## Features

| Feature | Description |
|---|---|
| Manual discard all | Discards all inactive tabs across all windows |
| Manual discard group | Discards inactive tabs in the active tab group |
| Run rules now | Applies include rules immediately (ignores inactivity threshold) |
| Auto discard | Runs every minute via `chrome.alarms`; discards tabs inactive > N min |
| Collapsed-group discard | Discards tabs in named collapsed groups after a configurable delay |
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
- Tabs matching any enabled `exclude` rule (**wins even over collapsed-group discard**)

---

## Collapsed-group discard

This feature lets you automatically discard tabs in specific named groups whenever
those groups are collapsed. Unlike the periodic inactivity-based discard, this
mechanism is **event-driven** — it reacts immediately when Chrome fires
`tabGroups.onUpdated`.

### How to configure

1. Open **Settings** (right-click the extension icon → *Options*)
2. In the **"Discard when group is collapsed"** section, type the exact group name
3. Set the **delay** (in minutes): `0` = discard immediately on collapse, `5` = wait 5 minutes, etc.
4. Click **Add**, then **Save settings**

### Key behaviours

| Scenario | Result |
|---|---|
| Group collapsed, delay = 0 | Tabs discarded immediately |
| Group collapsed, delay = 5 min | Alarm scheduled; tabs discarded after 5 minutes |
| Group expanded before delay expires | Alarm cancelled — no discard occurs |
| Service worker killed by Chrome | Alarm survives (persisted by Chrome's alarm system); fires when SW restarts |
| Tab matches an `exclude` rule | Protected even within a collapsed-group discard |
| Group in "Ignored groups" list | Not affected by collapsed-group discard |

### Minimum delay note

Chrome enforces a minimum alarm delay of **~1 minute** in practice. Delays set to
`0` use direct function calls (bypassing alarms), so immediate discard works as
expected. For delays ≥ 1 minute the alarm system is used and Chrome will honour
the exact value.

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
| Tab group name, colour & collapsed state | `chrome.tabGroups.get()` |
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
   Collapsed-group discard with `delayMinutes = 0` bypasses alarms and runs
   synchronously.

2. **Tab activity before first install** — On fresh install the extension seeds
   all open tabs with the current timestamp, so no tab is considered "inactive"
   until inactivity accrues from that point forward.

3. **Grouped tabs without a group name** — Chrome allows unnamed groups (the
   user sees a coloured dot). Group-name rules and collapsed-group discard won't
   match these; they are not protected by group-name ignore rules either.

4. **`chrome.tabs.discard()` limitations** — Chrome may refuse to discard certain
   internal tabs (e.g., NTP, PDF viewer). The error is caught and silently ignored.

5. **Service worker lifecycle** — MV3 service workers can be terminated by
   Chrome at any time. Tab activity timestamps are persisted to `storage.local`
   after every change. Collapse alarms are persisted by Chrome's alarm subsystem
   and survive service worker restarts automatically.

6. **No cross-profile support** — Each Chrome profile runs its own extension
   instance with separate storage.

7. **Group rename after collapse** — If a tab group is renamed after being
   collapsed, the pending alarm is keyed by group ID (not name). The alarm will
   still fire and the discard will proceed using the group's current name at
   alarm time.

---

## Permissions justification

| Permission | Why it's needed |
|---|---|
| `tabs` | Read tab metadata (URL, title, state) and call `chrome.tabs.discard()` |
| `tabGroups` | Read group name/collapsed state for rules, actions, and collapse tracking |
| `storage` | Persist settings and tab-activity timestamps |
| `alarms` | Periodic auto-discard + delayed collapsed-group discard |
| `contextMenus` | Add right-click actions on the extension icon |

No `host_permissions`, no `<all_urls>`, no `scripting`, no content scripts.
