# Recall

A Chrome extension that gives Claude.ai users real-time visibility into their conversation usage — so you chat smoother, avoid cut-off replies, and know when to start fresh.

## Features

- **Context window** — see how full the current chat is, at a glance
- **Minimized pill** — collapses to a small pill showing just your context; turns amber/red as it fills
- **Truncation warning** — before you send a question that might get cut off, a plain-language heads-up explains why and suggests splitting it
- **Output size hint** — a small pill predicts how long the reply will be
- **Summary handoff** — when a chat gets long, summarize it in one guided flow and continue in a fresh chat
- **Quota monitor** (Pro/Max accounts) — 5-hour and weekly usage, with calibration from Claude's own banners
- **Service status** — surfaces Anthropic outages (from the official status page) so you know it's not you
- **First-run onboarding** — a 30-second welcome for new users

> Note: Quota figures (5-hour / weekly) require a Pro or Max account. On Free accounts there's no quota panel to read, so quota shows as unavailable — context tracking still works fully.

## Installation (developer mode)

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select this folder

## Architecture

```
content.js         — entry point, mounts UI, listens for popup commands
dispatcher.js      — orchestrates platform module + cross-cutting logic
                     (calibration, prediction, truncation risk, chat metrics)
background.js      — single quota fetcher serving all tabs, badge, notifications,
                     Anthropic status polling, remote-config fetch
platforms/
  claude.js        — Claude.ai DOM scanning + banner detection
utils/
  tokenizer.js     — heuristic token estimator (calibrates via banners)
  dom.js           — fallback selector chain helpers
  remote-config.js — fetches selector/model overrides from CDN (no-release updates)
ui/
  overlay.js            — floating widget (expandable / minimized pill)
  composer-companion.js — output size pill + truncation warning
  handoff-modal.js      — guided summarize-and-continue flow
  savings-card.js       — "chat is getting long" nudge that opens the handoff
  source-breakdown.js   — token source breakdown (collapsed by default)
  turn-badges.js        — per-turn token count under user messages
  stream-status-bar.js  — transient bar shown only while a reply streams
  onboarding.js         — first-run welcome
  overlay.css           — all widget styles
popup.{html,css,js}— extension popup
i18n/locales.js    — runtime UI strings (en / zh-CN)
_locales/          — Chrome Web Store strings
icons/             — toolbar icons
```

## Remote config

Selectors, banner patterns, and the model table can be updated **without shipping a new extension release**. `utils/remote-config.js` fetches a small JSON from a CDN you control; bundled defaults are used if the fetch fails or a value is missing. See the `recall-config` repository for the live config file.

## Settings storage

- `chrome.storage.sync` — user preferences (synced across devices)
- `chrome.storage.local` — quota cache, plan, calibration data, per-chat metrics, remote config cache

## Known limitations

- **Quota fetching** relies on reading Claude's own usage signals; it is unavailable on Free accounts and is a best-effort estimate elsewhere.
- **Tokenizer** is a heuristic estimator (±10–20%); the calibration loop narrows this over time using Claude's own banners. It is an estimate, not an exact count.

## License

MIT — see [LICENSE](LICENSE) for details.
