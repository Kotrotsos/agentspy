// Service worker: persists captured queries/prompts and updates the badge.

const STORAGE_KEY = "agentspy_records";
const MAX_RECORDS = 500;

async function getRecords() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function saveRecords(records) {
  await chrome.storage.local.set({ [STORAGE_KEY]: records });
}

async function appendRecord(rec) {
  const records = await getRecords();
  // De-dupe within a conversation: same (conversationId, kind, value) = skip.
  const isDup = records.some(
    (r) =>
      r.conversationId === rec.conversationId &&
      r.kind === rec.kind &&
      r.value === rec.value
  );
  if (isDup) return records.length;
  records.push(rec);
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
  await saveRecords(records);
  return records.length;
}

function updateBadge(count) {
  const text = count > 99 ? "99+" : count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#0f9d58" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== "agentspy") return;

  if (msg.type === "query" || msg.type === "prompt") {
    const rec = {
      kind: msg.type,
      value: msg.type === "query" ? msg.query : msg.prompt,
      conversationId: msg.conversationId || null,
      url: msg.url || (sender.tab && sender.tab.url) || null,
      ts: msg.ts || Date.now(),
    };
    appendRecord(rec).then((count) => updateBadge(count));
  } else if (msg.type === "clear") {
    saveRecords([]).then(() => updateBadge(0));
    sendResponse({ ok: true });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  getRecords().then((r) => updateBadge(r.length));
});
chrome.runtime.onStartup.addListener(() => {
  getRecords().then((r) => updateBadge(r.length));
});
