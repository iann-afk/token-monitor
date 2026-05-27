// ui/overlay.js — floating widget on Claude page

const Overlay = (function () {

  let root = null;
  let dispatcher = null;
  let collapsed = false;  // restored from localStorage in mount()
  let _eventsAttached = false;
  let position = { x: 16, y: window.innerHeight - 280 };

  function mount(d) {
    dispatcher = d;
    if (root) return;
    root = document.createElement('div');
    root.className = 'tm-overlay';
    root.dataset.tmWidget = 'overlay';
    document.body.appendChild(root);

    // Restore last position and collapsed state
    try {
      const saved = JSON.parse(localStorage.getItem('tm:overlay:pos') || 'null');
      if (saved && typeof saved.x === 'number') position = saved;
    } catch (_) {}
    try { collapsed = localStorage.getItem('tm:overlay:collapsed') === '1'; } catch (_) {}
    _clampPosition();
    window.addEventListener('resize', () => { _clampPosition(); _applyPosition(); });

    // Restore hidden state ONCE on mount — not on every render.
    // Default = visible. Only hide if the user explicitly closed it before.
    try {
      chrome.storage.local.get('ui:overlayHidden', (r) => {
        if (r?.['ui:overlayHidden']) root.style.display = 'none';
      });
    } catch (_) {}
  }

  function _clampPosition() {
    const W = window.innerWidth, H = window.innerHeight;
    position.x = Math.max(0, Math.min(position.x, W - 260));
    position.y = Math.max(0, Math.min(position.y, H - 60));
  }

  function _applyPosition() {
    if (!root) return;
    root.style.left = position.x + 'px';
    root.style.top = position.y + 'px';
  }

  function render() {
    if (!root || !dispatcher) return;
    const q = dispatcher.getQuota();
    const plan = dispatcher.getPlan();
    const conv = dispatcher.getConversation();
    const model = dispatcher.getActiveModel();

    const ctxPct = conv && model ? Math.min(100, (conv.contextTokens / model.contextWindow) * 100) : 0;
    const fhPct = q.fiveHourPercent || 0;
    const wkPct = q.weeklyPercent || 0;
    const quotaUnavailable = q.source === 'unavailable';

    // Use user-configured thresholds; fall back to sensible defaults
    const cfg = dispatcher.getSettings ? dispatcher.getSettings() : {};
    const _warnAt = (key, def) => cfg[key] ?? def;
    const barColor = (p, warnKey, critKey, defWarn, defCrit) => {
      const w = _warnAt(warnKey, defWarn), c = _warnAt(critKey, defCrit);
      return p >= c ? 'var(--tm-red)' : p >= w ? 'var(--tm-amber)' : 'var(--tm-green)';
    };
    const ctxColor = barColor(ctxPct, 'contextWarn',  'contextCritical',  70, 90);
    const fhColor  = barColor(fhPct,  'fiveHourWarn', 'fiveHourCritical', 75, 90);
    const wkColor  = barColor(wkPct,  'weeklyWarn',   'weeklyCritical',   80, 95);
    const _barColorFor = (key) => key === 'context' ? ctxColor : key === 'fiveHour' ? fhColor : wkColor;

    const tightest = Math.max(ctxPct, fhPct, wkPct);
    const tightestKey = ctxPct === tightest ? 'context' : (fhPct === tightest ? 'fiveHour' : 'weekly');

    let statusLine = '';
    if (quotaUnavailable) {
      statusLine = (I18N.t('header.title') === 'Token 监控')
        ? '配额数据不可用 · 请打开 Settings → Usage 一次以激活'
        : 'Quota unavailable · open Settings → Usage once to activate';
    } else if (q.fiveHourReleaseAtMs && fhPct >= _warnAt('fiveHourWarn', 75)) {
      const t = new Date(q.fiveHourReleaseAtMs);
      statusLine = I18N.t('fiveHour.releases', { time: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    } else if (fhPct >= _warnAt('fiveHourWarn', 75) && dispatcher._state.calibration.estimatedFiveHourBudget) {
      const remaining = Math.max(0, 100 - fhPct);
      const recentAvg = (() => {
        const rt = dispatcher.getChatMetrics().recentTurnTokens;
        if (!rt.length) return null;
        return rt.reduce((s, n) => s + n, 0) / rt.length;
      })();
      if (recentAvg) {
        const budget = dispatcher._state.calibration.estimatedFiveHourBudget;
        const remainingTokens = budget * (remaining / 100);
        const msgsLeft = Math.max(1, Math.round(remainingTokens / recentAvg));
        statusLine = I18N.t('fiveHour.subtitle', { n: msgsLeft });
      }
    }

    if (collapsed) {
      root.innerHTML = `
        <div class="tm-overlay-collapsed" data-act="expand">
          <span class="tm-mini-pct" style="color: ${_barColorFor(tightestKey)}">${Math.round(tightest)}%</span>
          <span class="tm-mini-label">${I18N.t('card.' + tightestKey)}</span>
        </div>
      `;
    } else {
      const sourceLabel = q.source === 'fresh' ? '' : (q.source === 'stale' ? ' · stale' : ' · ?');
      root.innerHTML = `
        <div class="tm-overlay-header" data-act="drag">
          <span class="tm-grip" aria-hidden="true">⋮⋮</span>
          <span class="tm-title">${I18N.t('header.title')}</span>
          <span class="tm-plan">${plan.displayName || I18N.t('overlay.unknownPlan')}${sourceLabel}</span>
          <button class="tm-icon-btn" data-act="collapse" aria-label="${I18N.t('overlay.minimize')}">–</button>
          <button class="tm-icon-btn" data-act="close" aria-label="${I18N.t('overlay.close')}">×</button>
        </div>
        <div class="tm-overlay-body">
          ${_barRow(I18N.t('card.context'), ctxPct, ctxColor, false)}
          ${_barRow(I18N.t('card.fiveHour'), fhPct, fhColor, quotaUnavailable)}
          ${_barRow(I18N.t('card.weekly'), wkPct, wkColor, quotaUnavailable)}
          ${statusLine ? `<div class="tm-status-line">${_escape(statusLine)}</div>` : ''}
        </div>
      `;
    }

    _applyPosition();
    _bindEvents();
  }

  function _barRow(label, pct, color, unknown) {
    if (unknown) {
      return `
        <div class="tm-bar-row">
          <span class="tm-bar-label">${_escape(label)}</span>
          <div class="tm-bar-track">
            <div class="tm-bar-fill" style="width: 0%; background: var(--tm-border);"></div>
          </div>
          <span class="tm-bar-pct" style="color: var(--tm-text-3)">—</span>
        </div>
      `;
    }
    return `
      <div class="tm-bar-row">
        <span class="tm-bar-label">${_escape(label)}</span>
        <div class="tm-bar-track">
          <div class="tm-bar-fill" style="width: ${Math.min(100, pct)}%; background: ${color};"></div>
        </div>
        <span class="tm-bar-pct" style="color: ${color}">${Math.round(pct)}%</span>
      </div>
    `;
  }

  function _bindEvents() {
    if (_eventsAttached) return;
    _eventsAttached = true;
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'expand') { collapsed = false; try { localStorage.setItem('tm:overlay:collapsed','0'); } catch(_){} render(); }
      else if (act === 'collapse') { collapsed = true; try { localStorage.setItem('tm:overlay:collapsed','1'); } catch(_){} render(); }
      else if (act === 'close') {
        root.style.display = 'none';
        try { chrome.storage.local.set({ 'ui:overlayHidden': true }); } catch(_) {}
      }
    });

    // Bug 1 fix: attach mousedown to `root` (which persists across renders)
    // rather than to the specific drag-handle element (destroyed on innerHTML replace).
    let dragStart = null;
    root.addEventListener('mousedown', (e) => {
      if (!e.target.closest('[data-act="drag"]')) return;
      if (e.target.closest('[data-act="collapse"], [data-act="close"]')) return;
      dragStart = { x: e.clientX - position.x, y: e.clientY - position.y };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragStart) return;
      position.x = e.clientX - dragStart.x;
      position.y = e.clientY - dragStart.y;
      _clampPosition();
      _applyPosition();
    });
    window.addEventListener('mouseup', () => {
      if (dragStart) { try { localStorage.setItem('tm:overlay:pos', JSON.stringify(position)); } catch (_) {} }
      dragStart = null;
    });
  }

  function _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function show() {
    if (root) {
      root.style.display = '';
      try { chrome.storage.local.remove('ui:overlayHidden'); } catch(_) {}
    }
  }

  function hide() {
    if (root) {
      root.style.display = 'none';
      try { chrome.storage.local.set({ 'ui:overlayHidden': true }); } catch(_) {}
    }
  }

  return { mount, render, show, hide };
})();
