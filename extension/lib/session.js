// TaskBridge — resume unfinished tasks. Stored only on this computer (chrome.storage.local).
// Uploaded documents are never stored.

const PREFIX = 'tb:session:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const key = (origin) => PREFIX + origin;

export async function loadSession(origin) {
  const r = await chrome.storage.local.get(key(origin));
  const s = r[key(origin)];
  if (!s) return null;
  if (Date.now() - (s.updatedAt || 0) > MAX_AGE_MS) {
    await chrome.storage.local.remove(key(origin));
    return null;
  }
  return s;
}

export async function saveSession(origin, data) {
  await chrome.storage.local.set({ [key(origin)]: { ...data, updatedAt: Date.now() } });
}

export async function clearSession(origin) {
  await chrome.storage.local.remove(key(origin));
}

export async function clearAllSessions() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}
