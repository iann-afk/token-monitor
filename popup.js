// popup.js — renders the main dashboard.

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

  async function loadAll() {
    const [{ tokenMonitorSettings }, quotaData, planData, overlayData] = await Promise.all([
      chrome.storage.sync.get('tokenMonitorSettings'),
      chrome.storage.local.get('quota:claude'),
      chrome.storage.local.get('plan:claude'),
      chrome.storage.local.get('ui:overlayHidden'),
    ]);
    state.overlayHidden = overlayData?.['ui:overlayHidden'] === true;
    state.settings = tokenMonitorSettings || {};
    state.quota = quotaData['quota:claude'] || { fiveHourPercent: 0, weeklyPercent: 0, source: 'unavailable', fetchedAtMs: 0 };
    state.plan = planData['plan:claude'] || { tier: 'unknown', displayName: 'Unknown' };

    // Apply language preference
    if (state.settings.language && state.settings.language !== 'auto') {
      I18N.setLang(state.settings.language);
    }

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
    root.innerHTML = `
      <div class="section">
        <div class="header">
          <div class="header-icon">T</div>
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
        ${_btnNewHtml}${_btnRefreshHtml}${_btnOverlayHtml}
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
          <select class="kv-select" id="sel-sound">
            <option value="off"${state.settings.soundType === 'off' ? ' selected' : ''}>${esc(I18N.t('sound.off'))}</option>
            <option value="soft"${(state.settings.soundType || 'soft') === 'soft' ? ' selected' : ''}>${esc(I18N.t('sound.soft'))}</option>
            <option value="alert"${state.settings.soundType === 'alert' ? ' selected' : ''}>${esc(I18N.t('sound.alert'))}</option>
          </select>
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
      </div>

      <div class="footer">
        ${esc(I18N.t('footer.disclaimer'))}
        <div style="margin-top: 8px;">
          <button id="btn-bug-report" style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-2);font-size:11px;cursor:pointer;font-family:inherit;">🐛 ${esc(I18N.t('btn.bugReport'))}</button>
        </div>
      </div>
    `;

    bindEvents();
  }

  function quotaCard(id, label, pct, warn, sub) {
    const cls = pct > 90 ? 'red' : pct > 70 ? 'amber' : 'green';
    const fillColor = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--amber)' : 'var(--green)';
    const isWarn = warn && pct > 70;
    return `
      <div class="card ${isWarn ? 'warn-card' : ''}">
        <div class="card-head">
          <span class="card-label">${isWarn ? '⚠ ' : ''}${esc(label)}</span>
          <span class="card-pct">${pct.toFixed(0)}%</span>
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
      chrome.runtime.sendMessage({ type: 'REFRESH_QUOTA', platformId: 'claude' }, () => {
        void chrome.runtime.lastError;
      });
      setTimeout(() => {
        loadAll().then(() => {
          btn.disabled = false;
          btn.textContent = '↻ ' + I18N.t('btn.recheck');
        });
      }, 1200);
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
        await chrome.storage.sync.set({ tokenMonitorSettings: settings });
        state.settings = settings;
      });
    });

    document.getElementById('sel-sound')?.addEventListener('change', async (e) => {
      const settings = { ...state.settings, soundType: e.target.value };
      await chrome.storage.sync.set({ tokenMonitorSettings: settings });
      state.settings = settings;
    });
    document.getElementById('sel-lang')?.addEventListener('change', async (e) => {
      const settings = { ...state.settings, language: e.target.value };
      await chrome.storage.sync.set({ tokenMonitorSettings: settings });
      state.settings = settings;
      I18N.setLang(e.target.value);
      render();
    });
    document.getElementById('toggle-notify')?.addEventListener('click', async () => {
      const settings = { ...state.settings, notifyOnRefill: !(state.settings.notifyOnRefill !== false) };
      await chrome.storage.sync.set({ tokenMonitorSettings: settings });
      state.settings = settings;
      render();
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
        const { tokenMonitorSettings: cfg } = await new Promise(res =>
          chrome.storage.sync.get('tokenMonitorSettings', res));

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
          '=== Token Monitor Auto Bug Report ===',
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
          'Turns     : ' + (live?.chatMetrics?.turns ?? '—'),
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

        // Step 2 — copy report to clipboard and open GitHub issue
        btn.textContent = '📤 ' + I18N.t('btn.bugReport.sending');

        // ── Copy diagnostics to clipboard, then open GitHub Issues ────────
        await navigator.clipboard.writeText(reportText);

        // Open GitHub Issues with pre-filled title
        const issueTitle = encodeURIComponent('[Bug] Token Monitor v' + ver + ' — ' + new Date().toISOString().slice(0, 10));
        const issueBody  = encodeURIComponent('**Paste your diagnostic report below** (already copied to clipboard):\n\n```\n\n```\n\n**Steps to reproduce:**\n\n**Expected behaviour:**\n\n**Actual behaviour:**\n');
        chrome.tabs.create({
          url: 'https://github.com/iann-afk/token-monitor/issues/new?title=' + issueTitle + '&body=' + issueBody,
        });

        // Step 3 — done
        btn.textContent = '✅ ' + I18N.t('btn.bugReport.sent');
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
