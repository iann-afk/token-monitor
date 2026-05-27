// ui/turn-badges.js — small "tokens · % of 5h" under each user message.

const TurnBadges = (function () {

  let dispatcher = null;
  const injected = new WeakMap(); // user message el → badge el

  function mount(d) { dispatcher = d; }

  function render() {
    if (!dispatcher) return;
    const conv = dispatcher.getConversation();
    if (!conv) return;
    const metrics = dispatcher.getChatMetrics();
    // Plan-aware budget fallback: use calibrated value if available,
    // otherwise estimate from plan tier (Free ≈ 20k, Pro ≈ 220k, Max ≈ 1.1M).
    const _planFallback = () => {
      const tier = dispatcher.getPlan?.()?.tier || 'unknown';
      if (tier === 'free')    return 20000;
      if (tier === 'max-5x')  return 1100000;
      if (tier === 'max-20x') return 4400000;
      return 220000; // pro / team / unknown
    };
    const budget = dispatcher._state.calibration.estimatedFiveHourBudget || _planFallback();

    // Find user message elements live (the snapshot stripped DOM refs)
    const userEls = (typeof DOM !== 'undefined') ? DOM.querySelectorAll([
      '[data-testid="user-message"]',
      'div[data-test-render-count] [class*="font-user-message"]',
    ]) : [];

    let turnIdx = 0;
    const firstTurnTokens = metrics.firstTurnTokens || 0;

    for (const el of userEls) {
      turnIdx++;
      // Estimate this turn's tokens from the element text
      const text = (typeof DOM !== 'undefined' ? DOM.extractText(el) : (el.innerText || ''));
      const tokens = (typeof Tokenizer !== 'undefined' ? Tokenizer.estimate(text) : Math.ceil(text.length / 4));
      const pct = Math.min(100, ((tokens) / budget) * 100);
      // Format: show 2 decimal places if < 0.1%, 1 decimal if < 1%, else integer
      const pctFmt = pct < 0.1 ? pct.toFixed(2) : pct < 1 ? pct.toFixed(1) : Math.round(pct).toString();

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
        <span>${_escape(I18N.t('inpage.turnBadge', { tokens: _fmt(tokens), pct: pctFmt }))}</span>
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
