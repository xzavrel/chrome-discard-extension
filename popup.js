'use strict';

async function send(action, extra = {}) {
  return chrome.runtime.sendMessage({ action, ...extra });
}

function showFeedback(msg, ok = true) {
  const el = document.getElementById('feedback');
  el.textContent = msg;
  el.className = `feedback ${ok ? 'ok' : 'err'}`;
  setTimeout(() => { el.className = 'feedback hidden'; }, 3000);
}

function pluralTabs(n) {
  return `${n} tab${n !== 1 ? 's' : ''}`;
}

async function refreshCount() {
  const res = await send('getMatchCount');
  const el = document.getElementById('match-count');
  if (res && res.count !== undefined) {
    el.textContent = `${res.count} tab${res.count !== 1 ? 's' : ''} eligible`;
  }
}

async function refreshAutoStatus() {
  const stored = await chrome.storage.local.get('settings');
  const settings = stored.settings || {};
  const el = document.getElementById('auto-status');
  if (settings.autoDiscard) {
    el.textContent = `Auto: on (${settings.inactivityMinutes ?? 30} min)`;
    el.classList.add('on');
  } else {
    el.textContent = 'Auto: off';
    el.classList.remove('on');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await refreshCount();
  await refreshAutoStatus();

  document.getElementById('btn-discard-all').addEventListener('click', async () => {
    const res = await send('discardAll');
    if (res?.error) {
      showFeedback(`Error: ${res.error}`, false);
    } else {
      showFeedback(`Discarded ${pluralTabs(res?.count ?? 0)}.`);
      await refreshCount();
    }
  });

  document.getElementById('btn-discard-group').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await send('discardGroup', { windowId: tab?.windowId });
    if (res?.error) {
      showFeedback(`Error: ${res.error}`, false);
    } else {
      showFeedback(`Discarded ${pluralTabs(res?.count ?? 0)} in current group.`);
      await refreshCount();
    }
  });

  document.getElementById('btn-run-rules').addEventListener('click', async () => {
    const res = await send('runRules');
    if (res?.error) {
      showFeedback(`Error: ${res.error}`, false);
    } else {
      showFeedback(`Rules ran — discarded ${pluralTabs(res?.count ?? 0)}.`);
      await refreshCount();
    }
  });

  document.getElementById('btn-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
