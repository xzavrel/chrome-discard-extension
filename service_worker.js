/**
 * service_worker.js – Tab Discarder
 *
 * Responsibilities:
 *  - Track tab last-activated timestamps
 *  - Run discard logic on alarm ticks
 *  - Expose message handlers for popup actions
 *  - Maintain badge with matching-tab count
 *  - Register context menu entries
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const ALARM_NAME   = 'auto-discard';
const ALARM_PERIOD = 1; // minutes – granularity of alarm; actual inactivity threshold is in settings

// ─── Default settings ────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  autoDiscard: false,          // automatic periodic discard enabled
  inactivityMinutes: 30,       // discard tabs inactive longer than this
  includePinned: false,        // include pinned tabs
  includeFile: false,          // include file:// tabs
  ignoredGroups: [],           // group names to never discard
  ignoredUrlPatterns: [],      // URL substrings to never discard
  rules: [],                   // user-defined rules (see data model below)
};

/*
  Rule data model:
  {
    id: string,
    enabled: boolean,
    mode: 'include' | 'exclude',   // include = apply discard; exclude = protect from discard
    matchType: 'substring' | 'regex',
    field: 'url' | 'title' | 'groupName',
    pattern: string,
    minInactiveMinutes: number,    // 0 = no inactivity requirement
  }
*/

// ─── In-memory tab activity map ──────────────────────────────────────────────
// Persisted to storage.local so it survives service-worker restarts.
// Map<tabId (string), timestamp (ms)>

let tabActivity = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function loadActivity() {
  const stored = await chrome.storage.local.get('tabActivity');
  tabActivity = stored.tabActivity || {};
}

async function saveActivity() {
  await chrome.storage.local.set({ tabActivity });
}

function now() {
  return Date.now();
}

function minutesAgo(ms) {
  return (now() - ms) / 60_000;
}

/** Compile a regex safely; returns null on invalid pattern. */
function safeRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** Test a single value against a rule pattern. */
function matchesPattern(value, matchType, pattern) {
  if (!value) return false;
  if (matchType === 'substring') {
    return value.includes(pattern);
  }
  if (matchType === 'regex') {
    const re = safeRegex(pattern);
    return re ? re.test(value) : false;
  }
  return false;
}

/**
 * Fetch tab group name for a given groupId.
 * Returns '' if not in a group or API unavailable.
 */
async function getGroupName(groupId) {
  if (!groupId || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return '';
  try {
    const group = await chrome.tabGroups.get(groupId);
    return group.title || '';
  } catch {
    return '';
  }
}

/**
 * Determine whether a tab is safe to discard based on global settings.
 * Returns { safe: boolean, reason: string }.
 */
function globalProtection(tab, settings) {
  if (tab.active)     return { safe: false, reason: 'active' };
  if (tab.audible)    return { safe: false, reason: 'audible' };
  if (tab.discarded)  return { safe: false, reason: 'already discarded' };

  if (tab.pinned && !settings.includePinned) {
    return { safe: false, reason: 'pinned' };
  }

  const url = tab.url || '';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (url.startsWith('file://')) {
      if (!settings.includeFile) return { safe: false, reason: 'file:// not allowed' };
    } else {
      return { safe: false, reason: 'non-http(s) URL' };
    }
  }

  // Ignored URL patterns
  for (const pat of settings.ignoredUrlPatterns) {
    if (pat && url.includes(pat)) {
      return { safe: false, reason: `ignored url pattern: ${pat}` };
    }
  }

  return { safe: true, reason: '' };
}

/**
 * Core matching logic.
 * Returns true if a tab should be discarded given all rules + settings.
 */
async function shouldDiscard(tab, settings, groupName) {
  const { safe } = globalProtection(tab, settings);
  if (!safe) return false;

  // Ignored groups
  if (groupName && settings.ignoredGroups.includes(groupName)) return false;

  const inactiveMins = tabActivity[String(tab.id)]
    ? minutesAgo(tabActivity[String(tab.id)])
    : Infinity; // never activated → very old

  // Apply user rules
  const rules = (settings.rules || []).filter(r => r.enabled);

  // Collect include/exclude decisions
  let hasIncludeMatch = false;
  let hasExcludeMatch = false;

  for (const rule of rules) {
    let fieldValue = '';
    if (rule.field === 'url')       fieldValue = tab.url || '';
    if (rule.field === 'title')     fieldValue = tab.title || '';
    if (rule.field === 'groupName') fieldValue = groupName;

    if (!matchesPattern(fieldValue, rule.matchType, rule.pattern)) continue;

    // Check inactivity threshold for this rule
    const minMins = Number(rule.minInactiveMinutes) || 0;
    if (minMins > 0 && inactiveMins < minMins) continue;

    if (rule.mode === 'exclude') hasExcludeMatch = true;
    if (rule.mode === 'include') hasIncludeMatch = true;
  }

  // Exclude rules take priority
  if (hasExcludeMatch) return false;

  // If there are include rules and none matched → skip (rules are non-empty)
  if (rules.filter(r => r.mode === 'include').length > 0 && !hasIncludeMatch) {
    return false;
  }

  // No include rules at all → fall back to global inactivity threshold
  if (rules.filter(r => r.mode === 'include').length === 0) {
    if (settings.autoDiscard && inactiveMins < settings.inactivityMinutes) {
      return false;
    }
  }

  return true;
}

/**
 * Collect all tabs with their group names.
 * Returns Array<{ tab, groupName }>.
 */
async function getAllTabsWithGroups(windowId) {
  const query = windowId ? { windowId } : {};
  const tabs = await chrome.tabs.query(query);

  const grouped = await Promise.all(tabs.map(async tab => ({
    tab,
    groupName: await getGroupName(tab.groupId),
  })));

  return grouped;
}

// ─── Discard actions ─────────────────────────────────────────────────────────

async function discardTab(tabId) {
  try {
    await chrome.tabs.discard(tabId);
  } catch (err) {
    // Tab may have closed or already discarded – ignore
    console.warn(`[discarder] Could not discard tab ${tabId}:`, err.message);
  }
}

/** Discard all inactive tabs across all windows. */
async function discardAllInactive() {
  const settings = await loadSettings();
  const items = await getAllTabsWithGroups();
  let count = 0;

  for (const { tab, groupName } of items) {
    if (await shouldDiscard(tab, settings, groupName)) {
      await discardTab(tab.id);
      count++;
    }
  }
  return count;
}

/** Discard inactive tabs in the active group of a given window. */
async function discardCurrentGroup(windowId) {
  const settings = await loadSettings();
  const tabs = await chrome.tabs.query({ windowId });
  const activeTab = tabs.find(t => t.active);
  if (!activeTab) return 0;

  const groupId = activeTab.groupId;
  if (!groupId || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return 0;

  const groupName = await getGroupName(groupId);
  let count = 0;

  const groupTabs = tabs.filter(t => t.groupId === groupId);
  for (const tab of groupTabs) {
    if (await shouldDiscard(tab, settings, groupName)) {
      await discardTab(tab.id);
      count++;
    }
  }
  return count;
}

/** Run user-defined include rules right now, ignoring inactivity threshold. */
async function runRulesNow() {
  const settings = await loadSettings();
  const items = await getAllTabsWithGroups();
  let count = 0;

  const includeRules = (settings.rules || []).filter(r => r.enabled && r.mode === 'include');
  if (includeRules.length === 0) return 0;

  for (const { tab, groupName } of items) {
    const { safe } = globalProtection(tab, settings);
    if (!safe) continue;
    if (groupName && settings.ignoredGroups.includes(groupName)) continue;

    for (const rule of includeRules) {
      let fieldValue = '';
      if (rule.field === 'url')       fieldValue = tab.url || '';
      if (rule.field === 'title')     fieldValue = tab.title || '';
      if (rule.field === 'groupName') fieldValue = groupName;

      if (!matchesPattern(fieldValue, rule.matchType, rule.pattern)) continue;

      await discardTab(tab.id);
      count++;
      break; // one rule match is enough per tab
    }
  }
  return count;
}

// ─── Badge update ─────────────────────────────────────────────────────────────

async function updateBadge() {
  const settings = await loadSettings();
  const items = await getAllTabsWithGroups();
  let count = 0;

  for (const { tab, groupName } of items) {
    if (await shouldDiscard(tab, settings, groupName)) count++;
  }

  const text = count > 0 ? String(count) : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
}

// ─── Alarm handling ───────────────────────────────────────────────────────────

async function setupAlarm(settings) {
  await chrome.alarms.clearAll();
  if (settings.autoDiscard) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD });
  }
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  await discardAllInactive();
  await updateBadge();
});

// ─── Tab activity tracking ────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await loadActivity();
  tabActivity[String(tabId)] = now();
  await saveActivity();
  await updateBadge();
});

chrome.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const tabs = await chrome.tabs.query({ windowId, active: true });
    if (tabs.length > 0) {
      await loadActivity();
      tabActivity[String(tabs[0].id)] = now();
      await saveActivity();
    }
  } catch { /* window may have closed */ }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  await loadActivity();
  delete tabActivity[String(tabId)];
  await saveActivity();
  await updateBadge();
});

chrome.tabs.onUpdated.addListener(async () => {
  await updateBadge();
});

// ─── Settings change listener ─────────────────────────────────────────────────

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const newSettings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  await setupAlarm(newSettings);
  await updateBadge();
});

// ─── Context menu ─────────────────────────────────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'discard-group',
      title: 'Discard inactive tabs in this group',
      contexts: ['action'],
    });
    chrome.contextMenus.create({
      id: 'discard-all',
      title: 'Discard all inactive tabs',
      contexts: ['action'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'discard-group' && tab) {
    await discardCurrentGroup(tab.windowId);
  } else if (info.menuItemId === 'discard-all') {
    await discardAllInactive();
  }
  await updateBadge();
});

// ─── Message handler for popup ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(message) {
  switch (message.action) {
    case 'discardAll': {
      const count = await discardAllInactive();
      await updateBadge();
      return { count };
    }
    case 'discardGroup': {
      const count = await discardCurrentGroup(message.windowId);
      await updateBadge();
      return { count };
    }
    case 'runRules': {
      const count = await runRulesNow();
      await updateBadge();
      return { count };
    }
    case 'getMatchCount': {
      const settings = await loadSettings();
      const items = await getAllTabsWithGroups();
      let count = 0;
      for (const { tab, groupName } of items) {
        if (await shouldDiscard(tab, settings, groupName)) count++;
      }
      return { count };
    }
    default:
      return { error: 'Unknown action' };
  }
}

// ─── Initialisation ───────────────────────────────────────────────────────────

async function init() {
  await loadActivity();

  // Seed activity timestamps for all currently open tabs
  const tabs = await chrome.tabs.query({});
  const hasData = Object.keys(tabActivity).length > 0;
  if (!hasData) {
    const ts = now();
    for (const tab of tabs) {
      tabActivity[String(tab.id)] = ts;
    }
    await saveActivity();
  }

  const settings = await loadSettings();
  await setupAlarm(settings);
  setupContextMenu();
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
