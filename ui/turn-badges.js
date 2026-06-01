// ui/turn-badges.js — small per-turn token count under each user message.

const TurnBadges = (function () {

  let dispatcher = null;
  const injected = new WeakMap(); // user message el → badge el

  function mount(d) { dispatcher = d; }

  function render() {
    if (!dispatcher) return;
    const conv = dispatcher.getConversation();
    if (!conv) return;
    const metrics = dispatcher.getChatMetrics();
    // NOTE: We intentionally show ONLY the per-turn token count here, not a
    // "% of 5h quota" figure. The 5h percentage relied on the fragile quota
    // budget (unavailable on Free accounts, best-guess elsewhere) and didn't
    // change any user decision. Token count alone is reliable (DOM-derived).

    // Find user message elements live (the snapshot stripped DOM refs).
    // Keep this selector list in sync with scanConversation()'s userSelectors,
    // including the bare font-class fallback — otherwise badges silently fail
    // to appear on deploys where only that fallback matches.
    const userEls = (typeof DOM !== 'undefined') ? DOM.querySelectorAll([
      '[data-testid="user-message"]',
      '[class*="font-user-message"]',
      'div[data-test-render-count] [class*="font-user-message"]',
    ]) : [];

    let turnIdx = 0;
    const firstTurnTokens = metrics.firstTurnTokens || 0;

    for (const el of userEls) {
      turnIdx++;
      // Estimate this turn's tokens from the element text
      const text = (typeof DOM !== 'undefined' ? DOM.extractText(el) : (el.innerText || ''));
      const tokens = (typeof Tokenizer !== 'undefined' ? Tokenizer.estimate(text) : Math.ceil(text.length / 4));

      let badge = injected.get(el);
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'tm-turn-badge';
        badge.dataset.tmWidget = 'turn-badge';
        // Insert as next sibling of the message bubble
        const wrap = el.parentElement;
        if (wrap) wrap.appendChild(badge);
        injected.set(el, badge);
      }

      // Show trend (Nx turn 1) only after turn 3 and when ratio >= 1.5
      let trendHtml = '';
      if (turnIdx >= 3 && firstTurnTokens > 0 && tokens / firstTurnTokens >= 1.5) {
        const x = (tokens / firstTurnTokens).toFixed(1);
        trendHtml = `<span class="tm-turn-trend">↑ ${_escape(I18N.t('inpage.turnBadgeTrend', { x }))}</span>`;
      }

      badge.innerHTML = `
        <span class="tm-turn-icon" aria-hidden="true">◈</span>
        <span>${_escape(I18N.t('inpage.turnBadge', { tokens: _fmt(tokens) }))}</span>
        ${trendHtml}
      `;
    }
  }

  function _fmt(n) {
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(2) + 'k';
    return String(n);
  }

  function _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { mount, render };
})();
