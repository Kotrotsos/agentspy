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
  // Toggle in DevTools console: window.__agentspy_debug = false
  if (typeof window.__agentspy_debug === "undefined") {
    window.__agentspy_debug = true;
  }

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

  function tryEmit(q, conversationId, url, source) {
    if (!q || typeof q !== "string") return;
    const trimmed = q.trim();
    if (trimmed.length < 2 || trimmed.length > 500) return;
    emitQuery(trimmed, conversationId, url);
    if (window.__agentspy_debug) {
      console.log("[AgentSpy] query:", trimmed, "(via", source + ")");
    }
  }

  function extractQueries(text, conversationId, url) {
    if (!text || typeof text !== "string") return;

    // Pattern A1: "queries":["...", "..."] — array of plain strings.
    const queriesArr = /"queries"\s*:\s*\[([\s\S]*?)\]/g;
    let m;
    while ((m = queriesArr.exec(text)) !== null) {
      const inner = m[1];

      // A1a: keyed objects inside the array first (most specific).
      const keyedRe = /"(?:text|q|query|search_query)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
      let foundKeyed = false;
      let s;
      while ((s = keyedRe.exec(inner)) !== null) {
        foundKeyed = true;
        tryEmit(safeJsonString(s[1]), conversationId, url, "queries[].keyed");
      }

      // A1b: if no keyed values, treat as array of plain strings.
      if (!foundKeyed) {
        const strRe = /"((?:\\.|[^"\\])*)"/g;
        while ((s = strRe.exec(inner)) !== null) {
          tryEmit(safeJsonString(s[1]), conversationId, url, "queries[].string");
        }
      }
    }

    // Pattern B: search("...") or web.search("...") tool-call code.
    const searchCall = /\b(?:web\.)?search\(\s*"((?:\\.|[^"\\])*)"\s*\)/g;
    while ((m = searchCall.exec(text)) !== null) {
      tryEmit(safeJsonString(m[1]), conversationId, url, "search()");
    }

    // Pattern C: {"q": "..."} entries inside a search_query array.
    const searchQueryArr = /"search_query"\s*:\s*\[([\s\S]*?)\]/g;
    while ((m = searchQueryArr.exec(text)) !== null) {
      const inner = m[1];
      const qFieldRe = /"q"\s*:\s*"((?:\\.|[^"\\])*)"/g;
      let s;
      while ((s = qFieldRe.exec(inner)) !== null) {
        tryEmit(safeJsonString(s[1]), conversationId, url, "search_query[]");
      }
    }

    // Pattern D: recipient:"web" tool message with a text field wrapping a
    // search() call. Narrower than Pattern B alone.
    const recipientWeb = /"recipient"\s*:\s*"web"[\s\S]{0,800}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    while ((m = recipientWeb.exec(text)) !== null) {
      const raw = safeJsonString(m[1]);
      if (!raw) continue;
      const inner = /\b(?:web\.)?search\(\s*"((?:\\.|[^"\\])*)"\s*\)/g;
      let s;
      while ((s = inner.exec(raw)) !== null) {
        tryEmit(safeJsonString(s[1]), conversationId, url, "recipient=web");
      }
    }

    // Pattern E: search_queries (plural variant of Pattern A).
    const searchQueriesArr = /"search_queries"\s*:\s*\[([\s\S]*?)\]/g;
    while ((m = searchQueriesArr.exec(text)) !== null) {
      const inner = m[1];
      const keyedRe = /"(?:text|q|query)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
      let s;
      let foundKeyed = false;
      while ((s = keyedRe.exec(inner)) !== null) {
        foundKeyed = true;
        tryEmit(safeJsonString(s[1]), conversationId, url, "search_queries[].keyed");
      }
      if (!foundKeyed) {
        const strRe = /"((?:\\.|[^"\\])*)"/g;
        while ((s = strRe.exec(inner)) !== null) {
          tryEmit(safeJsonString(s[1]), conversationId, url, "search_queries[].string");
        }
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
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 2_000_000) {
          buffer = buffer.slice(-1_000_000);
        }
        extractQueries(buffer, convoId, url);
      }
    } catch {}
    // Stream ended. The live POST stream rarely contains the queries in a
    // parseable shape — they live in the conversation tree fetched by
    // GET /backend-api/conversation/{id}. Always re-fetch after a turn so
    // we get the queries (cheap, just one extra request per chat reply).
    if (!convoId) {
      const m = buffer.match(/"conversation_id"\s*:\s*"([0-9a-fA-F-]{8,})"/);
      if (m) convoId = m[1];
    }
    if (convoId) {
      if (window.__agentspy_debug) {
        console.log("[AgentSpy] stream ended, scheduling tree scan for", convoId);
      }
      scheduleConversationScan(convoId, 1500);
    } else if (window.__agentspy_debug) {
      console.log("[AgentSpy] stream ended but no conversation id found");
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
      if (window.__agentspy_debug) {
        console.log("[AgentSpy] fetching tree for", convoId);
      }
      const res = await origFetch.call(
        window,
        "/backend-api/conversation/" + encodeURIComponent(convoId),
        { credentials: "include", headers: { Accept: "application/json" } }
      );
      if (!res || !res.ok) {
        if (window.__agentspy_debug) {
          console.warn("[AgentSpy] tree fetch failed:", res && res.status);
        }
        return;
      }
      const text = await res.text();
      const before = seenQueries.size;
      extractQueries(text, convoId, "/backend-api/conversation/" + convoId);
      const added = seenQueries.size - before;
      if (window.__agentspy_debug) {
        console.log(
          "[AgentSpy] tree scan complete: " +
            added +
            " new queries (response " +
            text.length +
            " bytes)"
        );
        if (added === 0) {
          // Sample the response so the user can paste it back if patterns miss.
          window.__agentspy_last_response = text;
          console.log(
            "[AgentSpy] no queries matched. Inspect window.__agentspy_last_response in this tab to see the full payload."
          );
        }
      }
    } catch (e) {
      if (window.__agentspy_debug) console.warn("[AgentSpy] scan error", e);
    }
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

  console.info(
    "[AgentSpy] interceptor installed (debug on; set window.__agentspy_debug=false to silence)"
  );
})();
