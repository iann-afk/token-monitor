// popup.js — renders the main dashboard.

// ─────────────────────────────────────────────────────────────────────────────
// BUILD FLAG — dev vs. release.
//   IS_DEV = true  → development build: shows dev-only tools (e.g. Bug Report).
//   IS_DEV = false → release build: dev-only tools are hidden.
//
// HOW TO USE: keep this `false` for the public/Web-Store build. When you want a
// development build (to use the Bug Report self-test tool), flip it to `true`
// before loading unpacked. The code for those tools is NOT deleted — it's only
// hidden from the UI when IS_DEV is false, so flipping this back reveals it.
// ─────────────────────────────────────────────────────────────────────────────
const IS_DEV = false;

(function () {
  const root = document.getElementById('root');
  let state = {
    quota: null,
    plan: null,
    model: null,
    chatMetrics: null,
    conversation: null,
    scanDiag: null,
    summaryZone: 'none',
    settings: null,
    lastUpdate: 0,
    isClaudeTab: false,    // whether the active tab is a live Claude tab
    overlayHidden: false,  // mirrors ui:overlayHidden in storage
  };

  // ── Theme application ─────────────────────────────────────────────────────
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.dataset.theme = 'dark';
    } else if (theme === 'light') {
      root.dataset.theme = 'light';
    } else {
      root.removeAttribute('data-theme');
    }
  }

  async function loadAll() {
    const [{ recallSettings }, quotaData, planData, overlayData] = await Promise.all([
      chrome.storage.sync.get('recallSettings'),
      chrome.storage.local.get('quota:claude'),
      chrome.storage.local.get('plan:claude'),
      chrome.storage.local.get('ui:overlayHidden'),
    ]);
    state.overlayHidden = overlayData?.['ui:overlayHidden'] === true;
    state.settings = recallSettings || {};
    state.quota = quotaData['quota:claude'] || { fiveHourPercent: 0, weeklyPercent: 0, source: 'unavailable', fetchedAtMs: 0 };
    state.plan = planData['plan:claude'] || { tier: 'unknown', displayName: 'Unknown' };

    // Apply language preference
    if (state.settings.language && state.settings.language !== 'auto') {
      I18N.setLang(state.settings.language);
    }

    // Apply saved theme
    applyTheme(state.settings.theme || 'system');

    // Get live state from active tab
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      state.isClaudeTab = !!(tab && /claude\.ai/.test(tab.url || ''));
      if (state.isClaudeTab) {
        chrome.tabs.sendMessage(tab.id, { type: 'TM_GET_LIVE' }, (resp) => {
          if (chrome.runtime.lastError) {
            // Content script not ready or not on this tab
            void chrome.runtime.lastError;
            return;
          }
          if (resp) {
            state.model = resp.model;
            state.chatMetrics = resp.chatMetrics;
            state.conversation = resp.conversation;
            state.scanDiag = resp.scanDiag;
            state.summaryZone = resp.summaryZone || 'none';
            state.allChats = resp.allChats || null;
            // Bug 4 fix (part 2): receive calibration so fhSub can use real budget
            state.calibration = resp.calibration || null;
            render();
          }
        });
      }
    } catch (_) {}

    state.lastUpdate = state.quota.fetchedAtMs || Date.now();
    render();
  }

  function render() {
    const q = state.quota || {};
    // Context bar uses LIVE DOM-scanned tokens (Dispatcher.getConversation),
    // NOT chatMetrics.totalTokens — chatMetrics only accumulates after each
    // turn streams to completion, so it's 0 when you open an existing chat.
    const liveContextTokens = state.conversation?.contextTokens || 0;
    const ctxPct = state.model && liveContextTokens
      ? Math.min(100, (liveContextTokens / state.model.contextWindow) * 100)
      : 0;
    const fhPct = q.fiveHourPercent || 0;
    const wkPct = q.weeklyPercent || 0;

    const tightest = Math.max(ctxPct, fhPct, wkPct);
    const fhWarn = fhPct >= (state.settings.fiveHourWarn || 75);
    const ctxWarn = ctxPct >= (state.settings.contextWarn || 70);
    const wkWarn = wkPct >= (state.settings.weeklyWarn || 80);

    const planLabel = state.plan?.displayName || I18N.t('overlay.unknownPlan');
    const modelLabel = state.model?.displayName || '—';

    const sinceMin = Math.max(0, Math.floor((Date.now() - state.lastUpdate) / 60000));
    const updateLabel = sinceMin === 0 ? I18N.t('header.justNow') : I18N.t('header.lastUpdate', { n: sinceMin });

    const burnX = (() => {
      if (!state.chatMetrics || !state.chatMetrics.firstTurnTokens || !state.chatMetrics.recentTurnTokens?.length) return null;
      const recent = state.chatMetrics.recentTurnTokens;
      const avg = recent.reduce((s, n) => s + n, 0) / recent.length;
      const x = avg / state.chatMetrics.firstTurnTokens;
      return x >= 1.5 ? x.toFixed(1) : null;
    })();

    const ctxSub = state.model
      ? I18N.t('context.subtitle', {
          used: (liveContextTokens / 1000).toFixed(0),
          total: (state.model.contextWindow / 1000).toFixed(0),
        }) + (burnX ? ' ' + I18N.t('context.burnRate', { x: burnX }) : '')
      : '—';

    const fhSub = (() => {
      const burnMult = state.model?.burnRateMultiplier || 1;
      const burnTag = burnMult >= 2
        ? ` · ${burnMult}× burn${burnMult >= 5 ? ' (Opus)' : ''}`
        : (burnMult <= 0.3 ? ' · 0.2× burn (Haiku)' : '');
      // Free plan has no 5-hour rolling window.
      // Signal: fhPct===0 AND no release timestamp (API returns resets_at: null for Free)
      if (fhPct === 0 && !q.fiveHourReleaseAtMs && (state.plan?.tier === 'free' || state.plan?.tier === 'unknown')) {
        return 'Free plan · no 5-hour window · weekly cap applies';
      }
      if (state.chatMetrics?.recentTurnTokens?.length && fhPct > 0) {
        const remaining = Math.max(0, 100 - fhPct);
        const recent = state.chatMetrics.recentTurnTokens;
        const avg = recent.reduce((s, n) => s + n, 0) / recent.length;
        // Bug 4 fix: use calibrated budget when available; fall back to a
        // plan-aware default instead of a hardcoded Pro-only 220 000.
        const calibBudget = state.calibration?.estimatedFiveHourBudget ?? null;
        const planTier = state.plan?.tier || 'unknown';
        const planFallback = planTier === 'free' ? 20000
          : planTier === 'max-5x' ? 1100000
          : planTier === 'max-20x' ? 4400000
          : 220000; // pro / team / unknown
        const budget = calibBudget || planFallback;
        const remainingTokens = budget * (remaining / 100);
        const msgs = Math.max(1, Math.round(remainingTokens / Math.max(1, avg)));
        return I18N.t('fiveHour.subtitle', { n: msgs }) + burnTag;
      }
      if (fhPct === 0 && q.source === 'fresh') return '5h window just reset ✓' + burnTag;
      if (burnMult >= 2) return `${burnMult}× burn rate · switch to Sonnet to save quota`;
      return I18N.t('fiveHour.subtitleNoBudget');
    })();

    const wkSub = (() => {
      if (wkPct >= 100) {
        const d = q.weeklyResetAtMs ? new Date(q.weeklyResetAtMs) : null;
        const days = d ? Math.max(0, Math.ceil((q.weeklyResetAtMs - Date.now()) / (24 * 3600 * 1000))) : '?';
        const resetStr = d ? `Resets ${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
        return `Weekly limit reached · ${resetStr} (${days}d)`;
      }
      if (!q.weeklyResetAtMs) return '';
      const d = new Date(q.weeklyResetAtMs);
      const days = Math.max(0, Math.ceil((q.weeklyResetAtMs - Date.now()) / (24 * 3600 * 1000)));
      return I18N.t('weekly.subtitle', {
        day: d.toLocaleDateString([], { weekday: 'short' }),
        time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        days,
      });
    })();

    // Chat metrics percentages
    const cm = state.chatMetrics || { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, chatPercentOfQuota: null };
    const ioTotal = (cm.inputTokens || 0) + (cm.outputTokens || 0);
    const inputPct = ioTotal ? (cm.inputTokens / ioTotal) * 100 : 0;
    const outputPct = ioTotal ? (cm.outputTokens / ioTotal) * 100 : 0;

    // Summary button
    const zone = state.summaryZone;
    let summaryLabel = null;
    if (zone === 'green') summaryLabel = I18N.t('btn.summarizeGreen');
    else if (zone === 'amber') summaryLabel = I18N.t('btn.summarizeAmber');
    else if (zone === 'red') summaryLabel = I18N.t('btn.summarizeRed');

    // Pre-compute button HTML (avoids nested template-literal escaping issues)
    const _atLimit  = (state.quota?.fiveHourPercent ?? 0) >= 100 || (state.quota?.weeklyPercent ?? 0) >= 100;
    const _noTab    = !state.isClaudeTab;
    const _noTabA   = _noTab ? ' disabled title="' + esc(I18N.t('btn.notOnClaude')) + '"' : '';
    const _newCls   = _atLimit ? 'btn btn-warn' : 'btn';
    const _newLbl   = _atLimit ? '⚠ ' + esc(I18N.t('btn.newChat.atLimit')) : '＋ ' + esc(I18N.t('btn.newChat'));
    const _ovLbl    = state.overlayHidden ? '⧇ ' + esc(I18N.t('btn.showOverlay')) : '⊡ ' + esc(I18N.t('btn.hideOverlay'));
    const _btnNewHtml     = '<button class="' + _newCls + '" id="btn-new"' + _noTabA + '>' + _newLbl + '</button>';
    const _btnRefreshHtml = '<button class="btn" id="btn-refresh">↻ ' + esc(I18N.t('btn.recheck')) + '</button>';
    const _btnOverlayHtml = '<button class="btn" id="btn-show-overlay"' + _noTabA + '>' + _ovLbl + '</button>';
    const _btnExportMdHtml = '<button class="btn" id="btn-export-md"' + _noTabA + '>💾 ' + esc(I18N.t('btn.exportChat')) + '</button>';
    root.innerHTML = `
      <div class="section">
        <div class="header">
          <img class="header-icon-img" src="../icons/icon48.png" alt="Recall" />
          <div class="header-text">
            <div class="header-title">${esc(I18N.t('header.title'))}</div>
            <div class="header-sub">Claude · ${esc(modelLabel)} · ${esc(planLabel)}</div>
          </div>
          <span class="header-time">${esc(updateLabel)}</span>
        </div>
      </div>

      <div class="section">
        ${quotaCard('context', I18N.t('card.context'), ctxPct, ctxWarn, ctxSub)}
        ${quotaCard('fiveHour', I18N.t('card.fiveHour'), fhPct, fhWarn, fhSub)}
        ${quotaCard('weekly', I18N.t('card.weekly'), wkPct, wkWarn, wkSub)}
      </div>

      ${cm.turns > 0 ? `
      <div class="section">
        <div class="kv-row" style="margin-bottom:8px">
          <span class="kv-label">${esc(I18N.t('thisChat.title'))}</span>
          <span class="kv-value">${esc(I18N.t('thisChat.summary', { pct: (cm.chatPercentOfQuota || 0).toFixed(0) }))}</span>
        </div>
        <div class="chat-row">
          <span class="chat-row-label">${esc(I18N.t('thisChat.input'))}</span>
          <div class="chat-row-track"><div class="chat-row-fill" style="width:${inputPct}%"></div></div>
          <span class="chat-row-pct">${inputPct.toFixed(0)}%</span>
        </div>
        <div class="chat-row" style="margin-bottom:8px">
          <span class="chat-row-label">${esc(I18N.t('thisChat.output'))}</span>
          <div class="chat-row-track"><div class="chat-row-fill" style="width:${outputPct}%"></div></div>
          <span class="chat-row-pct">${outputPct.toFixed(0)}%</span>
        </div>
        <div class="card-sub">${esc(I18N.t('thisChat.turns', { turns: cm.turns, tokens: (ioTotal / 1000).toFixed(1) }))}</div>
      </div>` : ''}

      ${state.allChats?.chatCount > 1 ? `
      <div class="section">
        <div class="kv-row">
          <span class="kv-label">All chats this session</span>
          <span class="kv-value">${state.allChats.chatCount} chats · ${(state.allChats.totalTokens / 1000).toFixed(1)}k tokens</span>
        </div>
        <div class="card-sub">${state.allChats.totalTurns} turns · ${(state.allChats.totalInput / 1000).toFixed(1)}k in · ${(state.allChats.totalOutput / 1000).toFixed(1)}k out</div>
      </div>` : ''}

      <div class="btn-row">
        ${_btnNewHtml}${_btnRefreshHtml}${_btnOverlayHtml}${_btnExportMdHtml}
      </div>


      ${summaryLabel ? `
      <div class="section" style="border-top: none; padding-top: 0;">
        <button class="btn-summary" data-zone="${zone}" id="btn-summary">${esc(summaryLabel)}</button>
      </div>` : ''}

      <div class="section">
        <div class="settings-title">${esc(I18N.t('settings.thresholds'))}</div>
        ${thresholdRow(I18N.t('settings.contextWarn'), 'contextWarn', 'contextCritical', 70, 90)}
        ${thresholdRow(I18N.t('settings.fiveHourWarn'), 'fiveHourWarn', 'fiveHourCritical', 75, 90)}
        ${thresholdRow(I18N.t('settings.weeklyWarn'), 'weeklyWarn', 'weeklyCritical', 80, 95)}
      </div>

      <div class="section">
        <div class="kv-row">
          <span class="kv-label">${esc(I18N.t('settings.sound'))}</span>
          <div style="display:flex;gap:6px;align-items:center;">
            <select class="kv-select" id="sel-sound" style="flex:1;">
              <option value="off"${state.settings.soundType === 'off' ? ' selected' : ''}>${esc(I18N.t('sound.off'))}</option>
              <option value="soft"${(state.settings.soundType || 'soft') === 'soft' ? ' selected' : ''}>${esc(I18N.t('sound.soft'))}</option>
              <option value="chime"${state.settings.soundType === 'chime' ? ' selected' : ''}>${esc(I18N.t('sound.chime'))}</option>
              <option value="pop"${state.settings.soundType === 'pop' ? ' selected' : ''}>${esc(I18N.t('sound.pop'))}</option>
              <option value="alert"${state.settings.soundType === 'alert' ? ' selected' : ''}>${esc(I18N.t('sound.alert'))}</option>
              <option value="urgent"${state.settings.soundType === 'urgent' ? ' selected' : ''}>${esc(I18N.t('sound.urgent'))}</option>
            </select>
            <button id="btn-preview-sound" style="padding:3px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-2);font-size:11px;cursor:pointer;flex-shrink:0;">${esc(I18N.t('sound.preview'))}</button>
          </div>
        </div>
        <div class="kv-row">
          <span class="kv-label">${esc(I18N.t('settings.language'))}</span>
          <select class="kv-select" id="sel-lang">
            <option value="auto"${state.settings.language === 'auto' ? ' selected' : ''}>Auto</option>
            <option value="en"${state.settings.language === 'en' ? ' selected' : ''}>English</option>
            <option value="zh-CN"${state.settings.language === 'zh-CN' ? ' selected' : ''}>中文</option>
          </select>
        </div>
        <div class="kv-row">
          <span class="kv-label">${esc(I18N.t('settings.notifyRefill'))}</span>
          <div class="toggle ${state.settings.notifyOnRefill !== false ? 'on' : ''}" id="toggle-notify"></div>
        </div>
        <div class="kv-row">
          <span class="kv-label">Dark mode</span>
          <div class="theme-switcher" id="theme-switcher">
            <button class="theme-btn ${state.settings.theme === 'light' ? 'active' : ''}" data-theme="light">&#9728; Light</button>
            <button class="theme-btn ${(!state.settings.theme || state.settings.theme === 'system') ? 'active' : ''}" data-theme="system">Auto</button>
            <button class="theme-btn ${state.settings.theme === 'dark' ? 'active' : ''}" data-theme="dark">&#9790; Dark</button>
          </div>
        </div>
      </div>

      ${renderLimitLayers(ctxPct, fhPct, wkPct, liveContextTokens)}

      <div class="footer">
        ${esc(I18N.t('footer.disclaimer'))}
        <div style="margin-top:8px;display:flex;justify-content:center;">
          ${IS_DEV ? `<button id="btn-bug-report" style="display:inline-flex;align-items:center;gap:4px;padding:4px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-3);font-size:11px;cursor:pointer;font-family:inherit;">🐛 ${esc(I18N.t('btn.bugReport'))}</button>` : ''}
        </div>
      </div>
    `;

    bindEvents();
  }

  function quotaCard(id, label, pct, warn, sub) {
    const fillColor = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--amber)' : 'var(--green)';
    const pctColor  = pct > 90 ? 'color:var(--red)' : pct > 70 ? 'color:var(--amber)' : 'color:var(--green)';
    const isWarn = warn && pct > 70;
    return `
      <div class="card ${isWarn ? 'warn-card' : ''}">
        <div class="card-head">
          <span class="card-label">${isWarn ? '⚠ ' : ''}${esc(label)}</span>
          <span class="card-pct" style="${isWarn ? '' : pctColor}">${pct.toFixed(0)}%</span>
        </div>
        <div class="card-track"><div class="card-fill" style="width:${Math.min(100, pct)}%; background:${fillColor};"></div></div>
        <div class="card-sub">${esc(sub || '')}</div>
      </div>
    `;
  }

  function thresholdRow(label, warnKey, critKey, warnDef, critDef) {
    const w = state.settings[warnKey] != null ? state.settings[warnKey] : warnDef;
    const c = state.settings[critKey] != null ? state.settings[critKey] : critDef;
    return `
      <div class="kv-row">
        <span class="kv-label">${esc(label)}</span>
        <span class="kv-pair">
          <input type="number" class="kv-input" data-setting="${warnKey}" value="${w}" min="0" max="100" /> /
          <input type="number" class="kv-input" data-setting="${critKey}" value="${c}" min="0" max="100" />
        </span>
      </div>
    `;
  }

  /**
   * P2: Multi-layer rate-limit explainer.
   * Helps users understand why they get 429 even when quota bar shows < 100%.
   */


  // ── Self-test report modal (v2.1.1) ───────────────────────────────────────
  function _showReportModal(reportText) {
    // Remove any existing modal
    document.getElementById('tm-report-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'tm-report-modal';
    overlay.style.cssText = [
      'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999',
      'display:flex;align-items:center;justify-content:center;padding:16px',
    ].join(';');

    overlay.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;
                  width:100%;max-width:480px;max-height:80vh;display:flex;flex-direction:column;
                  box-shadow:0 8px 32px rgba(0,0,0,0.3);">
        <div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);">
          <span style="font-weight:600;font-size:13px;flex:1;">🐛 Self-Test Report</span>
          <button id="tm-report-close" style="background:none;border:none;font-size:18px;cursor:pointer;
                  color:var(--text-3);padding:0 4px;">×</button>
        </div>
        <textarea id="tm-report-text" readonly style="flex:1;margin:12px 16px;padding:10px;
                  font-family:monospace;font-size:11px;line-height:1.5;
                  background:var(--bg-2);border:1px solid var(--border);border-radius:6px;
                  color:var(--text);resize:none;min-height:240px;outline:none;"
        ></textarea>
        <div style="padding:8px 16px 14px;display:flex;gap:8px;justify-content:flex-end;">
          <button id="tm-report-copy" style="padding:6px 14px;border-radius:6px;border:1px solid var(--border);
                  background:var(--bg-2);color:var(--text-2);font-size:12px;cursor:pointer;font-family:inherit;">
            Copy again
          </button>
          <button id="tm-report-close2" style="padding:6px 14px;border-radius:6px;border:none;
                  background:var(--text);color:var(--bg);font-size:12px;cursor:pointer;font-family:inherit;">
            Close
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // Set textarea value AFTER appending (avoids XSS via innerHTML)
    document.getElementById('tm-report-text').value = reportText;

    const close = () => overlay.remove();
    document.getElementById('tm-report-close').addEventListener('click', close);
    document.getElementById('tm-report-close2').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('tm-report-copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(reportText);
      document.getElementById('tm-report-copy').textContent = '✓ Copied';
      setTimeout(() => {
        const btn = document.getElementById('tm-report-copy');
        if (btn) btn.textContent = 'Copy again';
      }, 2000);
    });

    // Select all text when textarea is focused
    document.getElementById('tm-report-text').addEventListener('focus', function() {
      this.select();
    });
  }

  function renderLimitLayers(ctxPct, fhPct, wkPct, ctxTokens) {
    const isCN = I18N.detect() === 'zh-CN';

    // RPM: rough heuristic — flag when ctx > 150k (heavy conversation → slow processing)
    const rpmWarn = ctxTokens > 150000;
    // TPM: flag when context is very heavy
    const tpmWarn = ctxTokens > 120000;

    const row = (dotColor, label, statusText, warn, tip, rowId) => `
      <div class="tm-layer-row" id="${rowId}">
        <div class="tm-layer-dot" style="background:${dotColor}"></div>
        <span class="tm-layer-label">${esc(label)}</span>
        <button class="tm-layer-info-btn" data-tip="${esc(tip)}" data-row="${rowId}" aria-label="Learn more">ⓘ</button>
        <span class="tm-layer-status" style="color:${warn ? 'var(--amber)' : 'var(--green)'}">${esc(statusText)}</span>
      </div>
      <div class="tm-layer-detail" id="${rowId}-detail" hidden>
        <div class="tm-layer-detail-text">${esc(tip)}</div>
      </div>`;

    const title = isCN ? '限速层说明' : 'Rate limit layers';
    const sub   = isCN
      ? '配额条只反映第3层。429 错误可能来自任意一层。'
      : 'Quota bars only show layer 3. A 429 error can fire from any layer.';

    return `
      <div class="section">
        <div class="section-label">${esc(title)}</div>
        <div class="card" style="padding:8px 12px;">
          <div style="font-size:10px;color:var(--text-3);margin-bottom:6px;">${esc(sub)}</div>
          ${row(
            rpmWarn ? 'var(--amber)' : 'var(--green)',
            isCN ? '每分钟请求数 (RPM)' : 'Requests / min (RPM)',
            rpmWarn ? (isCN ? '⚠ 重量对话' : '⚠ Heavy chat') : (isCN ? '正常' : 'OK'),
            rpmWarn,
            isCN ? '对话越长，Claude 处理越慢，频繁发送可能触发 RPM（每分钟请求次数）限制，导致 429 错误——即使配额显示还有余量。' : 'Long chats take longer to process. Sending too quickly can trigger RPM (requests per minute) limits and cause 429 errors — even when your quota bar shows headroom.',
            'layer-rpm'
          )}
          ${row(
            tpmWarn ? 'var(--amber)' : 'var(--green)',
            isCN ? '每分钟 Token 数 (TPM)' : 'Tokens / min (TPM)',
            tpmWarn ? (isCN ? `⚠ ~${(ctxTokens/1000).toFixed(0)}k tokens` : `⚠ ~${(ctxTokens/1000).toFixed(0)}k ctx`) : (isCN ? '正常' : 'OK'),
            tpmWarn,
            isCN ? `当前对话上下文约 ${(ctxTokens/1000).toFixed(0)}k tokens。上下文越大，每条消息消耗的 TPM 越多。超过 120k 时尤其容易触发 TPM 限制，建议开启新对话。` : `Current context is ~${(ctxTokens/1000).toFixed(0)}k tokens. Larger context burns more TPM per message. Above 120k tokens you're most likely to hit TPM limits — starting a new chat helps.`,
            'layer-tpm'
          )}
          ${row(
            fhPct > 90 ? 'var(--red)' : fhPct > 75 ? 'var(--amber)' : 'var(--green)',
            isCN ? '5小时配额' : '5-Hour quota',
            fhPct > 90 ? (isCN ? '⚠ 几乎耗尽' : '⚠ Near limit') : `${Math.round(fhPct)}% ${isCN ? '已用' : 'used'}`,
            fhPct > 75,
            isCN ? '这是 Claude 的滚动 5 小时使用窗口。消费越多、模型越贵（Opus 消耗 5 倍），耗尽越快。仪表盘显示的百分比即为此层。' : 'This is Claude\'s rolling 5-hour usage window. Heavier models cost more quota (Opus = 5×). The percentage shown in your Claude dashboard reflects this layer.',
            'layer-5h'
          )}
          ${row(
            wkPct > 95 ? 'var(--red)' : wkPct > 80 ? 'var(--amber)' : 'var(--green)',
            isCN ? '周配额' : 'Weekly quota',
            wkPct > 95 ? (isCN ? '⚠ 已达上限' : '⚠ At limit') : `${Math.round(wkPct)}% ${isCN ? '已用' : 'used'}`,
            wkPct > 80,
            isCN ? '每周重置一次（周一 00:00 UTC）的总使用配额。Pro 和 Max 计划的周配额不同。达到上限后需等到下周才能继续使用。' : 'Total weekly usage budget, resets Monday 00:00 UTC. Pro and Max have different weekly caps. Once hit, you must wait until the weekly reset.',
            'layer-wk'
          )}
        </div>
      </div>`;
  }

  function bindEvents() {
    document.getElementById('btn-show-overlay')?.addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        if (state.overlayHidden) {
          // Show overlay
          chrome.tabs.sendMessage(tabs[0].id, { type: 'TM_SHOW_OVERLAY' }, () => void chrome.runtime.lastError);
          chrome.storage.local.remove('ui:overlayHidden');
          state.overlayHidden = false;
        } else {
          // Hide overlay
          chrome.tabs.sendMessage(tabs[0].id, { type: 'TM_HIDE_OVERLAY' }, () => void chrome.runtime.lastError);
          chrome.storage.local.set({ 'ui:overlayHidden': true });
          state.overlayHidden = true;
        }
        render(); // update button label immediately
      });
    });

    document.getElementById('btn-refresh')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '⏳ ' + I18N.t('btn.recheck.loading');

      // Must be on a Claude tab for a refresh to mean anything.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const onClaude = !!(tab && /claude\.ai/.test(tab.url || ''));
      if (!onClaude) {
        btn.textContent = '⚠ ' + I18N.t('btn.recheck.noTab');
        setTimeout(() => { btn.disabled = false; btn.textContent = '↻ ' + I18N.t('btn.recheck'); }, 2000);
        return;
      }

      // Wait for the ACTUAL background result instead of a fixed timer, then
      // give honest feedback based on what came back. source==='fresh' means
      // we really read quota numbers; 'unavailable' means we couldn't (e.g.
      // Free accounts have no 5h/weekly quota panel to read).
      chrome.runtime.sendMessage({ type: 'REFRESH_QUOTA', platformId: 'claude' }, async (resp) => {
        void chrome.runtime.lastError;
        const snap = resp?.snapshot;
        const gotQuota = snap && snap.source === 'fresh' &&
          ((snap.fiveHourPercent || 0) > 0 || (snap.weeklyPercent || 0) > 0);

        // Refresh the rest of the popup from storage so any newly-read numbers
        // and the real fetch time render.
        await loadAll();
        // Use the snapshot's real fetch time for the header "updated" label.
        if (snap?.fetchedAtMs) state.lastUpdate = snap.fetchedAtMs;
        render();

        btn.textContent = gotQuota
          ? I18N.t('btn.recheck.done')
          : '⚠ ' + I18N.t('btn.recheck.unavailable');

        setTimeout(() => { btn.disabled = false; btn.textContent = '↻ ' + I18N.t('btn.recheck'); }, 2000);
      });
    });
    document.getElementById('btn-new')?.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !/claude\.ai/.test(tab.url || '')) return;
      chrome.tabs.sendMessage(tab.id, { type: 'TM_NEW_CHAT' }, () => {
        void chrome.runtime.lastError;
      });
      window.close();
    });
    document.getElementById('btn-summary')?.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && /claude\.ai/.test(tab.url || '')) {
        chrome.tabs.sendMessage(tab.id, { type: 'TM_SUMMARIZE', zone: state.summaryZone }, () => {
          void chrome.runtime.lastError;
        });
      }
      window.close();
    });

    // Threshold inputs
    document.querySelectorAll('input[data-setting]').forEach((inp) => {
      inp.addEventListener('change', async (e) => {
        const k = e.target.dataset.setting;
        const v = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
        const settings = { ...state.settings, [k]: v };
        await chrome.storage.sync.set({ recallSettings: settings });
        state.settings = settings;
      });
    });

    // Sound preview button
    document.getElementById('btn-preview-sound')?.addEventListener('click', () => {
      const type = document.getElementById('sel-sound')?.value || 'soft';
      if (type === 'off') return;
      // Preview needs to run in content script where AudioContext works
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'TM_PREVIEW_SOUND', soundType: type, volume: state.settings.volume || 0.5 }, () => void chrome.runtime.lastError);
        }
      });
    });

    document.getElementById('sel-sound')?.addEventListener('change', async (e) => {
      const settings = { ...state.settings, soundType: e.target.value };
      await chrome.storage.sync.set({ recallSettings: settings });
      state.settings = settings;
    });
    document.getElementById('sel-lang')?.addEventListener('change', async (e) => {
      const settings = { ...state.settings, language: e.target.value };
      await chrome.storage.sync.set({ recallSettings: settings });
      state.settings = settings;
      I18N.setLang(e.target.value);
      render();
    });
    document.getElementById('toggle-notify')?.addEventListener('click', async () => {
      const settings = { ...state.settings, notifyOnRefill: !(state.settings.notifyOnRefill !== false) };
      await chrome.storage.sync.set({ recallSettings: settings });
      state.settings = settings;
      render();
    });

    // ── Theme switcher ─────────────────────────────────────────────────────
    document.getElementById('theme-switcher')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-theme]');
      if (!btn) return;
      const theme = btn.dataset.theme;
      const settings = { ...state.settings, theme };
      await chrome.storage.sync.set({ recallSettings: settings });
      state.settings = settings;
      applyTheme(theme);
      render();
    });

    // ── Export current chat as Markdown ────────────────────────────────────
    document.getElementById('btn-export-md')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-export-md');
      if (!btn || btn.disabled) return;

      // NOTE: We deliberately do NOT pre-check state.conversation here.
      // state.conversation is populated asynchronously via TM_GET_LIVE and may
      // still be null right after the popup opens (e.g. just after reinstall,
      // opening an existing chat). The content script re-scans the live DOM on
      // TM_EXPORT_MD and is the single source of truth for whether the chat is
      // empty — it returns { ok:false } for a genuinely empty conversation,
      // which the response handler below already surfaces as "No messages".

      btn.disabled = true;
      btn.textContent = '⏳ Exporting...';

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        btn.disabled = false;
        btn.innerHTML = '💾 ' + esc(I18N.t('btn.exportChat'));
        return;
      }

      chrome.tabs.sendMessage(tab.id, { type: 'TM_EXPORT_MD' }, async (resp) => {
        void chrome.runtime.lastError;
        if (resp?.ok && resp?.mdText) {
          // Use Blob URL — avoids data URL size limits for large conversations.
          // saveAs: true shows a save dialog so the user knows where the file went.
          const blob    = new Blob([resp.mdText], { type: 'text/markdown' });
          const blobUrl = URL.createObjectURL(blob);
          const filename = 'chat-export-' + new Date().toISOString().slice(0,10) + '.md';
          try {
            await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
            btn.textContent = '✓ Exported!';
          } catch (e) {
            console.error('[tm] md download failed', e);
            btn.textContent = '⚠ Failed';
          } finally {
            setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
          }
        } else {
          btn.textContent = resp?.ok === false ? '⚠ No messages' : '⚠ Failed';
        }
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = '💾 ' + esc(I18N.t('btn.exportChat'));
        }, 2000);
      });
    });

    // ── Rate limit ⓘ click → expand/collapse detail ──────────────────────
    document.querySelectorAll('.tm-layer-info-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rowId  = btn.dataset.row;
        const detail = document.getElementById(rowId + '-detail');
        if (!detail) return;
        const isHidden = detail.hidden;
        // Close all others first
        document.querySelectorAll('.tm-layer-detail').forEach(d => {
          d.hidden = true;
          d.previousElementSibling?.querySelector('.tm-layer-info-btn')?.classList.remove('active');
        });
        detail.hidden = !isHidden;
        btn.classList.toggle('active', !isHidden);
      });
    });

    document.getElementById('btn-bug-report')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-bug-report');
      if (btn.disabled) return;
      btn.disabled = true;

      // Step 1 — collecting
      btn.textContent = '⏳ ' + I18N.t('btn.bugReport.collecting');

      try {
        // ── Gather all diagnostic data ────────────────────────────────────
        const ver = chrome.runtime.getManifest().version;
        const [stored, tabs] = await Promise.all([
          new Promise(res => chrome.storage.local.get(
            ['quota:claude', 'plan:claude', 'calibration:claude'], res)),
          new Promise(res => chrome.tabs.query({ active: true, currentWindow: true }, res)),
        ]);
        const { recallSettings: cfg } = await new Promise(res =>
          chrome.storage.sync.get('recallSettings', res));

        // Try to get live content-script data
        let live = null;
        const tab = tabs[0];
        if (tab && /claude\.ai/.test(tab.url || '')) {
          live = await new Promise(res => {
            chrome.tabs.sendMessage(tab.id, { type: 'TM_GET_LIVE' }, (r) => {
              void chrome.runtime.lastError;
              res(r || null);
            });
          });
        }

        const quota    = stored['quota:claude'];
        const plan     = stored['plan:claude'];
        const calib    = stored['calibration:claude'];

        // ── Format report text ────────────────────────────────────────────
        const lines = [
          '=== Recall Auto Bug Report ===',
          'Version : ' + ver,
          'Time    : ' + new Date().toISOString(),
          'UA      : ' + navigator.userAgent,
          '',
          '--- Plan & Quota ---',
          'Plan    : ' + (plan?.displayName || plan?.tier || 'unknown'),
          '5h usage: ' + (quota?.fiveHourPercent ?? '?') + '%',
          'Wk usage: ' + (quota?.weeklyPercent  ?? '?') + '%',
          'Q.source: ' + (quota?.source ?? '?'),
          '',
          '--- Content Script ---',
          'Reachable : ' + (live ? 'YES' : 'NO'),
          'Model     : ' + (live?.model?.displayName || '—'),
          'CS tokens : ' + (live?.conversation?.contextTokens ?? '—'),
          'Turns     : ' + (live?.chatMetrics?.turns ?? '—') + ' completed, ' + Math.ceil((live?.conversation?.messageCount || 0) / 2) + ' visible in DOM',
          '',
          '--- Calibration ---',
          calib ? JSON.stringify(calib) : '(none)',
          '',
          '--- Settings ---',
          cfg ? JSON.stringify(cfg) : '(none)',
          '',
          '--- Quota Diag ---',
          quota?._diag ? JSON.stringify(quota._diag, null, 2) : '(none)',
          '',
          '--- Scan Diag ---',
          live?.scanDiag ? JSON.stringify(live.scanDiag, null, 2) : '(none)',
          '=== End ===',
        ];
        const reportText = lines.join('\n');

        // Step 2 — copy to clipboard (no server needed)
        await navigator.clipboard.writeText(reportText);

        // Step 3 — show report in a modal for easy copy
        _showReportModal(reportText);

        btn.textContent = '✅ Copied to clipboard';
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = '🐛 ' + esc(I18N.t('btn.bugReport'));
        }, 3000);

      } catch (err) {
        console.error('[tm] bug report failed', err);
        btn.textContent = '❌ ' + I18N.t('btn.bugReport.failed');
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = '🐛 ' + esc(I18N.t('btn.bugReport'));
        }, 3000);
      }
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Live updates from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'QUOTA_UPDATED' && msg.platformId === 'claude') {
      state.quota = msg.snapshot;
      state.lastUpdate = msg.snapshot.fetchedAtMs || Date.now();
      render();
    }
  });

  loadAll();
})();
