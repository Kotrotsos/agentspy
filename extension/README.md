# AgentSpy: ChatGPT Query Inspector

A small Chrome extension that captures the search queries ChatGPT actually
sends to the web after rewriting your prompt. Useful for **GEO** (Generative
Engine Optimization), so you can see how your conversational prompts get
reformulated into keyword-style queries.

Instead of opening DevTools, filtering by conversation ID, finding the response
payload, and searching for `"queries"` every time, this extension does it
automatically and keeps a log.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder in this repo
5. Visit [chatgpt.com](https://chatgpt.com), make sure web search is enabled,
   and ask any question. The toolbar icon will show a badge with the number of
   captured items. Click it to see the queries.

## What it captures

For every request to `/backend-api/conversation` (and the streaming variant):

- **Prompt**: the original natural-language question you sent.
- **Queries**: the reformulated, keyword-style search queries ChatGPT sends to
  its web search tool.

Items are grouped per conversation. Use **CSV** or **JSON** to copy the data
and drop it straight into your GEO keyword map.

## How it works

- A content script injects `injected.js` into the page world.
- `injected.js` wraps `window.fetch` and `XMLHttpRequest` and watches outgoing
  POST bodies and streamed SSE responses for the conversation API.
- Multiple regex patterns extract the user prompt and the search queries
  (ChatGPT has shipped several payload formats, so we try a few).
- Captured items are forwarded via `postMessage` to the content script, which
  passes them to the service worker, which persists them in `chrome.storage`.

Everything stays local. Nothing is sent off-device.

## Workflow for building a GEO keyword map

1. Brainstorm 15–20 prompts a customer might ask ChatGPT about your space.
2. Paste them one at a time into ChatGPT (web search enabled).
3. Open the extension popup, hit **CSV**, paste into a spreadsheet.
4. For each reformulated query, check whether your page titles, H2s, URL
   slugs, and opening sentences use that exact language. If not, update them.
5. Repeat monthly. ChatGPT's reformulation patterns change with model updates.

## Limitations

- Only works on `chatgpt.com` and the legacy `chat.openai.com` host.
- Pattern-based extraction. If OpenAI changes the payload format, some queries
  may slip through until the patterns are updated.
- Captures up to 500 most recent records, then rolls over.
