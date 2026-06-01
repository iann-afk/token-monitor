// ui/overlay.js — floating widget v2.1.1
// Bug fixes:
//   - Flickering: MutationObserver loop broken by _lastRenderHash guard
//   - Countdown timer fires render only when hash actually changes
//   - Source breakdown uses correct I18N.t() keys (now in locales.js)

const Overlay = (function () {

  let root = null;
  let dispatcher = null;
  let collapsed = false;
  let _eventsAttached    = false;
  let _rootClickAttached = false; // root click listener registered only once
  let position = { x: 16, y: window.innerHeight - 340 };
  let _countdownTimer = null;
  let _lastRenderHash = '';   // FIX: prevents MutationObserver re-render loop

  function mount(d) {
    dispatcher = d;
    if (root) return;
    root = document.createElement('div');
    root.className = 'tm-overlay';
    root.dataset.tmWidget = 'overlay';
    document.body.appendChild(root);

    try {
      const saved = JSON.parse(localStorage.getItem('tm:overlay:pos') || 'null');
      if (saved && typeof saved.x === 'number') position = saved;
    } catch (_) {}
    try { collapsed = localStorage.getItem('tm:overlay:collapsed') === '1'; } catch (_) {}
    _clampPosition();
    window.addEventListener('resize', () => { _clampPosition(); _applyPosition(); });

    try {
      chrome.storage.local.get('ui:overlayHidden', (r) => {
        if (r?.['ui:overlayHidden']) root.style.display = 'none';
      });
    } catch (_) {}

    if (typeof SourceBreakdown !== 'undefined') SourceBreakdown.mount(d);
    if (typeof SavingsCard !== 'undefined') SavingsCard.mount(d);
    if (typeof HandoffModal !== 'undefined') HandoffModal.mount(d);

    _startCountdown();
    _applyOverlayTheme();
  }

  function _applyOverlayTheme() {
    if (!root || !dispatcher) return;
    const cfg = dispatcher.getSettings ? dispatcher.getSettings() : {};
    const theme = cfg.theme || 'system';
    if (theme === 'dark') {
      root.dataset.tmTheme = 'dark';
    } else if (theme === 'light') {
      // Explicitly set 'light' so [data-tm-theme="light"] CSS overrides system dark
      root.dataset.tmTheme = 'light';
    } else {
      // system: remove override, let CSS media query decide
      root.removeAttribute('data-tm-theme');
    }
  }

  // ── State hash: only re-render when something meaningful changes ──────────
  function _computeHash(ctxPct, fhPct, wkPct, q, conv) {
    const ctx5   = Math.round(ctxPct / 2) * 2;   // quantize to 2%
    const fh5    = Math.round(fhPct  / 2) * 2;
    const wk5    = Math.round(wkPct  / 2) * 2;
    const src    = q.source || '?';
    const bdOpen = typeof SourceBreakdown !== 'undefined' ? SourceBreakdown.isExpanded() : 0;
    const showSv = typeof SavingsCard !== 'undefined' ? (SavingsCard.shouldShow(conv, ctxPct) ? 1 : 0) : 0;
    const svDone = typeof SavingsCard !== 'undefined' ? (SavingsCard.isDone() ? 1 : 0) : 0;
    const fhCd   = q.fiveHourReleaseAtMs ? Math.floor((q.fiveHourReleaseAtMs - Date.now()) / 30000) : 0;
    const wkCd   = q.weeklyResetAtMs     ? Math.floor((q.weeklyResetAtMs     - Date.now()) / 3600000) : 0;
    const svc    = _getServiceLevel();
    // Bucket absolute context tokens in 2k steps so silent-loss zone triggers re-render
    // even when the percentage doesn't move (e.g. 14k → 15k crossing within a 2% bucket).
    const ctxTok = Math.floor((conv?.contextTokens || 0) / 2000);
    const themeCfg = dispatcher.getSettings ? (dispatcher.getSettings().theme || 'system') : 'system';
    return `${ctx5}|${fh5}|${wk5}|${src}|${collapsed}|${bdOpen}|${showSv}|${svDone}|${fhCd}|${wkCd}|${svc}|${ctxTok}|${themeCfg}`;
  }

  function _forceRender() {
    // Reset hash to force next render() to actually update DOM
    _lastRenderHash = '';
    render();
  }

  function _startCountdown() {
    if (_countdownTimer) clearInterval(_countdownTimer);
    _countdownTimer = setInterval(() => {
      if (root && root.style.display !== 'none' && !collapsed) render();
    }, 30000);
  }

  function _clampPosition() {
    const W = window.innerWidth, H = window.innerHeight;
    position.x = Math.max(0, Math.min(position.x, W - 260));
    position.y = Math.max(0, Math.min(position.y, H - 60));
  }

  function _applyPosition() {
    if (!root) return;
    root.style.left = position.x + 'px';
    root.style.top  = position.y + 'px';
  }

  function render() {
    if (!root || !dispatcher) return;

    const q    = dispatcher.getQuota();
    const plan = dispatcher.getPlan();
    const conv = dispatcher.getConversation();
    const model= dispatcher.getActiveModel();

    const ctxPct = conv && model ? Math.min(100, (conv.contextTokens / model.contextWindow) * 100) : 0;
    const fhPct  = q.fiveHourPercent || 0;
    const wkPct  = q.weeklyPercent   || 0;
    const quotaUnavailable = q.source === 'unavailable';

    // ── Hash guard: bail if nothing meaningful changed ─────────────────────
    const hash = _computeHash(ctxPct, fhPct, wkPct, q, conv);
    // Always apply theme (even if rest of render is skipped by hash guard)
    _applyOverlayTheme();
    if (hash === _lastRenderHash) return;
    _lastRenderHash = hash;

    // ── Bar colors ─────────────────────────────────────────────────────────
    const cfg = dispatcher.getSettings ? dispatcher.getSettings() : {};
    const _warnAt = (key, def) => cfg[key] ?? def;
    const barColor = (p, wKey, cKey, dW, dC) => {
      const w = _warnAt(wKey, dW), c = _warnAt(cKey, dC);
      return p >= c ? 'var(--tm-red)' : p >= w ? 'var(--tm-amber)' : 'var(--tm-green)';
    };
    const ctxColor = barColor(ctxPct, 'contextWarn',  'contextCritical',  70, 90);
    const fhColor  = barColor(fhPct,  'fiveHourWarn', 'fiveHourCritical', 75, 90);
    const wkColor  = barColor(wkPct,  'weeklyWarn',   'weeklyCritical',   80, 95);

    const tightest    = Math.max(ctxPct, fhPct, wkPct);
    const tightestKey = ctxPct === tightest ? 'context' : (fhPct === tightest ? 'fiveHour' : 'weekly');
    const _barColorFor = k => k === 'context' ? ctxColor : k === 'fiveHour' ? fhColor : wkColor;

    // ── Countdown strings ─────────────────────────────────────────────────
    const fhCd = _fmtCountdown(q.fiveHourReleaseAtMs);
    const wkCd = _fmtCountdown(q.weeklyResetAtMs);

    // ── Status line ────────────────────────────────────────────────────────
    const isCN = (typeof I18N !== 'undefined') && I18N.detect() === 'zh-CN';
    let statusLine = '';
    if (quotaUnavailable) {
      statusLine = isCN
        ? '配额数据不可用 · 请打开 Settings → Usage 激活'
        : 'Quota unavailable · open Settings → Usage once';
    } else if (q.fiveHourReleaseAtMs && fhPct >= _warnAt('fiveHourWarn', 75)) {
      const t = new Date(q.fiveHourReleaseAtMs);
      statusLine = (typeof I18N !== 'undefined')
        ? I18N.t('fiveHour.releases', { time: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
        : `Resets at ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    // ── Streaming detection ───────────────────────────────────────────────
    const _inflight = dispatcher.getInflightStream ? dispatcher.getInflightStream() : null;
    const isStreaming = !!_inflight;

    // ── Anthropic service status banner ───────────────────────────────────
    const svcBanner = _renderServiceBanner();

    // ── Context row (with breakdown) ──────────────────────────────────────
    let ctxRowHtml;
    if (typeof SourceBreakdown !== 'undefined') {
      ctxRowHtml = SourceBreakdown.renderContextRow(ctxPct, ctxColor, conv, model);
    } else {
      ctxRowHtml = _barRowCd('Context', ctxPct, ctxColor, false, null);
    }

    // ── Savings card ──────────────────────────────────────────────────────
    let savingsHtml = '';
    if (typeof SavingsCard !== 'undefined' && SavingsCard.shouldShow(conv, ctxPct)) {
      savingsHtml = SavingsCard.renderCard(conv, ctxPct);
    }

    // ── Labels ────────────────────────────────────────────────────────────
    const fhLabel = (typeof I18N !== 'undefined') ? I18N.t('card.fiveHour') : '5-Hour';
    const wkLabel = (typeof I18N !== 'undefined') ? I18N.t('card.weekly')   : 'Weekly';
    const titleStr = (typeof I18N !== 'undefined') ? I18N.t('header.title') : 'Recall';
    const planLabel = plan.displayName || ((typeof I18N !== 'undefined') ? I18N.t('overlay.unknownPlan') : '?');
    const srcLabel  = q.source === 'fresh' ? '' : q.source === 'stale' ? ' · stale' : ' · ?';

    // ── This-chat footer ──────────────────────────────────────────────────
    const chatMetrics = dispatcher.getChatMetrics ? dispatcher.getChatMetrics() : null;
    const chatPct = chatMetrics?.chatPercentOfQuota != null
      ? Math.round(chatMetrics.chatPercentOfQuota) : null;
    const footerHtml = chatPct != null
      ? `<div class="tm-overlay-footer">
           <span class="tm-footer-label">this chat</span>
           <span class="tm-footer-val">↑ ${chatPct}% of 5h budget</span>
         </div>`
      : '';

    // ── Stale pulse dot ───────────────────────────────────────────────────
    const staleDot = (q.source === 'stale') ? '<span class="tm-pulse-dot" title="Refreshing…"></span>' : '';

    if (collapsed) {
      root.classList.add('tm-is-pill');
      // Pill shows ONLY the context signal — the most reliable and useful
      // number, and the one Anthropic doesn't surface. Quota (5h/Wk) is hidden
      // here (it's fragile / 0 on Free) and remains available on expand.
      const danger = ctxPct >= 80;
      const warn = ctxPct >= 60 && ctxPct < 80;
      const pillState = danger ? 'tm-pill-danger' : warn ? 'tm-pill-warn' : 'tm-pill-ok';
      const isCN = (typeof I18N !== 'undefined') && I18N.detect() === 'zh-CN';
      // Only nudge with words when it actually matters (danger zone).
      const hint = danger ? (isCN ? '快满了' : 'Almost full') : '';
      root.innerHTML = `
        <div class="tm-pill ${pillState}" data-act="drag" title="${_e(isCN ? '点击展开' : 'Click to expand')}">
          <span class="tm-pill-dot" aria-hidden="true"></span>
          <span class="tm-pill-label">${_e(isCN ? '上下文' : 'Context')}</span>
          <span class="tm-pill-val">${Math.round(ctxPct)}%</span>
          ${hint ? `<span class="tm-pill-hint">${_e(hint)}</span>` : ''}
          <button class="tm-pill-expand" data-act="expand" title="${_e(isCN ? '展开' : 'Expand')}" aria-label="expand">⌄</button>
        </div>`;
    } else {
      root.classList.remove('tm-is-pill');
      root.innerHTML = `
        ${svcBanner}
        <div class="tm-overlay-header" data-act="drag">
          <img class="tm-logo" id="tm-logo-img" alt="Recall" />
          <span class="tm-title">${_e(titleStr)}${staleDot}</span>
          <span class="tm-plan">${_e(planLabel)}</span>
          <div class="tm-win-dots">
            <button class="tm-win-dot tm-win-dot-min" data-act="collapse" aria-label="minimize">−</button>
            <button class="tm-win-dot tm-win-dot-close" data-act="close" aria-label="close">×</button>
          </div>
        </div>
        <div class="tm-overlay-body">
          ${ctxRowHtml}
          ${_barRowCd(fhLabel, fhPct, fhColor, quotaUnavailable, fhCd, isStreaming)}
          ${_barRowCd(wkLabel, wkPct, wkColor, quotaUnavailable, wkCd)}
          ${savingsHtml}
          ${_renderTruncationWarning(conv, model)}
          ${statusLine ? `<div class="tm-status-line">${_e(statusLine)}</div>` : ''}
        </div>
        ${footerHtml}`;
    }

    // Set logo src via JS (chrome.runtime.getURL can't go in innerHTML template)
    try {
      const logoEl = root.querySelector('#tm-logo-img');
      if (logoEl) logoEl.src = chrome.runtime.getURL('icons/icon32.png');
    } catch (_) {}

    _applyPosition();
    _bindEvents();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _fmtCountdown(tsMs) {
    if (!tsMs) return null;
    const diff = tsMs - Date.now();
    if (diff <= 0) return null;
    const s = Math.floor(diff / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const d = Math.floor(h / 24);
    if (d >= 1) return `${d}d ${h % 24}h`;
    if (h >= 1) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function _barRowCd(label, pct, color, unknown, countdown, streaming) {
    const cdHtml = countdown ? `<span class="tm-bar-countdown">${countdown}</span>` : '';
    const shimmer = streaming ? ' tm-bar-streaming' : '';
    if (unknown) return `
      <div class="tm-bar-row">
        <span class="tm-bar-label">${_e(label)}</span>
        <div class="tm-bar-track"><div class="tm-bar-fill" style="width:0%;background:var(--tm-border)"></div></div>
        <span class="tm-bar-pct" style="color:var(--tm-text-3)">—</span>${cdHtml}
      </div>`;
    return `
      <div class="tm-bar-row">
        <span class="tm-bar-label">${_e(label)}</span>
        <div class="tm-bar-track"><div class="tm-bar-fill${shimmer}" style="width:${Math.min(100, pct)}%;background:${color}"></div></div>
        <span class="tm-bar-pct" style="color:${color}">${Math.round(pct)}%</span>${cdHtml}
      </div>`;
  }

  function _getServiceLevel() {
    try {
      const c = sessionStorage.getItem('tm:status');
      if (c) return JSON.parse(c).level || 'none';
    } catch (_) {}
    return 'none';
  }

  function _renderServiceBanner() {
    const level = _getServiceLevel();
    // Severity-graded, signal-over-noise:
    //   degraded — hidden. Minor perf dips usually don't affect normal use;
    //              showing them trains users to ignore the banner ("cry wolf").
    //   partial  — amber, gentle "partial issues".
    //   major    — red, clear "outage".
    if (level === 'partial') {
      return `<div class="tm-status-banner tm-status-partial" data-act="open-status">${_e(I18N.t('status.partial'))}</div>`;
    }
    if (level === 'major') {
      return `<div class="tm-status-banner tm-status-major" data-act="open-status">${_e(I18N.t('status.major'))}</div>`;
    }
    return ''; // none or degraded → no banner
  }

  function _renderTruncationWarning(conv, model) {
    if (!conv || !model || !dispatcher.assessTruncationRisk) return '';
    try {
      // Only show if there's an active draft (composer has text)
      const draft = dispatcher._state?.platform?.readComposerDraft?.() || '';
      if (!draft || draft.trim().length < 20) return '';
      const risk = dispatcher.assessTruncationRisk(draft);
      if (!risk?.willLikelyTruncate) return '';
      const isCN = (typeof I18N !== 'undefined') && I18N.detect() === 'zh-CN';
      const needed  = _fmtK(risk.estimatedNeeded);
      const remain  = _fmtK(risk.remainingContext);
      const suggest = risk.suggestion ? `<div class="tm-trunc-suggest">${_e(risk.suggestion)}</div>` : '';
      const msg = isCN
        ? `⚠ 截断风险：需要约 ${needed}，但仅剩 ${remain}`
        : `⚠ Truncation risk: needs ~${needed}, only ${remain} left`;
      return `<div class="tm-trunc-warning">${_e(msg)}${suggest}</div>`;
    } catch (_) { return ''; }
  }

  function _fmtK(n) {
    if (!n || n < 1000) return (n || 0) + '';
    return (n / 1000).toFixed(1) + 'k';
  }

  function _e(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  let _windowListenersAttached = false; // one-time: mousemove/mouseup on window
  function _bindEvents() {
    if (_eventsAttached) return;
    _eventsAttached = true;

    // Root click: registered ONCE — no accumulation across expand/collapse cycles
    if (!_rootClickAttached) {
      _rootClickAttached = true;
      root.addEventListener('click', async (e) => {
        const act       = e.target.closest('[data-act]')?.dataset.act;
        const actSavings= e.target.closest('[data-act-savings]')?.dataset.actSavings;

        if (act === 'expand' && !_wasDragged) { collapsed = false; try { localStorage.setItem('tm:overlay:collapsed','0'); } catch(_){} _forceRender(); }
        if (act === 'collapse') { collapsed = true;  try { localStorage.setItem('tm:overlay:collapsed','1'); } catch(_){} _forceRender(); }
        if (act === 'close') {
          root.classList.add('tm-closing');
          setTimeout(() => {
            root.style.display = 'none';
            root.classList.remove('tm-closing');
            try { chrome.storage.local.set({'ui:overlayHidden':true}); } catch(_){}
          }, 130);
        }
        if (act === 'open-status') { window.open('https://status.anthropic.com'); }

        if (act === 'toggle-breakdown' && typeof SourceBreakdown !== 'undefined') {
          SourceBreakdown.toggle();
          _forceRender();
        }

        if (actSavings && typeof SavingsCard !== 'undefined') {
          const conv = dispatcher ? dispatcher.getConversation() : null;
          await SavingsCard.handleAction(actSavings, conv);
          _forceRender();
        }
      });
    }

    // Drag — works in both expanded and collapsed states
    let dragStart  = null;
    let _wasDragged = false; // suppress expand-click if user actually dragged
    root.addEventListener('mousedown', (e) => {
      if (!e.target.closest('[data-act="drag"]')) return;
      if (e.target.closest('[data-act="collapse"],[data-act="close"]')) return;
      dragStart   = { x: e.clientX - position.x, y: e.clientY - position.y };
      _wasDragged = false;
      e.preventDefault();
    });
    if (!_windowListenersAttached) {
      _windowListenersAttached = true;
      window.addEventListener('mousemove', (e) => {
        if (!dragStart) return;
        const dx = e.clientX - (dragStart.x + position.x);
        const dy = e.clientY - (dragStart.y + position.y);
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) _wasDragged = true;
        position.x = e.clientX - dragStart.x;
        position.y = e.clientY - dragStart.y;
        _clampPosition(); _applyPosition();
      });
      window.addEventListener('mouseup', () => {
        if (dragStart) { try { localStorage.setItem('tm:overlay:pos', JSON.stringify(position)); } catch(_){} }
        dragStart = null;
      });
    }
  }

  function show() { if (root) { root.style.display=''; try { chrome.storage.local.remove('ui:overlayHidden'); } catch(_){} } }
  function hide() { if (root) root.style.display='none'; }
  function unmount() {
    if (root) { root.remove(); root=null; }
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer=null; }
    _eventsAttached = false;
    _lastRenderHash = '';
  }

  return { mount, render, show, hide, unmount };

})();
