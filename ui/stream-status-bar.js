// ui/stream-status-bar.js — persistent turn-cost bar above composer.
//
// Always visible (after first turn). Three states:
//   streaming  — spinning icon + live input/output tokens
//   idle (after recent turn) — last turn's cost + chat totals
//   idle (no history yet) — friendly "send a message" hint

const StreamStatusBar = (function () {

  let dispatcher = null;
  let root = null;
  let pollTimer = null;

  function mount(d) {
    dispatcher = d;
    pollTimer = setInterval(render, 800);
  }

  function render() {
    if (!dispatcher) return;
    const platform = dispatcher._state.platform;
    const anchor = platform && platform.getComposerAnchor && platform.getComposerAnchor();
    if (!anchor) { _remove(); return; }

    const stream = dispatcher.getInflightStream();
    const metrics = dispatcher.getChatMetrics();
    const conv = dispatcher.getConversation();
    const quota = dispatcher.getQuota();

    // Don't show on a totally fresh /new chat
    const hasAnyContent = (conv && conv.messages && conv.messages.length > 0)
      || (metrics && metrics.turns > 0)
      || stream;
    if (!hasAnyContent) {
      _remove();
      return;
    }

    if (!root) {
      root = document.createElement('div');
      root.className = 'tm-stream-bar';
      root.dataset.tmWidget = 'stream-bar';
    }

    if (stream) {
      _renderStreaming(stream);
    } else {
      _renderIdle(metrics, conv, quota);
    }

    if (root.parentElement !== anchor.parentElement) {
      anchor.parentElement.insertBefore(root, anchor);
    }
  }

  function _renderStreaming(stream) {
    const inputK = _fmtK(stream.inputCommitted);
    const outputK = _fmtK(stream.outputSoFar);
    root.classList.remove('tm-stream-bar-idle');
    root.classList.add('tm-stream-bar-streaming');
    root.innerHTML = `
      <span class="tm-stream-spin" aria-hidden="true">◐</span>
      <span class="tm-stream-text">${_escape(I18N.t('inpage.streaming', { input: inputK, output: outputK }))}</span>
      <span class="tm-stream-hint">${_escape(I18N.t('inpage.streamingHint'))}</span>
    `;
  }

  function _renderIdle(metrics, conv, quota) {
    root.classList.remove('tm-stream-bar-streaming');
    root.classList.add('tm-stream-bar-idle');

    // No turn history recorded by stream lifecycle (popup just opened, or
    // user navigated to an existing chat). Fall back to DOM-scan derived data.
    if (!metrics || metrics.turns === 0) {
      const ctxK = _fmtK(conv?.contextTokens || 0);
      // conversation.messages includes user + assistant entries from scan.
      // A "turn" is one user→assistant cycle; use user count as turn count.
      const userMsgs = (conv?.messages || []).filter((m) => m.role === 'user');
      const turnCount = userMsgs.length;

      // Estimate last turn cost as last user-msg tokens + last assistant-msg tokens
      const assistantMsgs = (conv?.messages || []).filter((m) => m.role === 'assistant');
      const lastTurnTokens =
        (userMsgs[userMsgs.length - 1]?.estimatedTokens || 0) +
        (assistantMsgs[assistantMsgs.length - 1]?.estimatedTokens || 0);

      if (turnCount > 0 && lastTurnTokens > 0) {
        const lastK = _fmtK(lastTurnTokens);
        let pctOf5h = '';
        if (quota?.fiveHourPercent != null) {
          const _tier = dispatcher.getPlan?.()?.tier || 'unknown';
      const _fallback = _tier === 'free' ? 20000 : _tier === 'max-5x' ? 1100000 : _tier === 'max-20x' ? 4400000 : 220000;
      const budget = dispatcher._state.calibration?.estimatedFiveHourBudget || _fallback;
          const pct = (lastTurnTokens / budget) * 100;
          if (pct >= 0.1) pctOf5h = ' · ' + pct.toFixed(1) + '% ' + (_isZh() ? '配额' : 'of 5h');
        }
        root.innerHTML = `
          <span class="tm-stream-icon-static" aria-hidden="true">◉</span>
          <span class="tm-stream-text">${_escape(_isZh()
            ? `上一轮 ${lastK}${pctOf5h}`
            : `Last turn · ${lastK}${pctOf5h}`
          )}</span>
          <span class="tm-stream-hint">${_escape(_isZh()
            ? `本对话 ${turnCount} 轮 · 累计 ${ctxK}`
            : `${turnCount} turns · ${ctxK} total`
          )}</span>
        `;
        return;
      }

      // Truly empty / new chat
      const msgCount = conv?.messages?.length || 0;
      root.innerHTML = `
        <span class="tm-stream-icon-static" aria-hidden="true">◉</span>
        <span class="tm-stream-text">${_escape(_isZh()
          ? `当前会话 · ${msgCount} 条消息 · 累计 ${ctxK}`
          : `Current chat · ${msgCount} messages · ${ctxK} context`
        )}</span>
        <span class="tm-stream-hint">${_escape(_isZh()
          ? '发送消息后显示本轮成本'
          : 'Send a message to see per-turn cost'
        )}</span>
      `;
      return;
    }

    // We have stream-recorded turn data
    const lastTurnTotal = metrics.recentTurnTokens?.length
      ? metrics.recentTurnTokens[metrics.recentTurnTokens.length - 1]
      : 0;
    const totalK = _fmtK(metrics.totalTokens || 0);
    const lastTurnK = _fmtK(lastTurnTotal);

    let trend = '';
    if (metrics.firstTurnTokens > 0 && lastTurnTotal / metrics.firstTurnTokens >= 1.5) {
      const x = (lastTurnTotal / metrics.firstTurnTokens).toFixed(1);
      trend = _isZh() ? ` · ↑${x}× 第一轮` : ` · ↑${x}× turn 1`;
    }

    let pctOf5h = '';
    if (quota?.fiveHourPercent != null && lastTurnTotal > 0) {
      const _tier = dispatcher.getPlan?.()?.tier || 'unknown';
      const _fallback = _tier === 'free' ? 20000 : _tier === 'max-5x' ? 1100000 : _tier === 'max-20x' ? 4400000 : 220000;
      const budget = dispatcher._state.calibration?.estimatedFiveHourBudget || _fallback;
      const pct = (lastTurnTotal / budget) * 100;
      if (pct >= 0.1) pctOf5h = ' · ' + pct.toFixed(1) + '% ' + (_isZh() ? '配额' : 'of 5h');
    }

    root.innerHTML = `
      <span class="tm-stream-icon-static" aria-hidden="true">◉</span>
      <span class="tm-stream-text">${_escape(_isZh()
        ? `上一轮 ${lastTurnK}${pctOf5h}${trend}`
        : `Last turn · ${lastTurnK}${pctOf5h}${trend}`
      )}</span>
      <span class="tm-stream-hint">${_escape(_isZh()
        ? `本对话累计 ${totalK} · ${metrics.turns} 轮`
        : `Chat total ${totalK} · ${metrics.turns} turns`
      )}</span>
    `;
  }

  function _isZh() {
    try { return I18N.detect && I18N.detect() === 'zh-CN'; }
    catch (_) { return false; }
  }

  function _fmtK(n) {
    if (!n || n < 0) return '0';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function _remove() {
    if (root && root.parentElement) root.parentElement.removeChild(root);
    root = null;
  }

  function _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { mount, render };
})();
