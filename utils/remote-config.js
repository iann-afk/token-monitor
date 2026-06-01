// utils/remote-config.js — Remote Config layer (content-script + background).
// Fetches a JSON config from CDN; merges remote selectors/models on top of
// bundled defaults. Falls back to bundled values silently on any error.
//
// Contract:
//   RemoteConfig.load()              — call once in dispatcher init; resolves fast from cache
//   RemoteConfig.selectors(key, bundled) — returns merged array (remote-first, bundled-after)
//   RemoteConfig.models(bundled)     — returns merged model table (remote overrides)
//   RemoteConfig.fetchAndCache()     — SW-side: fetch + store in chrome.storage.local
//   RemoteConfig.isStale()           — SW-side: true if cache > 6h old

const RemoteConfig = (() => {
  const STORAGE_KEY = 'remoteConfig:v1';
  const SCHEMA_VERSION = 1;
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

  // ⚠️  Replace with your real CDN URL before deploying.
  const CONFIG_URL = 'https://raw.githubusercontent.com/iann-afk/recall-config/refs/heads/main/claude-config.v1.json';

  let _cfg = null; // null = not loaded / fallback to bundled

  // ── Content-script side ──────────────────────────────────────────────────

  async function load() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const cached = data[STORAGE_KEY];
      if (!cached) return;
      if (cached.schemaVersion !== SCHEMA_VERSION) return; // schema mismatch → ignore
      _cfg = cached;
    } catch (_) {
      // storage unavailable — stay with bundled
    }
  }

  // Returns merged selector array: remote entries first, then any bundled
  // entries not already present (preserves bundled as fallback).
  function selectors(key, bundled) {
    const remote = _cfg && Array.isArray(_cfg.selectors && _cfg.selectors[key])
      ? _cfg.selectors[key]
      : null;
    if (!remote || remote.length === 0) return bundled;
    // remote-first; append bundled entries that aren't already in remote
    const seen = new Set(remote);
    const extra = bundled.filter((s) => !seen.has(s));
    return [...remote, ...extra];
  }

  // Returns merged model table: bundled base, remote entries layered on top.
  // 带范围校验：拒绝任何 contextWindow / maxOutputTokens 离谱的远程条目，
  // 防止手改 JSON 时打错数字污染计算。
  function models(bundled) {
    if (!_cfg || !_cfg.models || typeof _cfg.models !== 'object') return bundled;
    const safe = {};
    for (const [key, m] of Object.entries(_cfg.models)) {
      if (!m || typeof m !== 'object') continue;
      const cw = m.contextWindow, mo = m.maxOutputTokens;
      // 下界收紧到对 claude.ai 真实有意义的范围：上下文窗口至少 50k
      // （任何真实模型都远高于此；50k 以下几乎必然是手误，如漏写一个零），
      // 上界 2000 万留给未来超大窗口。maxOutputTokens 至少 1024、至多 50 万。
      const okCw = typeof cw === 'number' && cw >= 50000 && cw <= 20000000;
      const okMo = typeof mo === 'number' && mo >= 1024 && mo <= 500000;
      if (!okCw || !okMo) continue;            // 离谱值 → 丢弃该项，回退 bundled
      safe[key] = m;
    }
    return { ...bundled, ...safe };
  }

  // ── Service-worker side ──────────────────────────────────────────────────

  async function fetchAndCache() {
    try {
      const resp = await fetch(CONFIG_URL, { cache: 'no-store' });
      if (!resp.ok) return;
      const json = await resp.json();
      if (json.schemaVersion !== SCHEMA_VERSION) return; // unknown schema → discard
      await chrome.storage.local.set({
        [STORAGE_KEY]: { ...json, fetchedAtMs: Date.now() },
      });
    } catch (_) {
      // network failure — retain existing cache
    }
  }

  async function isStale() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const cached = data[STORAGE_KEY];
      if (!cached || !cached.fetchedAtMs) return true;
      return Date.now() - cached.fetchedAtMs > CACHE_TTL_MS;
    } catch (_) {
      return true;
    }
  }

  return { load, selectors, models, fetchAndCache, isStale };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RemoteConfig;
