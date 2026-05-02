// Page-context interceptor for ChatGPT's backend API.
//
// Runs in the page world (not the isolated extension world) so it can wrap
// window.fetch and XMLHttpRequest. Scans request/response payloads to the
// /backend-api/conversation endpoint and extracts:
//   - the user's original prompt (from outgoing POST bodies)
//   - the reformulated search queries ChatGPT sends to its web tool
// Matches are forwarded to the content script via window.postMessage.

(function () {
  if (window.__agentspy_installed) return;
  window.__agentspy_installed = true;

  const TARGET_PATH = /\/backend-api\/(?:f\/)?conversation/;

  const seenQueries = new Set();
  const seenPrompts = new Set();

  function emitQuery(query, conversationId, url) {
    const key = (conversationId || "") + "::" + query;
    if (seenQueries.has(key)) return;
    seenQueries.add(key);
    window.postMessage(
      {
        source: "agentspy",
        type: "query",
        query,
        conversationId: conversationId || null,
        url: url || null,
        ts: Date.now(),
      },
      "*"
    );
  }

  function emitPrompt(prompt, conversationId) {
    const key = (conversationId || "") + "::" + prompt;
    if (seenPrompts.has(key)) return;
    seenPrompts.add(key);
    window.postMessage(
      {
        source: "agentspy",
        type: "prompt",
        prompt,
        conversationId: conversationId || null,
        ts: Date.now(),
      },
      "*"
    );
  }

  function safeJsonString(escaped) {
    try {
      return JSON.parse('"' + escaped + '"');
    } catch {
      return null;
    }
  }

  function extractQueries(text, conversationId, url) {
    if (!text || typeof text !== "string") return;

    // Pattern A: "queries":["...", "..."] — most common search-tool payload.
    const queriesArr = /"queries"\s*:\s*\[((?:\s*"(?:\\.|[^"\\])*"\s*,?)+)\]/g;
    let m;
    while ((m = queriesArr.exec(text)) !== null) {
      const inner = m[1];
      const strRe = /"((?:\\.|[^"\\])*)"/g;
      let s;
      while ((s = strRe.exec(inner)) !== null) {
        const q = safeJsonString(s[1]);
        if (q && q.length > 1 && q.length < 500) emitQuery(q, conversationId, url);
      }
    }

    // Pattern B: search("...") or web.search("...") tool-call code.
    const searchCall = /\b(?:web\.)?search\(\s*"((?:\\.|[^"\\])*)"\s*\)/g;
    while ((m = searchCall.exec(text)) !== null) {
      const q = safeJsonString(m[1]);
      if (q && q.length > 1 && q.length < 500) emitQuery(q, conversationId, url);
    }

    // Pattern C: {"q": "..."} entries inside a search_query array.
    const searchQueryArr = /"search_query"\s*:\s*\[([\s\S]*?)\]/g;
    while ((m = searchQueryArr.exec(text)) !== null) {
      const inner = m[1];
      const qFieldRe = /"q"\s*:\s*"((?:\\.|[^"\\])*)"/g;
      let s;
      while ((s = qFieldRe.exec(inner)) !== null) {
        const q = safeJsonString(s[1]);
        if (q && q.length > 1 && q.length < 500) emitQuery(q, conversationId, url);
      }
    }

    // Pattern D: a recipient:"web" tool message with a text field that
    // wraps a search() call. Narrower than Pattern B alone.
    const recipientWeb = /"recipient"\s*:\s*"web"[\s\S]{0,400}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    while ((m = recipientWeb.exec(text)) !== null) {
      const raw = safeJsonString(m[1]);
      if (!raw) continue;
      const inner = /\b(?:web\.)?search\(\s*"((?:\\.|[^"\\])*)"\s*\)/g;
      let s;
      while ((s = inner.exec(raw)) !== null) {
        const q = safeJsonString(s[1]);
        if (q && q.length > 1 && q.length < 500) emitQuery(q, conversationId, url);
      }
    }
  }

  function extractPromptFromRequestBody(body, conversationId) {
    if (!body) return;
    let text = body;
    if (body instanceof ArrayBuffer) {
      try {
        text = new TextDecoder().decode(body);
      } catch {
        return;
      }
    } else if (typeof body !== "string") {
      try {
        text = JSON.stringify(body);
      } catch {
        return;
      }
    }
    const partsRe = /"author"\s*:\s*\{[^}]*"role"\s*:\s*"user"[^}]*\}[\s\S]{0,400}?"parts"\s*:\s*\[\s*"((?:\\.|[^"\\])*)"/g;
    let m;
    while ((m = partsRe.exec(text)) !== null) {
      const p = safeJsonString(m[1]);
      if (p && p.length > 1) emitPrompt(p, conversationId);
    }
  }

  function conversationIdFromUrl(url) {
    if (!url) return null;
    const m = url.match(/\/conversation\/([0-9a-fA-F-]{8,})/);
    if (m) return m[1];
    const pageMatch = location.pathname.match(/\/c\/([0-9a-fA-F-]{8,})/);
    return pageMatch ? pageMatch[1] : null;
  }

  // ---- fetch wrapper --------------------------------------------------

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url =
      typeof input === "string"
        ? input
        : input && input.url
        ? input.url
        : "";
    const isTarget = TARGET_PATH.test(url);

    if (isTarget && init && init.body) {
      try {
        extractPromptFromRequestBody(init.body, conversationIdFromUrl(url));
      } catch {}
    }

    const response = await origFetch.apply(this, arguments);

    if (!isTarget) return response;

    try {
      const cloned = response.clone();
      const contentType = cloned.headers.get("content-type") || "";
      const convoId = conversationIdFromUrl(url);

      if (
        contentType.includes("text/event-stream") ||
        contentType.includes("application/x-ndjson")
      ) {
        consumeStream(cloned, convoId, url);
      } else {
        cloned
          .text()
          .then((txt) => extractQueries(txt, convoId, url))
          .catch(() => {});
      }
    } catch {}

    return response;
  };

  async function consumeStream(response, convoId, url) {
    if (!response.body || !response.body.getReader) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let sawWebTool = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 2_000_000) {
          buffer = buffer.slice(-1_000_000);
        }
        if (!sawWebTool && /"recipient"\s*:\s*"web"|search_result_group|"queries"\s*:\s*\[/.test(buffer)) {
          sawWebTool = true;
        }
        extractQueries(buffer, convoId, url);
      }
    } catch {}
    // Stream ended. The live POST stream rarely contains the queries in a
    // parseable shape; the queries appear in the conversation tree fetched
    // by GET /backend-api/conversation/{id}. After a search-enabled turn,
    // re-fetch the tree so we can extract the queries.
    if (!convoId) {
      const m = buffer.match(/"conversation_id"\s*:\s*"([0-9a-fA-F-]{8,})"/);
      if (m) convoId = m[1];
    }
    if (convoId && sawWebTool) {
      scheduleConversationScan(convoId, 1500);
    }
  }

  // Re-fetch the conversation tree to extract search queries that aren't in
  // the live stream. Debounced per conversation.
  const scanTimers = new Map();
  function scheduleConversationScan(convoId, delayMs) {
    if (!convoId) return;
    if (scanTimers.has(convoId)) clearTimeout(scanTimers.get(convoId));
    scanTimers.set(
      convoId,
      setTimeout(() => {
        scanTimers.delete(convoId);
        scanConversation(convoId);
      }, delayMs)
    );
  }

  async function scanConversation(convoId) {
    if (!convoId) return;
    try {
      const res = await origFetch.call(
        window,
        "/backend-api/conversation/" + encodeURIComponent(convoId),
        { credentials: "include", headers: { Accept: "application/json" } }
      );
      if (!res || !res.ok) return;
      const text = await res.text();
      extractQueries(text, convoId, "/backend-api/conversation/" + convoId);
    } catch {}
  }

  // Listen for a manual scan trigger from the popup.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "agentspy-cmd") return;
    if (data.type === "scan") {
      const convoId =
        data.conversationId ||
        (location.pathname.match(/\/c\/([0-9a-fA-F-]{8,})/) || [])[1];
      if (convoId) scanConversation(convoId);
    }
  });

  // ---- XMLHttpRequest wrapper -----------------------------------------

  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSend = XHR.prototype.send;

  XHR.prototype.open = function (method, url) {
    this.__agentspy_url = url;
    return origOpen.apply(this, arguments);
  };

  XHR.prototype.send = function (body) {
    const url = this.__agentspy_url || "";
    if (TARGET_PATH.test(url)) {
      const convoId = conversationIdFromUrl(url);
      if (body) {
        try {
          extractPromptFromRequestBody(body, convoId);
        } catch {}
      }
      this.addEventListener("load", () => {
        try {
          if (typeof this.responseText === "string") {
            extractQueries(this.responseText, convoId, url);
          }
        } catch {}
      });
    }
    return origSend.apply(this, arguments);
  };

  console.info("[AgentSpy] interceptor installed");
})();
