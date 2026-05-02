# AgentSpy

A Chrome extension that reveals the search queries ChatGPT actually sends
to the web after rewriting your prompt. Built for **GEO** (Generative
Engine Optimization), so you can see how conversational prompts get
reformulated into keyword-style search queries and update your content
accordingly.

The extension lives in [`extension/`](./extension). See
[`extension/README.md`](./extension/README.md) for install instructions
and the GEO keyword-map workflow.

## Why

When ChatGPT searches the web, it doesn't search for what you typed. It
rewrites your prompt into shorter, keyword-heavy queries (often with
date qualifiers you never mentioned). Those reformulated queries are
what determine whether ChatGPT finds and cites your content.

You can inspect them manually via DevTools every time, or let this
extension capture them automatically and keep a running log you can
export to CSV.
