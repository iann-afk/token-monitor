# Token Monitor v2

A Chrome extension that gives Claude.ai users real-time visibility into:

- **Context window** — how full the current chat is
- **5-hour window** — your rolling Pro/Max budget
- **Weekly cap** — your weekly bucket
- **This chat** — input vs output token split, burn rate trend
- **Truncation risk** — warns before sending a question that would get cut off
- **Output size prediction** — pill next to the send button
- **Calibration loop** — uses Claude's own banners ("5 messages left") to
  self-correct estimates over time

## Installation (developer mode)

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select this folder

## Verifying selectors on your live Claude.ai

Anthropic obfuscates DOM and changes it between deploys. Before relying on the
extension in production, run the probe script:

1. Open a Claude.ai chat
2. Open DevTools (Cmd+Opt+I / F12) → Console
3. Paste the contents of `scripts/probe-selectors.js`
4. Read the output — any ❌ or ⚠️ rows mean the primary selector needs updating

Open `platforms/claude.js` and look for `// SELECTOR_VERIFY` comments to find
where each selector lives.

## Architecture

```
content.js         — entry point, mounts UI, listens for popup commands
dispatcher.js      — orchestrates platform module + cross-cutting logic
                     (calibration, prediction, truncation risk, chat metrics)
background.js      — single quota fetcher serving all tabs, badge, notifications
platforms/
  claude.js        — Claude.ai DOM scraping + banner detection
utils/
  tokenizer.js     — heuristic token estimator (calibrates via banners)
  dom.js           — fallback selector chain helpers
ui/
  overlay.js       — floating widget on the page
  composer-companion.js — output size pill + truncation banner
  turn-badges.js   — per-turn token cost under user messages
  stream-status-bar.js  — bar shown above composer while streaming
  overlay.css      — all widget styles
popup.{html,css,js}— extension popup
i18n/locales.js    — runtime UI strings (en / zh-CN)
_locales/          — Chrome Store strings
icons/             — toolbar icons
scripts/probe-selectors.js — paste-into-console diagnostic
```

## Settings storage

- `chrome.storage.sync` — user preferences (synced across devices)
- `chrome.storage.local` — quota cache, plan, calibration data, per-chat metrics
  - keys: `quota:claude`, `plan:claude`, `calibration:claude`, `chat:claude:{convId}`

## Known limitations

This is a v2 architecture release. Several methods are intentionally rough:

- **`fetchQuota`** uses heuristic JSON endpoint probes followed by HTML scraping
  of `/settings/usage`. Actual endpoint shapes need verification on a live tab.
- **Tokenizer** ratios are calibrated against tiktoken cl100k_base for English
  prose. CJK is conservatively under-estimated (tiktoken counts more); the
  calibration loop corrects this over time using Claude's own banners.
- **Quota signal patterns** (`detectQuotaSignals`) are best-guess regex against
  observed banner formats. Run the probe script and update the patterns when
  Anthropic changes wording.

## License

MIT — see [LICENSE](./LICENSE) for details.
