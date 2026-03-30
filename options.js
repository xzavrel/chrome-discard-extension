'use strict';

// ─── Data ─────────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  autoDiscard: true,
  inactivityMinutes: 30,
  includePinned: false,
  includeFile: false,
  ignoredGroups: [],
  ignoredUrlPatterns: [],
  collapsedDiscardGroups: [],
  rules: [],
};

let settings = { ...DEFAULT_SETTINGS };

// ─── Persist ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
}

// ─── ID generator ─────────────────────────────────────────────────────────────

function uid() {
  return 'rule-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Regex validation ─────────────────────────────────────────────────────────

function isValidRegex(pattern) {
  try { new RegExp(pattern); return true; }
  catch { return false; }
}

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderGlobal() {
  document.getElementById('autoDiscard').checked = settings.autoDiscard;
  document.getElementById('inactivityMinutes').value = settings.inactivityMinutes;
  document.getElementById('includePinned').checked = settings.includePinned;
  document.getElementById('includeFile').checked = settings.includeFile;
  toggleInactivityRow();
}

function toggleInactivityRow() {
  document.getElementById('row-inactivity').style.display =
    document.getElementById('autoDiscard').checked ? 'flex' : 'none';
}

function renderTagList(listId, items, onRemove) {
  const container = document.getElementById(listId);
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<span class="empty-hint">None added yet.</span>';
    return;
  }
  for (const item of items) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = item;
    const btn = document.createElement('button');
    btn.className = 'tag-remove';
    btn.textContent = '×';
    btn.title = 'Remove';
    btn.addEventListener('click', () => onRemove(item));
    tag.appendChild(btn);
    container.appendChild(tag);
  }
}

function renderIgnoredGroups() {
  renderTagList('ignored-groups-list', settings.ignoredGroups, name => {
    settings.ignoredGroups = settings.ignoredGroups.filter(g => g !== name);
    renderIgnoredGroups();
  });
}

function renderIgnoredUrls() {
  renderTagList('ignored-urls-list', settings.ignoredUrlPatterns, pat => {
    settings.ignoredUrlPatterns = settings.ignoredUrlPatterns.filter(p => p !== pat);
    renderIgnoredUrls();
  });
}

/** Render the collapsed-discard group list (object model: { name, delayMinutes }). */
function renderCollapsedGroups() {
  const list = settings.collapsedDiscardGroups || [];
  const container = document.getElementById('collapsed-groups-list');
  container.innerHTML = '';

  if (!list.length) {
    container.innerHTML = '<span class="empty-hint">None added yet.</span>';
    return;
  }

  for (const entry of list) {
    const row = document.createElement('div');
    row.className = 'collapsed-group-row';

    const name = document.createElement('span');
    name.className = 'collapsed-group-name';
    name.textContent = entry.name;

    const delay = document.createElement('span');
    delay.className = 'collapsed-group-delay';
    delay.textContent = entry.delayMinutes > 0
      ? `${entry.delayMinutes} min`
      : 'immediate';

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon danger';
    delBtn.title = 'Remove';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => {
      settings.collapsedDiscardGroups =
        (settings.collapsedDiscardGroups || []).filter(e => e.name !== entry.name);
      renderCollapsedGroups();
    });

    row.append(name, delay, delBtn);
    container.appendChild(row);
  }
}

function renderRules() {
  const container = document.getElementById('rules-list');
  container.innerHTML = '';
  if (!settings.rules.length) {
    container.innerHTML = '<p class="empty-hint">No rules yet.</p>';
    return;
  }

  for (const rule of settings.rules) {
    const row = document.createElement('div');
    row.className = `rule-row ${rule.enabled ? '' : 'disabled'}`;
    row.dataset.id = rule.id;

    const badge = document.createElement('span');
    badge.className = `rule-badge ${rule.mode}`;
    badge.textContent = rule.mode;

    const info = document.createElement('div');
    info.className = 'rule-info';
    info.innerHTML =
      `<strong>${rule.field}</strong> ${rule.matchType === 'regex' ? '∼' : '⊂'} ` +
      `<code>${escHtml(rule.pattern)}</code>` +
      (rule.minInactiveMinutes > 0 ? ` · ≥${rule.minInactiveMinutes} min` : '');

    const actions = document.createElement('div');
    actions.className = 'rule-actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn-icon';
    toggleBtn.title = rule.enabled ? 'Disable' : 'Enable';
    toggleBtn.textContent = rule.enabled ? '⏸' : '▶';
    toggleBtn.addEventListener('click', () => {
      const r = settings.rules.find(x => x.id === rule.id);
      if (r) r.enabled = !r.enabled;
      renderRules();
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon';
    editBtn.title = 'Edit';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', () => openRuleForm(rule));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon danger';
    delBtn.title = 'Delete';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => {
      settings.rules = settings.rules.filter(r => r.id !== rule.id);
      renderRules();
    });

    actions.append(toggleBtn, editBtn, delBtn);
    row.append(badge, info, actions);
    container.appendChild(row);
  }
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Rule form ────────────────────────────────────────────────────────────────

function openRuleForm(rule = null) {
  const details = document.getElementById('rule-form-details');
  details.open = true;

  document.getElementById('rule-id').value          = rule?.id || '';
  document.getElementById('rule-mode').value        = rule?.mode || 'include';
  document.getElementById('rule-field').value       = rule?.field || 'url';
  document.getElementById('rule-match-type').value  = rule?.matchType || 'substring';
  document.getElementById('rule-pattern').value     = rule?.pattern || '';
  document.getElementById('rule-min-inactive').value = rule?.minInactiveMinutes ?? 0;
  document.getElementById('rule-enabled').checked   = rule?.enabled ?? true;
  document.getElementById('regex-error').classList.add('hidden');

  document.getElementById('rule-form-toggle').textContent =
    rule ? 'Edit rule' : '+ Add rule';
}

function closeRuleForm() {
  const details = document.getElementById('rule-form-details');
  details.open = false;
  document.getElementById('rule-form-toggle').textContent = '+ Add rule';
}

function collectRule() {
  const id           = document.getElementById('rule-id').value || uid();
  const mode         = document.getElementById('rule-mode').value;
  const field        = document.getElementById('rule-field').value;
  const matchType    = document.getElementById('rule-match-type').value;
  const pattern      = document.getElementById('rule-pattern').value.trim();
  const minInactive  = parseInt(document.getElementById('rule-min-inactive').value, 10) || 0;
  const enabled      = document.getElementById('rule-enabled').checked;
  return { id, enabled, mode, matchType, field, pattern, minInactiveMinutes: minInactive };
}

// ─── Save / status ────────────────────────────────────────────────────────────

function showSaveStatus() {
  const el = document.getElementById('save-status');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

// ─── Export / Import ──────────────────────────────────────────────────────────

function exportSettings() {
  const json = JSON.stringify(settings, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'tab-discarder-settings.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importSettings(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      // Merge – only accept known keys
      const keys = Object.keys(DEFAULT_SETTINGS);
      for (const key of keys) {
        if (key in imported) settings[key] = imported[key];
      }
      renderAll();
      showSaveStatus(); // hint that user should click Save
    } catch {
      alert('Import failed: invalid JSON file.');
    }
  };
  reader.readAsText(file);
}

// ─── Full render ──────────────────────────────────────────────────────────────

function renderAll() {
  renderGlobal();
  renderIgnoredGroups();
  renderIgnoredUrls();
  renderCollapsedGroups();
  renderRules();
}

// ─── Wire up events ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  renderAll();

  // Global toggles
  document.getElementById('autoDiscard').addEventListener('change', toggleInactivityRow);

  // Tag input – ignored groups
  function addIgnoredGroup() {
    const inp = document.getElementById('newIgnoredGroup');
    const val = inp.value.trim();
    if (val && !settings.ignoredGroups.includes(val)) {
      settings.ignoredGroups.push(val);
      inp.value = '';
      renderIgnoredGroups();
    }
  }
  document.getElementById('btn-add-group').addEventListener('click', addIgnoredGroup);
  document.getElementById('newIgnoredGroup').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addIgnoredGroup(); }
  });

  // Tag input – ignored URLs
  function addIgnoredUrl() {
    const inp = document.getElementById('newIgnoredUrl');
    const val = inp.value.trim();
    if (val && !settings.ignoredUrlPatterns.includes(val)) {
      settings.ignoredUrlPatterns.push(val);
      inp.value = '';
      renderIgnoredUrls();
    }
  }
  document.getElementById('btn-add-url').addEventListener('click', addIgnoredUrl);
  document.getElementById('newIgnoredUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addIgnoredUrl(); }
  });

  // Collapsed-group discard
  function addCollapsedGroup() {
    const nameInp  = document.getElementById('newCollapsedGroupName');
    const delayInp = document.getElementById('newCollapsedGroupDelay');
    const name     = nameInp.value.trim();
    const delay    = Math.max(0, parseInt(delayInp.value, 10) || 0);
    if (!settings.collapsedDiscardGroups) settings.collapsedDiscardGroups = [];
    if (!name) return;
    // Prevent duplicates
    if (settings.collapsedDiscardGroups.some(e => e.name === name)) {
      nameInp.value = '';
      return;
    }
    settings.collapsedDiscardGroups.push({ name, delayMinutes: delay });
    nameInp.value  = '';
    delayInp.value = '5';
    renderCollapsedGroups();
  }
  document.getElementById('btn-add-collapsed').addEventListener('click', addCollapsedGroup);
  document.getElementById('newCollapsedGroupName').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addCollapsedGroup(); }
  });

  // Rule form – validate regex live
  document.getElementById('rule-pattern').addEventListener('input', () => {
    const matchType = document.getElementById('rule-match-type').value;
    const pattern   = document.getElementById('rule-pattern').value;
    const errEl     = document.getElementById('regex-error');
    if (matchType === 'regex' && pattern && !isValidRegex(pattern)) {
      errEl.classList.remove('hidden');
    } else {
      errEl.classList.add('hidden');
    }
  });
  document.getElementById('rule-match-type').addEventListener('change', () => {
    document.getElementById('rule-pattern').dispatchEvent(new Event('input'));
  });

  // Save rule
  document.getElementById('btn-save-rule').addEventListener('click', () => {
    const rule = collectRule();
    if (!rule.pattern) { alert('Pattern cannot be empty.'); return; }
    if (rule.matchType === 'regex' && !isValidRegex(rule.pattern)) {
      alert('Invalid regex pattern. Please fix it before saving.'); return;
    }
    const idx = settings.rules.findIndex(r => r.id === rule.id);
    if (idx >= 0) settings.rules[idx] = rule;
    else settings.rules.push(rule);
    closeRuleForm();
    renderRules();
  });

  document.getElementById('btn-cancel-rule').addEventListener('click', closeRuleForm);

  // Export / Import
  document.getElementById('btn-export').addEventListener('click', exportSettings);
  document.getElementById('btn-import').addEventListener('click', () =>
    document.getElementById('import-file').click()
  );
  document.getElementById('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importSettings(e.target.files[0]);
    e.target.value = '';
  });

  // Save all settings
  document.getElementById('btn-save').addEventListener('click', async () => {
    // Collect current form values into settings object
    settings.autoDiscard = document.getElementById('autoDiscard').checked;
    settings.inactivityMinutes = parseInt(document.getElementById('inactivityMinutes').value, 10) || 30;
    settings.includePinned = document.getElementById('includePinned').checked;
    settings.includeFile = document.getElementById('includeFile').checked;

    await saveSettings();
    showSaveStatus();
  });
});
