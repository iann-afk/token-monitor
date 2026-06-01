// dispatcher.js — orchestrates platform module + cross-cutting logic.
// Single instance lives in the content script context.

const Dispatcher = (function () {

  const state = {
    platform: null,
    quota: { fiveHourPercent: 0, weeklyPercent: 0, fiveHourReleaseAtMs: null, weeklyResetAtMs: null, fetchedAtMs: 0, source: 'unavailable' },
    plan: { tier: 'unknown', displayName: 'Unknown', fiveHourBudget: null, weeklyBudget: null },
    model: null,
    conversation: null,
    chatMetrics: {},
    inflightStream: null,
    calibration: {
      estimatedFiveHourBudget: null,
      observations: [],
      lastBannerSeenAtMs: null,
    },
    lastBannerSignals: [],
    settings: {},
    subscribers: new Set(),
  };

  // ── Init ──────────────────────────────────────────────────────────────────

  async function init(registry) {
    const host = location.hostname;
    state.platform = registry.find((p) => p && typeof p.matches === 'function' && p.matches(host));
    if (!state.platform) return false;

    try { await RemoteConfig.load(); } catch (_) {}

    console.log('[tm] Recall initializing on', host);

    try { await state.platform.attach({ onChange: _onPlatformChange }); }
    catch (e) { console.warn('[tm] platform.attach failed', e); }

    try { await _loadPersisted(); } catch (e) { console.warn('[tm] _loadPersisted failed', e); }

    // Load user settings so thresholds are available to overlay and sound
    try {
      const { recallSettings } = await chrome.storage.sync.get('recallSettings');
      if (recallSettings) state.settings = recallSettings;
    } catch (_) {}
    // Keep settings fresh if popup changes them
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.recallSettings) {
          state.settings = changes.recallSettings.newValue || {};
          _emit();
        }
      });
    } catch (_) {}

    try { state.plan = await state.platform.getPlan(); }
    catch (e) {
      console.warn('[tm] getPlan failed', e);
      state.plan = { tier: 'unknown', displayName: 'Unknown', fiveHourBudget: null, weeklyBudget: null };
    }

    try { state.model = state.platform.getActiveModel(); }
    catch (e) {
      console.warn('[tm] getActiveModel failed', e);
      state.model = { id: 'unknown', displayName: 'Unknown', contextWindow: 200000, maxOutputTokens: 32000, burnRateMultiplier: 1, extendedThinking: false };
    }

    try { state.conversation = state.platform.scanConversation(); }
    catch (e) {
      console.warn('[tm] scanConversation failed', e);
      state.conversation = { conversationId: null, messages: [], contextTokens: 0, attachmentTokens: 0, toolsOverhead: 0, projectKnowledgeTokens: 0, inProject: false };
    }

    // Listen for background broadcasts (quota updates from other tabs)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'QUOTA_UPDATED' && state.platform && msg.platformId === state.platform.id) {
        state.quota = msg.snapshot;
        // Also update plan if the broadcast includes it (quota fetch runs after getPlan on init)
        if (msg.snapshot && msg.snapshot._plan && msg.snapshot._plan.tier !== 'unknown') {
          state.plan = msg.snapshot._plan;
        }
        _emit();
      }
    });

    // First quota fetch — never throw
    try { state.quota = await state.platform.fetchQuota(); }
    catch (e) {
      console.warn('[tm] fetchQuota failed', e);
      state.quota = { fiveHourPercent: 0, weeklyPercent: 0, fiveHourReleaseAtMs: null, weeklyResetAtMs: null, fetchedAtMs: Date.now(), source: 'unavailable' };
    }

    // BUG 1 FIX: immediately apply plan from quota snapshot so first render
    // uses the correct tier, not a stale cached value from a previous session.
    if (state.quota?._plan?.tier && state.quota._plan.tier !== 'unknown') {
      state.plan = state.quota._plan;
    }

    console.log('[tm] init complete', { plan: state.plan?.displayName, model: state.model?.displayName, quota: state.quota?.source });

    _emit();
    return true;
  }

  // Bug 5 fix: async so we can await _loadChatMetrics before _emit().
  // Without await, _emit() fires before storage resolves and the popup/overlay
  // shows the previous conversation's metrics when the user switches chats.
  async function _onPlatformChange() {
    // Re-scan conversation
    const prevConvId = state.conversation && state.conversation.conversationId;
    state.conversation = state.platform.scanConversation();
    state.model = state.platform.getActiveModel();

    if (state.conversation && state.conversation.conversationId !== prevConvId) {
      await _loadChatMetrics(state.conversation.conversationId);
    }

    // Banner detection — feed signals into calibration loop
    const signals = state.platform.detectQuotaSignals();
    if (signals.length) {
      onQuotaSignals(signals);
      // BUG 2 FIX: if we hit a hard limit, don't wait 2 min for the alarm —
      // trigger an immediate background refresh so quota bar snaps to 100%.
      if (signals.some((s) => s.type === 'hard-limit-5h' || s.type === 'hard-limit-week')) {
        try { chrome.runtime.sendMessage({ type: 'REFRESH_QUOTA', platformId: state.platform.id }); } catch (_) {}
      }
    }

    // Budget inference from quota delta — no banner needed
    // If we have accumulated turns AND quota changed since last check, compute budget estimate
    _inferBudgetFromQuotaDelta();

    // Stream session tracking
    const inflightInput = state.platform.getInflightInputTokens();
    if (inflightInput !== null) {
      state.inflightStream = {
        inputCommitted: inflightInput,
        outputSoFar: state.platform.getInflightOutputTokens() || 0,
        startedAtMs: state.platform._state.streamSession?.startedAtMs || Date.now(),
      };
    } else if (state.inflightStream) {
      // Stream just ended — record the turn
      _recordTurn(state.inflightStream);
      state.inflightStream = null;
    }

    _emit();
  }

  // ── Calibration (3 layers) ────────────────────────────────────────────────

  // Track quota snapshots for delta-based budget inference
  let _quotaInferState = { lastFhPct: null, lastTotalTokens: 0, lastCheckedAtMs: 0 };

  function _inferBudgetFromQuotaDelta() {
    if (!state.quota || state.quota.source === 'unavailable') return;
    const fhPct = state.quota.fiveHourPercent;
    if (!fhPct || fhPct <= 0) return;

    const totalTok = (state.chatMetrics.inputTokens || 0) + (state.chatMetrics.outputTokens || 0);
    const now = Date.now();

    // Only run if enough time has passed and we have token data
    if (now - _quotaInferState.lastCheckedAtMs < 30000) return; // max once per 30s
    _quotaInferState.lastCheckedAtMs = now;

    const prevPct = _quotaInferState.lastFhPct;
    const prevTok = _quotaInferState.lastTotalTokens;

    if (prevPct !== null && fhPct > prevPct && fhPct > 0 && totalTok > prevTok && prevPct > 0) {
      // prevPct > 0 guards against measuring from a fresh/reset window
      const deltaPct = fhPct - prevPct;
      const deltaTok = totalTok - prevTok;
      if (deltaPct >= 0.2 && deltaTok >= 200) { // need meaningful delta (lowered for early calibration)
        const budgetEst = deltaTok / (deltaPct / 100);
        if (budgetEst > 50000 && budgetEst < 10000000) {
          state.calibration.observations.push({
            ts: now,
            obsTokens: deltaTok,
            reportedPct: deltaPct,
            budgetEst,
            source: 'quota-delta',
          });
          if (state.calibration.observations.length > 20) state.calibration.observations.shift();
          const sorted = state.calibration.observations.map((o) => o.budgetEst).sort((a, b) => a - b);
          state.calibration.estimatedFiveHourBudget = sorted[Math.floor(sorted.length / 2)];
          _persistCalibration();
        }
      }
    }

    _quotaInferState.lastFhPct = fhPct;
    _quotaInferState.lastTotalTokens = totalTok;
  }

  function onQuotaSignals(signals) {
    state.lastBannerSignals = signals;
    state.calibration.lastBannerSeenAtMs = Date.now();

    for (const sig of signals) {
      // LAYER 1 — Immediate override
      if (sig.type === 'hard-limit-5h') {
        state.quota = { ...state.quota, fiveHourPercent: 100, fiveHourReleaseAtMs: sig.releaseAtMs || state.quota.fiveHourReleaseAtMs, source: 'fresh' };
      } else if (sig.type === 'hard-limit-week') {
        state.quota = { ...state.quota, weeklyPercent: 100, weeklyResetAtMs: sig.releaseAtMs || state.quota.weeklyResetAtMs, source: 'fresh' };
      } else if (sig.type === 'soft-warn-5h' && typeof sig.messagesRemaining === 'number') {
        // "5 messages left" implies high usage — assume ~88% if remaining is small
        const inferred = Math.max(80, 100 - (sig.messagesRemaining * 2.5));
        state.quota = { ...state.quota, fiveHourPercent: Math.max(state.quota.fiveHourPercent, inferred) };
      }

      // LAYER 2 — Ratio calibration
      if (state.conversation && (sig.type === 'soft-warn-5h' || sig.type === 'hard-limit-5h')) {
        const reportedPct = sig.type === 'hard-limit-5h' ? 100 :
          (typeof sig.messagesRemaining === 'number' ? Math.max(80, 100 - sig.messagesRemaining * 2.5) : null);

        if (reportedPct && reportedPct > 0) {
          // We need a running tally of tokens consumed in this 5h window,
          // not just current chat. For v1 we approximate using the chat that's open.
          const obsTokens = state.conversation.contextTokens;
          const budgetEst = obsTokens / (reportedPct / 100);
          if (budgetEst > 50000 && budgetEst < 10000000) { // sanity bounds
            state.calibration.observations.push({
              atMs: Date.now(),
              ourEstimateTokens: obsTokens,
              reportedPercent: reportedPct,
              bannerType: sig.type,
              budgetEst,
            });
            // Keep last 20 observations
            if (state.calibration.observations.length > 20) {
              state.calibration.observations.shift();
            }
            // Take median of observations
            const sorted = state.calibration.observations.map((o) => o.budgetEst).sort((a, b) => a - b);
            state.calibration.estimatedFiveHourBudget = sorted[Math.floor(sorted.length / 2)];
            _persistCalibration();
          }
        }
      }
    }
  }

  function getCalibrationState() {
    const n = state.calibration.observations.length;
    let confidence = 'none';
    if (n >= 5) confidence = 'high';
    else if (n >= 3) confidence = 'medium';
    else if (n >= 1) confidence = 'low';
    return {
      estimatedFiveHourBudget: state.calibration.estimatedFiveHourBudget,
      confidence,
      observations: state.calibration.observations.slice(),
      lastBannerSeenAtMs: state.calibration.lastBannerSeenAtMs,
    };
  }

  // ── Chat metrics (Q3 — input/output split) ────────────────────────────────

  async function _loadChatMetrics(convId) {
    if (!convId) return;
    const key = `chat:${state.platform.id}:${convId}`;
    try {
      const data = await chrome.storage.local.get(key);
      state.chatMetrics = data[key] || { turns: 0, inputTokens: 0, outputTokens: 0, firstTurnTokens: 0, recentTurnTokens: [] };
    } catch (_) {
      state.chatMetrics = { turns: 0, inputTokens: 0, outputTokens: 0, firstTurnTokens: 0, recentTurnTokens: [] };
    }
  }

  async function _saveChatMetrics() {
    if (!state.conversation || !state.conversation.conversationId) return;
    const key = `chat:${state.platform.id}:${state.conversation.conversationId}`;
    try {
      await chrome.storage.local.set({ [key]: state.chatMetrics });
    } catch (_) {}
  }

  // Aggregate metrics across ALL stored chats for this platform
  async function getAllChatsMetrics() {
    try {
      const prefix = `chat:${state.platform?.id || 'claude'}:`;
      const allKeys = await chrome.storage.local.get(null);
      let totalTurns = 0, totalInput = 0, totalOutput = 0, chatCount = 0;
      for (const [k, v] of Object.entries(allKeys)) {
        if (!k.startsWith(prefix)) continue;
        chatCount++;
        totalTurns += v.turns || 0;
        totalInput += v.inputTokens || 0;
        totalOutput += v.outputTokens || 0;
      }
      return { chatCount, totalTurns, totalInput, totalOutput,
               totalTokens: totalInput + totalOutput };
    } catch (_) {
      return { chatCount: 0, totalTurns: 0, totalInput: 0, totalOutput: 0, totalTokens: 0 };
    }
  }

  function _recordTurn(stream) {
    const inputTok = stream.inputCommitted;
    const outputTok = stream.outputSoFar || (state.platform.getInflightOutputTokens?.() || 0);
    const turnTotal = inputTok + outputTok;

    state.chatMetrics.turns = (state.chatMetrics.turns || 0) + 1;
    state.chatMetrics.inputTokens = (state.chatMetrics.inputTokens || 0) + inputTok;
    state.chatMetrics.outputTokens = (state.chatMetrics.outputTokens || 0) + outputTok;
    if (!state.chatMetrics.firstTurnTokens) state.chatMetrics.firstTurnTokens = turnTotal;
    state.chatMetrics.recentTurnTokens = (state.chatMetrics.recentTurnTokens || []).concat(turnTotal).slice(-5);

    _saveChatMetrics();

    // Trigger an authoritative quota refresh in 8s — let server settle
    setTimeout(() => {
      try { chrome.runtime.sendMessage({ type: 'REFRESH_QUOTA', platformId: state.platform.id }); } catch (_) {}
    }, 8000);
  }

  function getChatMetrics() {
    const total = (state.chatMetrics.inputTokens || 0) + (state.chatMetrics.outputTokens || 0);
    const budget = state.calibration.estimatedFiveHourBudget;
    const chatPercentOfQuota = budget && total ? Math.min(100, (total / budget) * 100) : null;

    return {
      conversationId: state.conversation?.conversationId || null,
      turns: state.chatMetrics.turns || 0,
      inputTokens: state.chatMetrics.inputTokens || 0,
      outputTokens: state.chatMetrics.outputTokens || 0,
      totalTokens: total,
      firstTurnTokens: state.chatMetrics.firstTurnTokens || 0,
      recentTurnTokens: state.chatMetrics.recentTurnTokens || [],
      chatPercentOfQuota,
    };
  }

  // ── Output prediction (Q2) ────────────────────────────────────────────────

  function predictOutputSize(draft, model) {
    if (!draft || !draft.trim()) {
      return { bucket: 'S', predictedTokens: 200, signals: [] };
    }
    const lc = draft.toLowerCase();
    const signals = [];
    let score = 0;

    // Length-based base
    const len = draft.length;
    if (len < 80) score += 0;
    else if (len < 300) score += 1;
    else score += 2;
    if (len > 80) signals.push('long prompt');

    // Trigger words (English + Chinese)
    const longWords = /(comprehensive|detailed|thorough|step.?by.?step|write a |build a |create a |implement |full |complete |完整|详细|逐步|写一个|做一个|实现|生成|完整地)/i;
    if (longWords.test(lc) || longWords.test(draft)) { score += 2; signals.push('long-output keywords'); }

    // File creation
    if (/(report|article|essay|document|文档|报告|文章|论文|markdown|html|component|class|function)/i.test(draft)) {
      score += 1;
      signals.push('artifact-style request');
    }

    // Multi-question
    const qmarks = (draft.match(/[?？]/g) || []).length;
    const lists = (draft.match(/^\s*[\d\-\*]\.?\s/gm) || []).length;
    if (qmarks >= 3 || lists >= 3) { score += 2; signals.push('multi-part'); }

    // Code blocks suggest coding output
    if (/```/.test(draft)) { score += 1; signals.push('code in prompt'); }

    // ET active doubles output
    if (model && model.extendedThinking) { score += 1; signals.push('extended thinking'); }

    let bucket = 'S';
    let mid = 400;
    if (score >= 5) { bucket = 'XL'; mid = 12000; }
    else if (score >= 3) { bucket = 'L'; mid = 4000; }
    else if (score >= 1) { bucket = 'M'; mid = 1200; }

    return { bucket, predictedTokens: mid, signals };
  }

  // ── Truncation risk (Q4) ──────────────────────────────────────────────────

  function assessTruncationRisk(draft) {
    const model = state.model || { contextWindow: 200000, maxOutputTokens: 32000 };
    const ctxTokens = state.conversation?.contextTokens || 0;
    const inputEst = (typeof Tokenizer !== 'undefined') ? Tokenizer.estimate(draft || '') : Math.ceil((draft || '').length / 4);
    const outputPred = predictOutputSize(draft || '', model);

    const remaining = model.contextWindow - ctxTokens;
    const needed = inputEst + outputPred.predictedTokens;

    // Two distinct ways a reply can come up short, surfaced separately so the
    // message can explain WHY (per product direction):
    //   (a) context-full   — the conversation + this prompt + its answer won't
    //       fit in the model's context window. More likely in long chats.
    //   (b) reply-cap      — even with room, a single reply can only get so
    //       long; a predicted XL answer may hit that ceiling. NOTE: the exact
    //       per-reply cap on claude.ai isn't publicly documented, so
    //       maxOutputTokens is a conservative estimate and this is a heuristic,
    //       not a guarantee.
    const contextFull = needed > remaining * 0.85;
    const replyCap = outputPred.predictedTokens >= model.maxOutputTokens * 0.9;
    const willTruncate = contextFull || replyCap;

    // Reason drives the user-facing copy. Context pressure takes priority
    // because it's the more reliable signal (DOM-derived context vs. estimated
    // output size).
    let reason = null;
    const longChat = ctxTokens > model.contextWindow * 0.5;
    if (contextFull) reason = longChat ? 'long-chat-and-big-ask' : 'big-ask';
    else if (replyCap) reason = 'big-ask';

    let questionsExtracted = null;
    if (willTruncate) {
      questionsExtracted = extractQuestions(draft);
    }

    return {
      willLikelyTruncate: willTruncate,
      reason,
      longChat,
      multiPart: !!(questionsExtracted && questionsExtracted.length > 1),
      remainingContext: remaining,
      estimatedNeeded: needed,
      questionsExtracted,
    };
  }

  function extractQuestions(draft) {
    if (!draft) return null;
    // Numbered lists
    const numberedSplit = draft.split(/\n\s*\d+[\.\)]\s+/).filter((s) => s.trim().length > 5);
    if (numberedSplit.length >= 2) return numberedSplit.map((s) => s.trim());

    // Bullet lists
    const bulletSplit = draft.split(/\n\s*[\-\*]\s+/).filter((s) => s.trim().length > 5);
    if (bulletSplit.length >= 2) return bulletSplit.map((s) => s.trim());

    // Multiple ? marks — split on sentence boundaries
    const qmarks = (draft.match(/[?？]/g) || []).length;
    if (qmarks >= 2) {
      const parts = draft.split(/(?<=[?？])\s+/).filter((s) => s.trim().length > 3);
      if (parts.length >= 2) return parts;
    }
    return null;
  }

  // ── Summary flow (Q5) ─────────────────────────────────────────────────────

  function getSummaryZone() {
    const ctxPct = state.conversation
      ? (state.conversation.contextTokens / (state.model?.contextWindow || 200000)) * 100
      : 0;
    const fhPct = state.quota.fiveHourPercent || 0;

    if (ctxPct > 95 || fhPct > 90) return 'red';
    if (ctxPct > 75 || fhPct > 70) return 'amber';
    if (ctxPct > 60 || fhPct > 50) return 'green';
    return 'none';
  }

  function estimateSummaryCost() {
    const inputTokens = state.conversation?.contextTokens || 0;
    const outputTokens = 1500;
    // 5h cost as fraction
    const budget = state.calibration.estimatedFiveHourBudget || 220000;
    const fiveHourCost = ((inputTokens + outputTokens) / budget) * 100;
    return { inputTokens, outputTokens, fiveHourCost };
  }

  async function runSummaryFlow() {
    const prompt = _getSummaryPrompt();
    const ok = state.platform.writeComposerDraft(prompt);
    if (!ok) return { error: 'cannot-write-composer' };
    return { ok: true, prompt };
    // Note: we don't auto-submit. User reviews + presses send.
    // After stream completes, UI shows "Open new chat with this summary".
  }

  function _getSummaryPrompt() {
    const lang = (typeof navigator !== 'undefined' && /^zh/i.test(navigator.language)) ? 'zh' : 'en';
    if (lang === 'zh') {
      return '请将本次对话总结为一份简洁的 markdown 笔记，便于我粘贴到新对话作为上下文。包含：关键决定、引用的代码或数据、下一步计划。控制在 500 字以内。';
    }
    return 'Summarize this conversation as a concise markdown note I can paste into a new chat as context. Include: key decisions, code or data referenced, what\'s next. Keep it under 500 words.';
  }

  function exportUserMessagesAsMarkdown() {
    const conv = state.conversation;
    if (!conv) return null;
    const lines = [`# Chat export — ${new Date().toLocaleString()}`, ''];
    for (const m of conv.messages) {
      lines.push(m.role === 'user' ? '## You' : '## Claude');
      lines.push('');
      lines.push(m.text);
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    return URL.createObjectURL(blob);
  }

  // ── Stream awareness (Q1) ─────────────────────────────────────────────────

  function getInflightStream() {
    if (!state.inflightStream) return null;
    // Re-read output tokens live each time so the stream-status-bar's 800ms
    // poll can show monotonic growth without waiting for MutationObserver.
    try {
      const live = state.platform?.getInflightOutputTokens?.();
      if (typeof live === 'number') {
        state.inflightStream.outputSoFar = live;
      }
    } catch (_) {}
    return state.inflightStream;
  }

  // ── Public quota / plan / model getters ───────────────────────────────────

  function getSettings() { return state.settings; }
  function getQuota() { return state.quota; }
  function getPlan() { return state.plan; }
  function getActiveModel() { return state.model; }
  function getConversation() { return state.conversation; }
  function refreshQuota() {
    try { chrome.runtime.sendMessage({ type: 'REFRESH_QUOTA', platformId: state.platform.id }); } catch (_) {}
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  function subscribe(handler) {
    state.subscribers.add(handler);
    return () => state.subscribers.delete(handler);
  }

  function _emit() {
    state.subscribers.forEach((h) => { try { h(); } catch (e) { console.error(e); } });
  }

  // ── Persistence helpers ───────────────────────────────────────────────────

  async function _loadPersisted() {
    if (!state.platform) return;
    const calKey = `calibration:${state.platform.id}`;
    try {
      const data = await chrome.storage.local.get(calKey);
      if (data[calKey]) state.calibration = { ...state.calibration, ...data[calKey] };
    } catch (_) {}
  }

  async function _persistCalibration() {
    if (!state.platform) return;
    const calKey = `calibration:${state.platform.id}`;
    try {
      await chrome.storage.local.set({
        [calKey]: {
          estimatedFiveHourBudget: state.calibration.estimatedFiveHourBudget,
          observations: state.calibration.observations,
          lastBannerSeenAtMs: state.calibration.lastBannerSeenAtMs,
        }
      });
    } catch (_) {}
  }

  return {
    init,
    getSettings,
    getQuota, refreshQuota,
    getPlan, getActiveModel, getConversation, getAllChatsMetrics,
    onQuotaSignals, getCalibrationState,
    getChatMetrics,
    predictOutputSize, assessTruncationRisk, extractQuestions,
    getSummaryZone, estimateSummaryCost, runSummaryFlow, exportUserMessagesAsMarkdown,
    getInflightStream,
    subscribe,
    _state: state,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Dispatcher;
