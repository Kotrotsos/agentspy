// Content script: inject the page-context interceptor and bridge messages
// from the page world to the extension service worker.

(function injectInterceptor() {
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("injected.js");
    script.async = false;
    script.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    console.error("[AgentSpy] failed to inject interceptor", e);
  }
})();

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "agentspy") return;

  if (data.type === "query" || data.type === "prompt") {
    chrome.runtime.sendMessage(data).catch(() => {
      // service worker may be asleep on first message; ignore
    });
  }
});

// Forward "scan" commands from the popup/background into the page world,
// where the injected interceptor can use the page's fetch (with cookies).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== "agentspy-cmd") return;
  if (msg.type === "scan") {
    const convoId =
      msg.conversationId ||
      (location.pathname.match(/\/c\/([0-9a-fA-F-]{8,})/) || [])[1] ||
      null;
    window.postMessage(
      { source: "agentspy-cmd", type: "scan", conversationId: convoId },
      "*"
    );
    sendResponse({ ok: true, conversationId: convoId });
  }
});
