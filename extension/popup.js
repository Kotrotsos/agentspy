const STORAGE_KEY = "agentspy_records";

const $list = document.getElementById("list");
const $empty = document.getElementById("empty");
const $count = document.getElementById("count");
const $clear = document.getElementById("clear");
const $copyCsv = document.getElementById("copy-csv");
const $copyJson = document.getElementById("copy-json");
const $scan = document.getElementById("scan");

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.title) node.title = opts.title;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function shortId(id) {
  if (!id) return "(no id)";
  if (id.length <= 8) return id;
  return id.slice(0, 8) + "…";
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupRecords(records) {
  const groups = new Map();
  for (const r of records) {
    const key = r.conversationId || "_unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        conversationId: r.conversationId,
        prompts: [],
        queries: [],
        firstTs: r.ts,
        lastTs: r.ts,
      });
    }
    const g = groups.get(key);
    g.lastTs = Math.max(g.lastTs, r.ts);
    g.firstTs = Math.min(g.firstTs, r.ts);
    if (r.kind === "prompt") g.prompts.push(r);
    else g.queries.push(r);
  }
  return Array.from(groups.values()).sort((a, b) => b.lastTs - a.lastTs);
}

function buildQueryRow(q) {
  const copyBtn = el("button", {
    className: "copy-btn",
    title: "Copy query",
    text: "copy",
  });
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(q.value).then(() => {
      copyBtn.textContent = "copied";
      setTimeout(() => (copyBtn.textContent = "copy"), 1200);
    });
  });
  return el("div", { className: "query" }, [
    el("span", { className: "pill", text: formatTime(q.ts) }),
    el("span", { className: "text", text: q.value }),
    copyBtn,
  ]);
}

function buildGroup(g) {
  const headerRow = el("div", { className: "convo-header" }, [
    el("span", { className: "convo-id", text: shortId(g.conversationId) }),
    el("span", { text: formatTime(g.lastTs) }),
  ]);

  const promptNodes = g.prompts.map((p) =>
    el("div", { className: "prompt", text: '"' + p.value + '"' })
  );

  const sortedQueries = g.queries.slice().sort((a, b) => a.ts - b.ts);
  const queriesContainer = el("div", { className: "queries" });
  if (sortedQueries.length === 0) {
    queriesContainer.appendChild(
      el("div", { className: "query" }, [
        el("span", {
          className: "text",
          attrs: { style: "color:#999" },
          text: "no queries captured yet",
        }),
      ])
    );
  } else {
    for (const q of sortedQueries) {
      queriesContainer.appendChild(buildQueryRow(q));
    }
  }

  const section = el("section", { className: "convo" }, [
    headerRow,
    ...promptNodes,
    queriesContainer,
  ]);
  return section;
}

function render(records) {
  $list.replaceChildren();
  if (!records.length) {
    $empty.classList.remove("hidden");
    $count.textContent = "0 records";
    return;
  }
  $empty.classList.add("hidden");
  $count.textContent =
    records.length + " record" + (records.length === 1 ? "" : "s");

  for (const g of groupRecords(records)) {
    $list.appendChild(buildGroup(g));
  }
}

async function load() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  render(Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : []);
}

function flashButton(btn, label, ms) {
  btn.classList.add("copied");
  const orig = btn.textContent;
  btn.textContent = label || "copied";
  setTimeout(() => {
    btn.classList.remove("copied");
    btn.textContent = orig;
  }, ms || 1200);
}

function toCsv(records) {
  const header = "timestamp,conversation_id,kind,value";
  const safe = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const rows = records.map((r) =>
    [
      new Date(r.ts).toISOString(),
      r.conversationId || "",
      r.kind,
      r.value,
    ]
      .map(safe)
      .join(",")
  );
  return [header, ...rows].join("\n");
}

$scan.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url)) {
    flashButton($scan, "open chatgpt", 1800);
    return;
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      source: "agentspy-cmd",
      type: "scan",
    });
    if (resp && resp.conversationId) {
      flashButton($scan, "scanning…", 1500);
    } else {
      flashButton($scan, "no convo id", 1500);
    }
  } catch {
    flashButton($scan, "reload tab", 1800);
  }
});

$clear.addEventListener("click", async () => {
  if (!confirm("Clear all captured queries?")) return;
  await chrome.runtime.sendMessage({ source: "agentspy", type: "clear" });
  load();
});

$copyCsv.addEventListener("click", async () => {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const records = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  await navigator.clipboard.writeText(toCsv(records));
  flashButton($copyCsv);
});

$copyJson.addEventListener("click", async () => {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const records = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  await navigator.clipboard.writeText(JSON.stringify(records, null, 2));
  flashButton($copyJson);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    render(changes[STORAGE_KEY].newValue || []);
  }
});

load();
