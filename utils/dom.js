// utils/dom.js
// ─────────────────────────────────────────────────────────────────────────────
// Resilient DOM helpers. Claude.ai uses obfuscated class names and frequently
// shuffles its DOM — so:
//   - never rely on a single selector
//   - prefer semantic anchors (role, aria, data-testid) over class
//   - validate match by predicate (does the element actually have model name?)
//   - log when a fallback path is taken so we can update primary selectors
// ─────────────────────────────────────────────────────────────────────────────

const DOM = (function () {

  // Lightweight logger — only emits in dev mode (tagged in localStorage).
  const DEV = (() => {
    try { return localStorage.getItem('tm:dev') === '1'; }
    catch (_) { return false; }
  })();

  function log(tag, ...args) {
    if (!DEV) return;
    console.log(`[tm:${tag}]`, ...args);
  }

  /**
   * Try a list of selectors in order. Return the first match whose
   * element passes the validate predicate (if provided).
   *
   * @param {string[]} selectors  Try in priority order
   * @param {(el: Element) => boolean} [validate]
   * @param {Element|Document} [root=document]
   * @returns {Element|null}
   */
  function querySelectorFirst(selectors, validate, root = document) {
    for (let i = 0; i < selectors.length; i++) {
      const sel = selectors[i];
      let nodes;
      try {
        nodes = root.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      for (const node of nodes) {
        if (!validate || validate(node)) {
          if (i > 0) log('dom', 'fallback selector hit', { sel, index: i });
          return node;
        }
      }
    }
    return null;
  }

  /**
   * Same idea but returns ALL matches (deduplicated).
   * @returns {Element[]}
   */
  function querySelectorAll(selectors, validate, root = document) {
    const seen = new Set();
    const out = [];
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = root.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      for (const node of nodes) {
        if (seen.has(node)) continue;
        if (validate && !validate(node)) continue;
        seen.add(node);
        out.push(node);
      }
    }
    return out;
  }

  /**
   * Walk up to `maxDepth` ancestors looking for one matching `predicate`.
   * @returns {Element|null}
   */
  function closestAncestor(el, predicate, maxDepth = 10) {
    let cur = el;
    for (let i = 0; i < maxDepth && cur; i++) {
      if (predicate(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * Extract plain text from an element, stripping injected widgets we own.
   * Our widgets all carry a `data-tm-widget` attribute.
   * @returns {string}
   */
  function extractText(el) {
    if (!el) return '';
    // Clone to avoid mutating live DOM, strip our own injections.
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-tm-widget]').forEach((n) => n.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }

  /**
   * Stable hash of a string — for identifying parse-failures so we don't
   * spam telemetry with the same broken banner text.
   * djb2 — not cryptographic, just stable and fast.
   */
  function stableHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return (h >>> 0).toString(36);
  }

  /**
   * Wait for an element to appear, with timeout. Used in async flows where
   * we triggered a navigation and need to wait for new DOM.
   * @returns {Promise<Element|null>}
   */
  function waitFor(selectors, validate, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const found = querySelectorFirst(selectors, validate);
      if (found) return resolve(found);

      const obs = new MutationObserver(() => {
        const el = querySelectorFirst(selectors, validate);
        if (el) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  return {
    log, querySelectorFirst, querySelectorAll, closestAncestor,
    extractText, stableHash, waitFor,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DOM;
