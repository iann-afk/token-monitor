// content.js — entry point in each AI tab.

(async function () {
  if (window.__tm_initialized__) return;
  window.__tm_initialized__ = true;

  // Only run in the top frame on Claude.ai. all_frames: true injects into
  // every iframe (analytics, embeds, login) which would just cause noise.
  if (window.top !== window) {
    return;
  }
  if (!/^claude\.ai$|\.claude\.ai$/.test(location.hostname)) {
    return;
  }

  let initOk = false;
  try {
    const REGISTRY = [ClaudePlatform];
    initOk = await Dispatcher.init(REGISTRY);
  } catch (e) {
    console.error('[tm] init threw', e);
  }
  if (!initOk) {
    console.warn('[tm] dispatcher init returned false (hostname not supported or hard failure)');
    return;
  }

  try {
    const { recallSettings } = await chrome.storage.sync.get('recallSettings');
    if (recallSettings && recallSettings.language) {
      I18N.setLang(recallSettings.language);
    }
  } catch (_) {}

  try {
    Overlay.mount(Dispatcher);
    ComposerCompanion.mount(Dispatcher);
    TurnBadges.mount(Dispatcher);
    StreamStatusBar.mount(Dispatcher);

    // First-run welcome (shows once, only on fresh install, only on claude.ai).
    if (typeof Onboarding !== 'undefined') {
      setTimeout(() => { try { Onboarding.maybeShow(); } catch (_) {} }, 1200);
    }

    // Sound alert state — initialised after first quota data arrives
    let _soundPrev = null;  // { ctx, fh, wk } — null = not yet seeded
    let _soundCfg  = {};    // mirrors recallSettings

    function _loadSoundCfg() {
      chrome.storage.sync.get('recallSettings', (r) => {
        _soundCfg = r?.recallSettings || {};
      });
    }
    _loadSoundCfg();
    // Re-read settings whenever the popup writes them
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.recallSettings) {
        _soundCfg = changes.recallSettings.newValue || {};
        // Force overlay re-render when theme changes (hash guard would otherwise skip it)
        const oldTheme = changes.recallSettings.oldValue?.theme;
        const newTheme = changes.recallSettings.newValue?.theme;
        if (oldTheme !== newTheme) {
          try { Overlay._forceRender(); } catch (_) {
            try { Overlay.render(); } catch (_) {}
          }
        }
      }
    });

    Dispatcher.subscribe(() => {
      try { Overlay.render(); } catch (e) { console.warn('[tm] overlay render', e); }
      try { ComposerCompanion.render(); } catch (e) { console.warn('[tm] composer render', e); }
      try { TurnBadges.render(); } catch (e) { console.warn('[tm] turn-badges render', e); }
      try { StreamStatusBar.render(); } catch (e) { console.warn('[tm] stream render', e); }

      // ── Sound threshold alerts ──────────────────────────────────────────────
      try {
        const cfg = _soundCfg;
        const q   = Dispatcher.getQuota();
        const conv = Dispatcher.getConversation();
        const mdl  = Dispatcher.getActiveModel();

        const ctxPct = (conv && mdl && mdl.contextWindow)
          ? Math.min(100, (conv.contextTokens / mdl.contextWindow) * 100) : 0;
        const fhPct  = q?.fiveHourPercent  || 0;
        const wkPct  = q?.weeklyPercent    || 0;

        // Seed on first call — avoids false alerts on page load.
        // Always update _soundPrev, even when sound is off, so crossing
        // a threshold while muted doesn't replay when sound is re-enabled.
        if (!_soundPrev) {
          _soundPrev = { ctx: ctxPct, fh: fhPct, wk: wkPct };
        } else {
          // FIX: check alarmEnabled AND soundType before playing.
          // FIX: always update _soundPrev (was missing when soundType==='off').
          const soundActive = cfg.alarmEnabled !== false && cfg.soundType !== 'off';
          if (soundActive) {
            const thresholds = [
              { curr: ctxPct, prev: _soundPrev.ctx, warn: cfg.contextWarn  ?? 70, crit: cfg.contextCritical  ?? 90 },
              { curr: fhPct,  prev: _soundPrev.fh,  warn: cfg.fiveHourWarn ?? 75, crit: cfg.fiveHourCritical ?? 90 },
              { curr: wkPct,  prev: _soundPrev.wk,  warn: cfg.weeklyWarn   ?? 80, crit: cfg.weeklyCritical   ?? 95 },
            ];
            for (const t of thresholds) {
              const hitCrit = t.prev < t.crit && t.curr >= t.crit;
              const hitWarn = t.prev < t.warn && t.curr >= t.warn;
              if (hitCrit || hitWarn) {
                SoundPlayer.play(hitCrit ? 'alert' : 'soft', cfg.volume ?? 0.5);
                break; // one sound per event
              }
            }
          }
          _soundPrev = { ctx: ctxPct, fh: fhPct, wk: wkPct };
        }
      } catch (_) {}
    });

    Overlay.render();
    ComposerCompanion.render();
    TurnBadges.render();
    StreamStatusBar.render();
    console.log('[tm] UI mounted');
  } catch (e) {
    console.error('[tm] UI mount failed', e);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only return true for message types we actually handle, otherwise the
    // channel stays open forever waiting for a sendResponse that never comes.
    const HANDLED = new Set(['TM_GET_LIVE', 'TM_NEW_CHAT', 'TM_SUMMARIZE', 'TM_SHOW_OVERLAY', 'TM_HIDE_OVERLAY', 'TM_EXPORT_MD', 'TM_PREVIEW_SOUND']);
    if (!msg || !HANDLED.has(msg.type)) return false;

    try {
      if (msg.type === 'TM_SHOW_OVERLAY') {
        if (typeof Overlay !== 'undefined') Overlay.show();
        sendResponse({ ok: true });
        return true;
      }

      if (msg.type === 'TM_HIDE_OVERLAY') {
        if (typeof Overlay !== 'undefined') Overlay.hide();
        sendResponse({ ok: true });
        return true;
      }

      if (msg.type === 'TM_GET_LIVE') {
        // Force a fresh scan — popup open may have happened after MutationObserver
        // fell quiet. This guarantees the popup shows current DOM state.
        try {
          if (Dispatcher._state?.platform?.scanConversation) {
            Dispatcher._state.conversation = Dispatcher._state.platform.scanConversation();
          }
          if (Dispatcher._state?.platform?.getActiveModel) {
            Dispatcher._state.model = Dispatcher._state.platform.getActiveModel();
          }
        } catch (e) {
          console.warn('[tm] forced rescan failed', e);
        }

        const conv = Dispatcher.getConversation();
        const platform = Dispatcher._state?.platform;
        const lastScan = platform?._state?.lastScan || null;
        // getAllChatsMetrics is async — keep channel open and sendResponse after
        Dispatcher.getAllChatsMetrics().then((allChats) => {
          sendResponse({
            model: Dispatcher.getActiveModel(),
            chatMetrics: Dispatcher.getChatMetrics(),
            summaryZone: Dispatcher.getSummaryZone(),
            allChats,
            // Bug 4 fix (part 1): expose calibrated budget so popup can use it
            calibration: Dispatcher.getCalibrationState(),
            conversation: {
              contextTokens: conv?.contextTokens || 0,
              attachmentTokens: conv?.attachmentTokens || 0,
              toolsOverhead: conv?.toolsOverhead || 0,
              projectKnowledgeTokens: conv?.projectKnowledgeTokens || 0,
              messageCount: conv?.messages?.length || 0,
              inProject: conv?.inProject || false,
              conversationId: conv?.conversationId || null,
            },
            scanDiag: lastScan,
          });
        }).catch(() => sendResponse({ model: Dispatcher.getActiveModel(), chatMetrics: Dispatcher.getChatMetrics(), summaryZone: 'none' }));
        return true; // async sendResponse — keep channel open
      } else if (msg.type === 'TM_EXPORT_MD') {
        // Force a fresh scan so state.conversation is current before export
        try {
          if (Dispatcher._state?.platform?.scanConversation) {
            Dispatcher._state.conversation = Dispatcher._state.platform.scanConversation();
          }
        } catch (_) {}
        // Return MD text to popup — popup uses chrome.downloads.download()
        // which reliably saves files from extension pages (a.click() does not).
        const conv = Dispatcher.getConversation();
        let mdText = null;
        if (conv && conv.messages?.length > 0) {
          const lines = ['# Chat export — ' + new Date().toLocaleString(), ''];
          for (const m of conv.messages) {
            lines.push(m.role === 'user' ? '## You' : '## Claude');
            lines.push('');
            lines.push(m.text || '');
            lines.push('');
          }
          mdText = lines.join('\n');
        }
        sendResponse({ ok: !!mdText, mdText });
        return false;
      } else if (msg.type === 'TM_PREVIEW_SOUND') {
        // Preview sound from settings UI
        if (typeof SoundPlayer !== 'undefined' && msg.soundType !== 'off') {
          SoundPlayer.preview(msg.soundType, msg.volume || 0.5);
        }
        sendResponse({ ok: true });
        return false;
      } else if (msg.type === 'TM_NEW_CHAT') {
        Dispatcher._state.platform.startNewChat();
        sendResponse({ ok: true });
        return false;
      } else if (msg.type === 'TM_SUMMARIZE') {
        const zone = msg.zone || Dispatcher.getSummaryZone();
        if (zone === 'red') {
          const url = Dispatcher.exportUserMessagesAsMarkdown();
          if (url) {
            const a = document.createElement('a');
            a.href = url;
            a.download = `chat-export-${Date.now()}.md`;
            a.click();
          }
        } else {
          Dispatcher.runSummaryFlow();
        }
        sendResponse({ ok: true });
        return false;
      }
    } catch (e) {
      console.error('[tm] message error', e);
      try { sendResponse({ error: String(e) }); } catch (_) {}
    }
    return false;
  });
})();

// ── Service status + refill listener (v2.1.1) ──────────────────────────────
function _showRefillToast() {
  // Remove any existing toast
  document.getElementById('tm-refill-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'tm-refill-toast';
  toast.style.cssText = [
    'position:fixed;bottom:80px;left:50%;transform:translateX(-50%)',
    'background:#16a34a;color:#fff;padding:10px 20px;border-radius:10px',
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;font-weight:500',
    'box-shadow:0 4px 20px rgba(0,0,0,0.25);z-index:2147483647',
    'display:flex;align-items:center;gap:8px;animation:tm-toast-in 0.25s ease',
    'pointer-events:none;',
  ].join(';');
  toast.innerHTML = '<span>✓</span><span>Claude quota refilled — ready to go</span>';

  // Inject keyframe if not present
  if (!document.getElementById('tm-toast-style')) {
    const s = document.createElement('style');
    s.id = 'tm-toast-style';
    s.textContent = '@keyframes tm-toast-in{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
    document.head.appendChild(s);
  }

  document.body.appendChild(toast);

  // Tab title flash: prepend ✓ for the toast's lifetime (6 seconds).
  // Guard against double-prefixing if the toast fires again before the
  // previous one cleared — capture the title only when not already flashed.
  const FLASH_PREFIX = '✓ Ready — ';
  const origTitle = document.title.startsWith(FLASH_PREFIX)
    ? document.title.slice(FLASH_PREFIX.length)
    : document.title;
  document.title = FLASH_PREFIX + origTitle;

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.4s';
    setTimeout(() => toast.remove(), 400);
    // Only restore if our flash is still the current title (user/site may
    // have changed it in the meantime).
    if (document.title === FLASH_PREFIX + origTitle) document.title = origTitle;
  }, 6000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'TM_REFILL_NOTIFY') { _showRefillToast(); return false; }
  if (msg && msg.type === 'TM_STATUS_UPDATE' && msg.status) {
    try {
      sessionStorage.setItem('tm:status', JSON.stringify(msg.status));
    } catch (_) {}
  }
});
