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
    const { tokenMonitorSettings } = await chrome.storage.sync.get('tokenMonitorSettings');
    if (tokenMonitorSettings && tokenMonitorSettings.language) {
      I18N.setLang(tokenMonitorSettings.language);
    }
  } catch (_) {}

  try {
    Overlay.mount(Dispatcher);
    ComposerCompanion.mount(Dispatcher);
    TurnBadges.mount(Dispatcher);
    StreamStatusBar.mount(Dispatcher);

    // Sound alert state — initialised after first quota data arrives
    let _soundPrev = null;  // { ctx, fh, wk } — null = not yet seeded
    let _soundCfg  = {};    // mirrors tokenMonitorSettings

    function _loadSoundCfg() {
      chrome.storage.sync.get('tokenMonitorSettings', (r) => {
        _soundCfg = r?.tokenMonitorSettings || {};
      });
    }
    _loadSoundCfg();
    // Re-read settings whenever the popup writes them
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.tokenMonitorSettings) {
        _soundCfg = changes.tokenMonitorSettings.newValue || {};
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
    const HANDLED = new Set(['TM_GET_LIVE', 'TM_NEW_CHAT', 'TM_SUMMARIZE', 'TM_SHOW_OVERLAY', 'TM_HIDE_OVERLAY']);
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
