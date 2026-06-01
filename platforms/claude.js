// platforms/claude.js
// ─────────────────────────────────────────────────────────────────────────────
// Claude.ai platform module — real implementations of the five core methods.
//
//   getActiveModel()       — read model + ET state from header
//   scanConversation()     — enumerate turns, attachments, tools, project
//   detectStreamState()    — idle / streaming / submitted / limit-reached
//   detectQuotaSignals()   — banner scanner for calibration loop
//   fetchQuota()           — pull /api/.../usage via background worker
//
// SELECTOR DISCLAIMER
// ─────────────────────
// Selectors below are based on observed Claude.ai patterns (data-testid,
// aria roles, semantic markup). Anthropic obfuscates class names and DOM
// structure shifts between deploys. Every selector is wrapped in a fallback
// chain via DOM.querySelectorFirst, and parse failures log to console with
// a hash so we can quickly notice when patterns drift.
//
// Each // SELECTOR_VERIFY tag marks something to validate on a live page
// before shipping. Run /scripts/probe-selectors.js (TODO) on claude.ai
// devtools console to validate the full set.
// ─────────────────────────────────────────────────────────────────────────────

const ClaudePlatform = (function () {

  // Static model registry. Source: Anthropic public docs + our own probes.
  // Update this table when new models land.
  const MODELS = {
    'sonnet-4-7':  { id: 'claude-sonnet-4-7', displayName: 'Sonnet 4.7', contextWindow: 200000, maxOutputTokens: 32000,  burnRateMultiplier: 1.0 },
    'sonnet-4-6':  { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', contextWindow: 200000, maxOutputTokens: 32000,  burnRateMultiplier: 1.0 },
    'opus-4-7':    { id: 'claude-opus-4-7',   displayName: 'Opus 4.7',   contextWindow: 200000, maxOutputTokens: 32000,  burnRateMultiplier: 5.0 },
    'opus-4-6':    { id: 'claude-opus-4-6',   displayName: 'Opus 4.6',   contextWindow: 200000, maxOutputTokens: 32000,  burnRateMultiplier: 5.0 },
    'haiku-4-5':   { id: 'claude-haiku-4-5',  displayName: 'Haiku 4.5',  contextWindow: 200000, maxOutputTokens: 32000,  burnRateMultiplier: 0.2 },
    'unknown':     { id: 'unknown',           displayName: 'Unknown',    contextWindow: 200000, maxOutputTokens: 32000,  burnRateMultiplier: 1.0 },
  };

  // Internal state — populated by attach()
  const state = {
    streamSession: null,        // { startedAtMs, inputCommitted, lastSeenOutputTokens }
    bannerCache: new Map(),     // hash → { firstSeenMs, signalType }
    knownConvId: null,
  };

  // ── getActiveModel ─────────────────────────────────────────────────────────

  function getActiveModel() {
    const MODELS_M = RemoteConfig.models(MODELS);
    // Model picker is typically a button in the chat header carrying both
    // the display name (Sonnet 4.7) and a chevron. Possible anchors:
    //   - data-testid that mentions "model"
    //   - aria-haspopup="menu" near the top of the chat
    //   - a button whose text matches /sonnet|opus|haiku/i
    const candidates = RemoteConfig.selectors('modelSelector', [
      '[data-testid="model-selector-dropdown"] button', // 2026-05 primary
      'button[data-testid*="model"]',                   // alt
      'button[data-testid*="Model"]',
      '[data-testid="model-selector-dropdown"]',        // div fallback (Free accounts)
      'header button[aria-haspopup="menu"]',
      'main button[aria-haspopup="menu"]',
      '[aria-haspopup="listbox"][role="combobox"]',     // combobox variant
      'button[aria-haspopup="menu"]',
    ]);

    const validate = (el) => {
      const text = (el.textContent || '').toLowerCase();
      return /sonnet|opus|haiku/.test(text);
    };

    const btn = DOM.querySelectorFirst(candidates, validate);
    let key = 'unknown';

    if (btn) {
      const text = (btn.textContent || '').toLowerCase().replace(/\s+/g, '');
      // Order matters: match longest version strings first.
      const versionMatch = text.match(/(sonnet|opus|haiku)[^\d]*(\d+\.?\d*)?/);
      if (versionMatch) {
        const family = versionMatch[1];
        const version = (versionMatch[2] || '').replace('.', '-');
        const candidate = `${family}-${version}`;
        if (MODELS_M[candidate]) {
          key = candidate;
        } else {
          // No exact version match — fall back to latest known of family.
          // Sort by numeric version (major*1000 + minor) so multi-digit
          // versions order correctly (e.g. opus-4-10 > opus-4-7). A plain
          // lexicographic .sort() would rank "4-10" below "4-7".
          const verNum = (k) => {
            const mm = k.match(/-(\d+)-(\d+)$/);
            return mm ? parseInt(mm[1], 10) * 1000 + parseInt(mm[2], 10) : -1;
          };
          const latest = Object.keys(MODELS_M)
            .filter((k) => k.startsWith(family + '-'))
            .sort((a, b) => verNum(a) - verNum(b))
            .pop();
          if (latest) key = latest;
        }
      }
    } else {
      DOM.log('claude', 'model selector not found, returning unknown');
    }

    // Extended thinking toggle. Located near composer or in a settings menu.
    // Often a button with aria-pressed; sometimes a switch role.
    const etCandidates = [
      'button[aria-label*="thinking" i]',             // SELECTOR_VERIFY
      'button[aria-label*="extended" i]',
      '[role="switch"][aria-label*="thinking" i]',
      'button[data-testid*="thinking"]',
    ];
    const etEl = DOM.querySelectorFirst(etCandidates);
    const extendedThinking = etEl
      ? (etEl.getAttribute('aria-pressed') === 'true' ||
         etEl.getAttribute('aria-checked') === 'true' ||
         etEl.dataset.state === 'on')
      : false;

    return { ...MODELS_M[key], extendedThinking };
  }

  // ── scanConversation ───────────────────────────────────────────────────────

  function scanConversation() {
    const conversationId = _extractConvIdFromUrl();
    const inProject = _isInProjectContext();

    const userSelectors = RemoteConfig.selectors('userMessage', [
      '[data-testid="user-message"]',                          // primary (2026-05+)
      '[class*="font-user-message"]',                          // font-class fallback
      'div[data-test-render-count] [class*="font-user-message"]',
      '[data-testid*="user"][data-testid*="message"]',
    ]);
    const assistantSelectors = RemoteConfig.selectors('assistantMessage', [
      '[class*="font-claude-response"]',                       // primary (2026-05+)
      '[data-testid="assistant-message"]',                     // legacy testid
      '[class*="font-claude-message"]',                        // legacy class
      'div[data-test-render-count] [class*="font-claude-message"]',
      '[data-testid*="assistant"][data-testid*="message"]',
    ]);

    const userTurns = DOM.querySelectorAll(userSelectors);
    const rawAssistantTurns = DOM.querySelectorAll(assistantSelectors);

    // Anthropic wraps each markdown paragraph/block in font-claude-response,
    // so a single Claude response can match dozens of nested elements.
    // Keep only the outermost ancestors — drop any element that's contained
    // inside another matched element.
    const assistantTurns = [];
    for (const el of rawAssistantTurns) {
      let isNested = false;
      for (const other of rawAssistantTurns) {
        if (other !== el && other.contains(el)) {
          isNested = true;
          break;
        }
      }
      if (!isNested) assistantTurns.push(el);
    }

    // Diagnostic: stash per-selector counts so the diagnostic page can show them
    state.lastScan = {
      userSelectorMatches: userSelectors.map((sel) => {
        try { return { sel, count: document.querySelectorAll(sel).length }; }
        catch (_) { return { sel, count: -1 }; }
      }),
      assistantSelectorMatches: assistantSelectors.map((sel) => {
        try { return { sel, count: document.querySelectorAll(sel).length }; }
        catch (_) { return { sel, count: -1 }; }
      }),
      userTurnCount: userTurns.length,
      assistantTurnCount: assistantTurns.length,
      assistantRawCount: rawAssistantTurns.length,
      atMs: Date.now(),
    };

    /** @type {{role: string, text: string, estimatedTokens: number, turnId: string|null}[]} */
    const messages = [];

    for (const el of userTurns) {
      const text = DOM.extractText(el);
      messages.push({
        role: 'user',
        text,
        estimatedTokens: Tokenizer.estimate(text),
        turnId: _stableTurnId(el),
        _domEl: el, // for later attaching badges; stripped before serialization
      });
    }
    for (const el of assistantTurns) {
      const text = DOM.extractText(el);
      messages.push({
        role: 'assistant',
        text,
        estimatedTokens: Tokenizer.estimate(text),
        turnId: _stableTurnId(el),
        _domEl: el,
      });
    }

    // Sort by DOM order (user/assistant turns are interleaved).
    messages.sort((a, b) => {
      if (a._domEl === b._domEl) return 0;
      return a._domEl.compareDocumentPosition(b._domEl)
        & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    // Attachments: chips inside user messages or in the most recent input area.
    const attachmentTokens = _scanAttachments();

    // Active tools: detect which toggles are on near the composer.
    const toolsOverhead = Tokenizer.estimateToolsOverhead(_scanActiveTools());

    // Project knowledge: rough flat estimate when in a project, refined later
    // when /api/projects/{id} probe is implemented.
    const projectKnowledgeTokens = inProject ? 3000 : 0;

    const messageTokens = messages.reduce((s, m) => s + m.estimatedTokens, 0);
    const contextTokens = messageTokens + attachmentTokens + toolsOverhead + projectKnowledgeTokens;

    // Strip _domEl before returning — internal helper, not part of the contract.
    const serializable = messages.map(({ _domEl, ...rest }) => rest);

    return {
      conversationId,
      messages: serializable,
      contextTokens,
      attachmentTokens,
      toolsOverhead,
      projectKnowledgeTokens,
      inProject,
    };
  }

  function _extractConvIdFromUrl() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]+)/i)
           || location.pathname.match(/\/project\/[^/]+\/chat\/([0-9a-f-]+)/i);
    return m ? m[1] : null;
  }

  function _isInProjectContext() {
    return /^\/project\//.test(location.pathname);
  }

  function _stableTurnId(el) {
    // Try data-testid first, then a generated index from DOM order.
    const tid = el.getAttribute('data-testid')
             || el.id
             || el.closest('[data-testid]')?.getAttribute('data-testid');
    if (tid) return tid;
    // Fallback: use a hash of first 200 chars of innerText as a turnId.
    const text = (el.textContent || '').slice(0, 200);
    return 'h-' + DOM.stableHash(text);
  }

  function _scanAttachments() {
    // Attachment chips render with file metadata. Common patterns:
    //   - role="button" with file name + size text
    //   - data-testid containing "attachment" or "file"
    //   - svg + filename + size string like "1.2 MB"
    const chips = DOM.querySelectorAll([
      '[data-testid*="attachment"]',                  // SELECTOR_VERIFY
      '[data-testid*="file"]',
      '[role="button"][aria-label*="file" i]',
    ]);

    let total = 0;
    for (const chip of chips) {
      const text = chip.textContent || '';
      const sizeMatch = text.match(/([\d.]+)\s*(B|KB|MB|GB)/i);
      const nameMatch = text.match(/([^\s]+\.[a-z0-9]{2,5})/i);
      if (!sizeMatch && !nameMatch) continue;

      const sizeBytes = sizeMatch ? _parseSizeToBytes(sizeMatch[1], sizeMatch[2]) : 0;
      const name = nameMatch ? nameMatch[1] : '';
      // mediaType inferred from extension; chip itself rarely exposes it.
      const ext = (name.split('.').pop() || '').toLowerCase();
      const mediaType = _extToMime(ext);

      total += Tokenizer.estimateAttachment({ name, sizeBytes, mediaType });
    }
    return total;
  }

  function _parseSizeToBytes(num, unit) {
    const n = parseFloat(num);
    const u = unit.toUpperCase();
    return Math.ceil(n * ({ B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[u] || 1));
  }

  function _extToMime(ext) {
    return {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp',
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }[ext] || '';
  }

  function _scanActiveTools() {
    // Tool toggles are usually buttons with aria-pressed near the composer.
    // We map their aria-label to canonical tool ids.
    const candidates = DOM.querySelectorAll([
      'button[aria-pressed="true"]',                  // SELECTOR_VERIFY
      '[role="switch"][aria-checked="true"]',
    ]);

    const ids = [];
    for (const btn of candidates) {
      const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
      if (/web\s*search|search the web/.test(label)) ids.push('web_search');
      else if (/analysis|code interpret/.test(label)) ids.push('analysis');
      else if (/artifact/.test(label)) ids.push('artifacts');
      else if (/google\s*drive/.test(label)) ids.push('google_drive');
      else if (/google\s*calendar|calendar/.test(label)) ids.push('google_calendar');
      else if (/gmail/.test(label)) ids.push('gmail');
      else if (/notion/.test(label)) ids.push('notion');
      else if (/slack/.test(label)) ids.push('slack');
      else if (/asana/.test(label)) ids.push('asana');
      else if (/linear/.test(label)) ids.push('linear');
      else if (/github/.test(label)) ids.push('github');
      else if (/figma/.test(label)) ids.push('figma');
      // Unknown MCP servers — count them as generic.
      else if (/mcp|connector/.test(label)) ids.push('mcp_generic');
    }
    return ids;
  }

  // ── detectStreamState ──────────────────────────────────────────────────────

  function detectStreamState() {
    if (_hasHardLimitBanner()) return 'limit-reached';

    // Strategy 1: Look for stop button by aria-label (en + zh + testid) or positional detection
    const stopBtn = DOM.querySelectorFirst([
      'button[aria-label*="Stop" i]',
      'button[aria-label*="stop response" i]',
      'button[aria-label*="停止" i]',
      'button[aria-label*="中止" i]',
      'button[aria-label*="暂停" i]',
      'button[aria-label*="停止生成" i]',
      'button[data-testid*="stop"]',
      // NOTE: wiggle-controls-actions is always in DOM (idle+streaming), NOT used for stop detection
    ], (el) => !el.hidden && el.offsetParent !== null);

    if (stopBtn) return 'streaming';

    // Strategy 1b: Positional stop — find the button in the same container as chat-input.
    // During streaming it transforms from send → stop (square icon).
    // We detect this by checking if the primary action button has no text / is icon-only.
    try {
      const ci = document.querySelector('[data-testid="chat-input"]');
      const ciContainer = ci && (
        ci.closest('form') || ci.closest('fieldset') || ci.parentElement?.parentElement
      );
      if (ciContainer) {
        const btns = Array.from(ciContainer.querySelectorAll('button')).filter(
          (b) => !b.hidden && b.offsetParent !== null && !b.disabled
        );
        // The action button (send/stop) is usually the rightmost visible button.
        // During streaming it has no meaningful text and a square/stop SVG.
        const actionBtn = btns[btns.length - 1];
        if (actionBtn) {
          const label = (actionBtn.getAttribute('aria-label') || '').toLowerCase();
          const txt = (actionBtn.textContent || '').trim();
          // If button has no recognizable "send" label and no text → likely stop button
          const looksLikeStop = /stop|停|中止|cancel/i.test(label);
          // NOTE: do NOT use SVG presence as a stop indicator — the idle send button
          // is also SVG-only, which would cause permanent false 'streaming' detection.
          if (looksLikeStop) {
            return 'streaming';
          }
        }
      }
    } catch (_) {}

    // Strategy 2: Composer disabled (contenteditable false or readonly).
    // While Claude is streaming, the composer is non-interactive.
    const composer = DOM.querySelectorFirst([
      '[data-testid="chat-input"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="Reply" i]',
      'textarea[placeholder*="Message" i]',
    ]);
    const composerDisabled = composer && (
      composer.getAttribute('contenteditable') === 'false' ||
      composer.getAttribute('aria-disabled') === 'true' ||
      composer.hasAttribute('readonly') ||
      composer.disabled
    );

    // Strategy 3: Last assistant message is actively growing — track text len.
    // Initialize to current length to avoid false 'streaming' on page load.
    const assistantMsgs = DOM.querySelectorAll([
      '[class*="font-claude-response"]',
      '[data-testid="assistant-message"]',
    ]);
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    let isGrowing = false;
    if (lastAssistant) {
      const curLen = (lastAssistant.innerText || '').length;
      if (state._lastAssistantLen === undefined) {
        // First call — seed with current length so page load doesn't trigger streaming
        state._lastAssistantLen = curLen;
      } else {
        const prevLen = state._lastAssistantLen;
        if (curLen > prevLen + 3) isGrowing = true;  // threshold: 3 chars
        state._lastAssistantLen = curLen;
      }
    } else {
      state._lastAssistantLen = undefined;  // reset when no assistant messages
    }

    // If composer is disabled AND assistant is growing → streaming
    if (composerDisabled || isGrowing) return 'streaming';

    // Send button detection for submitting state
    const sendBtn = DOM.querySelectorFirst([
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送" i]',
      'button[aria-label*="Submit" i]',
      'button[data-testid*="send"]',
      'fieldset button[type="submit"]',
    ]) || (() => {
      // Positional: rightmost button in chat-input container that looks like send
      try {
        const ci = document.querySelector('[data-testid="chat-input"]');
        const ciContainer = ci && (ci.closest('form') || ci.closest('fieldset') || ci.parentElement?.parentElement);
        if (ciContainer) {
          const btns = Array.from(ciContainer.querySelectorAll('button')).filter(b => b.offsetParent !== null);
          const last = btns[btns.length - 1];
          if (last) {
            const label = (last.getAttribute('aria-label') || '').toLowerCase();
            if (/send|发送|submit/i.test(label) || last.querySelector('svg')) return last;
          }
        }
      } catch (_) {}
      return null;
    })();

    const composerHasContent = composer
      ? (composer.textContent || composer.value || '').trim().length > 0
      : false;

    if (sendBtn?.disabled && composerHasContent) return 'submitting';

    if (composer && document.activeElement === composer && composerHasContent) {
      return 'user-typing';
    }

    return 'idle';
  }

  function _hasHardLimitBanner() {
    const signals = detectQuotaSignals();
    return signals.some((s) => s.type === 'hard-limit-5h' || s.type === 'hard-limit-week');
  }

  // ── detectQuotaSignals ─────────────────────────────────────────────────────

  function detectQuotaSignals() {
    const candidates = DOM.querySelectorAll([
      '[role="alert"]',                               // SELECTOR_VERIFY
      '[role="status"]',
      '[data-testid*="banner"]',
      '[data-testid*="warning"]',
      '[data-testid*="limit"]',
    ]);

    const out = [];
    const now = Date.now();

    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (!text) continue;
      const lc = text.toLowerCase();

      // Cheap pre-filter: must mention something quota-relevant.
      if (!/limit|quota|messages?|usage|window|weekly|剩余|限制|每周/.test(lc)) continue;

      const sig = _parseSignalText(text, lc);
      if (sig) {
        sig.detectedAtMs = now;
        out.push(sig);

        // Cache hash for parse-failure detection.
        const hash = DOM.stableHash(text);
        if (!state.bannerCache.has(hash)) {
          state.bannerCache.set(hash, { firstSeenMs: now, signalType: sig.type });
        }
      } else {
        // Banner present but couldn't classify — log once per unique hash.
        const hash = DOM.stableHash(text);
        if (!state.bannerCache.has(hash)) {
          state.bannerCache.set(hash, { firstSeenMs: now, signalType: 'unknown' });
          DOM.log('claude', 'unparsed banner', { hash, text: text.slice(0, 200) });
        }
      }
    }

    return out;
  }

  function _parseSignalText(rawText, lc) {
    // 1. Hard limit (5h or weekly) — Claude shows specific banners.
    const isWeekly = /weekly|7.day|7-day|every week|每周|本周/.test(lc);
    if (/(reached|hit|used up|exhausted).{0,40}(usage|message|chat|limit|quota)/.test(lc)
     || /usage.{0,20}limit.{0,20}reached/.test(lc)
     || /you.ve.{0,10}(reached|used|hit).{0,30}(limit|messages|usage)/.test(lc)
     || /已(达到|用完|耗尽).{0,15}(使用|消息|限制)/.test(rawText)
     || /本周.{0,10}(消息|使用|额度).{0,10}(已满|用完|到达限制)/.test(rawText)
     || /used all your.{0,20}(messages|usage) for this (week|5.hour|session)/.test(lc)) {
      if (isWeekly) {
        return { type: 'hard-limit-week', rawText, releaseAtMs: _parseResetTime(rawText) };
      }
      return { type: 'hard-limit-5h', rawText, releaseAtMs: _parseResetTime(rawText) };
    }

    // 2. Soft warning — count of remaining messages.
    let m = lc.match(/(\d+)\s+messages?\s+(left|remaining)/);
    if (!m) m = rawText.match(/剩余\s*(\d+)\s*条/);
    if (!m) m = lc.match(/(\d+)\s+(more\s+)?messages?\s+(?:in|for|this)/);
    if (m) {
      const remaining = parseInt(m[1], 10);
      return {
        type: isWeekly ? 'soft-warn-week' : 'soft-warn-5h',
        rawText,
        messagesRemaining: remaining,
      };
    }

    // 3. Approaching limit (no specific count).
    if (/approaching.{0,20}(weekly|7.day|每周)/.test(lc)) {
      return { type: 'soft-warn-week', rawText };
    }
    if (/approaching.{0,20}(usage|message|5.hour)/.test(lc)) {
      return { type: 'soft-warn-5h', rawText };
    }

    // 4. Model downgrade.
    m = lc.match(/switch(ed|ing)?\s+to\s+(haiku|sonnet)/);
    if (m && /quota|limit|exhausted/.test(lc)) {
      return {
        type: 'model-downgrade',
        rawText,
        toModel: m[2],
        // fromModel is harder to extract — usually implicit. Leave null.
      };
    }

    return null;
  }

  function _parseResetTime(text) {
    // "Try again at 18:30 PT" / "at 6:30 PM PT" / "at 18:30"
    let m = text.match(/at\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?\s*([A-Z]{2,4})?/);
    if (!m) {
      // Chinese: "请在 18:30 后重试"
      const cn = text.match(/(\d{1,2}):(\d{2})/);
      if (!cn) return null;
      m = cn;
    }

    const now = new Date();
    let hour = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = (m[3] || '').toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;

    // Note: we ignore the timezone abbrev (PT/ET/etc) in v1 — Claude renders
    // the banner in the user's local time anyway. This is observed behavior;
    // if it changes we'll need to handle TZ explicitly.
    const target = new Date(now);
    target.setHours(hour, min, 0, 0);
    if (target < now) target.setDate(target.getDate() + 1); // tomorrow
    return target.getTime();
  }

  // ── fetchQuota ─────────────────────────────────────────────────────────────

  async function fetchQuota() {
    // We can't fetch /settings/usage directly from the content script in a
    // way that survives Anthropic's CSP — and shouldn't, because the
    // background service worker handles the fetch once for all tabs and
    // dedups across browser windows.
    //
    // Content script asks the SW for the latest snapshot; SW decides
    // whether to use cache, fire a new fetch, or return stale-marked data.
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'GET_QUOTA', platformId: 'claude' },
          (resp) => {
            if (chrome.runtime.lastError || !resp) {
              resolve({
                fiveHourPercent: 0,
                weeklyPercent: 0,
                fiveHourReleaseAtMs: null,
                weeklyResetAtMs: null,
                fetchedAtMs: Date.now(),
                source: 'unavailable',
              });
              return;
            }
            resolve(resp.snapshot || {
              fiveHourPercent: 0,
              weeklyPercent: 0,
              fiveHourReleaseAtMs: null,
              weeklyResetAtMs: null,
              fetchedAtMs: Date.now(),
              source: 'unavailable',
            });
          }
        );
      } catch (e) {
        // Extension context invalidated — return graceful default.
        resolve({
          fiveHourPercent: 0,
          weeklyPercent: 0,
          fiveHourReleaseAtMs: null,
          weeklyResetAtMs: null,
          fetchedAtMs: Date.now(),
          source: 'unavailable',
        });
      }
    });
  }

  // ── Public surface (the five methods + identity hooks) ────────────────────

  return {
    id: 'claude',
    displayName: 'Claude',
    matches(hostname) {
      return hostname === 'claude.ai' || hostname.endsWith('.claude.ai');
    },

    getActiveModel,
    scanConversation,
    detectStreamState,
    detectQuotaSignals,
    // detectLimitBanner is injected by the patch IIFE below (Platform not in scope here)
    fetchQuota,

    // Internal — exposed for tests / debug only.
    _state: state,
    _MODELS: MODELS,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ClaudePlatform;
// Patch: complete the platform module with attach/detach/composer/navigation
// methods. This file is appended to claude.js by the build step.

(function (Platform) {
  if (!Platform) return;

  const state = Platform._state;
  let _hooks = null;
  let _observers = [];
  let _routeTimer = null;
  let _lastUrl = null;
  let _lastStreamState = 'idle';
  let _changeDebounce = null;

  function _onChangeDebounced() {
    if (!_hooks || !_hooks.onChange) return;
    clearTimeout(_changeDebounce);
    _changeDebounce = setTimeout(() => _hooks.onChange(), 200);
  }

  Platform.attach = async function (hooks) {
    _hooks = hooks || { onChange: () => {} };
    _lastUrl = location.href;

    // 1. Mutation observer on body — catches DOM changes including SPA route swaps.
    const moBody = new MutationObserver(() => {
      _onChangeDebounced();
      _checkStreamTransition();
      _checkRouteChange();
    });
    moBody.observe(document.body, { childList: true, subtree: true, characterData: true });
    _observers.push(moBody);

    // 2. Patch history methods to detect pushState/replaceState route changes.
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () { origPush.apply(this, arguments); _checkRouteChange(); };
    history.replaceState = function () { origReplace.apply(this, arguments); _checkRouteChange(); };
    window.addEventListener('popstate', _checkRouteChange);

    // 3. URL polling as a safety net (some SPAs don't always trigger above).
    _routeTimer = setInterval(_checkRouteChange, 1000);
  };

  Platform.detach = function () {
    _observers.forEach((o) => o.disconnect());
    _observers = [];
    if (_routeTimer) { clearInterval(_routeTimer); _routeTimer = null; }
    window.removeEventListener('popstate', _checkRouteChange);
    clearTimeout(_changeDebounce);
    _hooks = null;
  };

  function _checkRouteChange() {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      // Conv changed — reset stream session and let dispatcher re-scan.
      state.streamSession = null;
      _onChangeDebounced();
    }
  }

  function _checkStreamTransition() {
    const cur = Platform.detectStreamState();
    if (cur === _lastStreamState) return;

    // idle → submitting/streaming: snapshot input
    if ((_lastStreamState === 'idle' || _lastStreamState === 'user-typing')
        && (cur === 'submitting' || cur === 'streaming')) {
      const snap = Platform.scanConversation();
      state.streamSession = {
        startedAtMs: Date.now(),
        inputCommitted: snap.contextTokens,
        lastSeenOutputTokens: 0,
      };
    }

    // streaming → idle: clear stream session (dispatcher records turn first)
    if (_lastStreamState === 'streaming' && cur === 'idle') {
      state.streamSession = null;
    }

    _lastStreamState = cur;
    _onChangeDebounced();
  }

  Platform.getInflightInputTokens = function () {
    return state.streamSession ? state.streamSession.inputCommitted : null;
  };

  Platform.getInflightOutputTokens = function () {
    if (!state.streamSession) return null;

    // Find the last user-message — the streaming reply must come AFTER it.
    // We use document position to filter assistant elements to only those
    // following the last user message, which is the actual current reply.
    let lastUserMsg = null;
    try {
      const userMsgs = document.querySelectorAll('[data-testid="user-message"], [class*="font-user-message"]');
      if (userMsgs.length) lastUserMsg = userMsgs[userMsgs.length - 1];
    } catch (_) {}

    // Strategy 1: scan font-claude-response and friends; pick the last one
    // that comes AFTER the last user-message in DOM order.
    const raw = (typeof DOM !== 'undefined' ? DOM.querySelectorAll([
      '[class*="font-claude-response"]',
      '[data-testid="assistant-message"]',
      '[class*="font-claude-message"]',
    ]) : []);
    const turns = raw.filter((el) => !raw.some((o) => o !== el && o.contains(el)));

    if (turns.length && lastUserMsg) {
      // DOCUMENT_POSITION_FOLLOWING = 4: el follows lastUserMsg
      const after = turns.filter((el) =>
        lastUserMsg.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (after.length) {
        const last = after[after.length - 1];
        const text = (last.innerText || last.textContent || '');
        if (text.length > 0) {
          const tokens = (typeof Tokenizer !== 'undefined' ? Tokenizer.estimate(text) : Math.ceil(text.length / 4));
          // Monotonic — never let a brief flicker pull the count backwards.
          if (tokens > state.streamSession.lastSeenOutputTokens) {
            state.streamSession.lastSeenOutputTokens = tokens;
          }
          return state.streamSession.lastSeenOutputTokens;
        }
      }
    }

    // Strategy 2: sibling walk from the user-message row — finds streaming reply before class is set.
    if (lastUserMsg) {
      try {
        const msgRow = lastUserMsg.parentElement?.parentElement;
        if (msgRow) {
          const convContainer = msgRow.parentElement;
          const rows = convContainer ? Array.from(convContainer.children) : [];
          const rowIdx = rows.indexOf(msgRow);
          // Check all rows after the last user-message row
          for (let i = rowIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            if (row.dataset?.tmWidget) continue; // skip our own widgets
            const text = (row.innerText || row.textContent || '').trim();
            if (text.length > 3) {
              const tokens = (typeof Tokenizer !== 'undefined' ? Tokenizer.estimate(text) : Math.ceil(text.length / 4));
              if (tokens > 0) {
                if (tokens > state.streamSession.lastSeenOutputTokens) {
                  state.streamSession.lastSeenOutputTokens = tokens;
                }
                return state.streamSession.lastSeenOutputTokens;
              }
            }
          }
        }
      } catch (_) {}
    }

    return state.streamSession.lastSeenOutputTokens;
  };

  // ── Composer ops ──────────────────────────────────────────────────────────

  function _findComposer() {
    return DOM.querySelectorFirst([
      '[data-testid="chat-input"]',                   // primary (2026-05+)
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="Reply" i]',
      'textarea[placeholder*="Message" i]',
      'fieldset div[contenteditable="true"]',
    ]);
  }

  Platform.readComposerDraft = function () {
    const c = _findComposer();
    if (!c) return '';
    if (c.tagName === 'TEXTAREA') return c.value || '';
    return (c.innerText || c.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  };

  Platform.writeComposerDraft = function (text) {
    const c = _findComposer();
    if (!c) return false;
    c.focus();

    if (c.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(c, text);
      c.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    // contenteditable: select all + insertText is the most React-friendly path
    try {
      const range = document.createRange();
      range.selectNodeContents(c);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      // execCommand is deprecated but still the most reliable for React-controlled CE
      document.execCommand('insertText', false, text);
      c.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    } catch (e) {
      // Fallback: set textContent + dispatch
      c.textContent = text;
      c.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    }
  };

  Platform.submitComposer = function () {
    // Try aria-label selectors first (English / Chinese)
    let sendBtn = DOM.querySelectorFirst([
      'button[aria-label*="Send" i]:not([disabled])',
      'button[aria-label*="发送" i]:not([disabled])',
      'button[aria-label*="Submit" i]:not([disabled])',
      'button[data-testid*="send"]:not([disabled])',
      'fieldset button[type="submit"]:not([disabled])',
    ]);
    // Positional fallback: rightmost enabled button in chat-input container
    if (!sendBtn) {
      try {
        const ci = document.querySelector('[data-testid="chat-input"]');
        const container = ci && (ci.closest('form') || ci.closest('fieldset') || ci.parentElement?.parentElement);
        if (container) {
          const btns = Array.from(container.querySelectorAll('button')).filter(
            (b) => !b.disabled && !b.hidden && b.offsetParent !== null
          );
          const last = btns[btns.length - 1];
          if (last) {
            const label = (last.getAttribute('aria-label') || '').toLowerCase();
            // Ensure it's not a stop button or attachment button
            if (!/stop|停|attach|clip|file|upload/i.test(label)) sendBtn = last;
          }
        }
      } catch (_) {}
    }
    if (!sendBtn) return false;
    sendBtn.click();
    return true;
  };

  // ── Navigation ────────────────────────────────────────────────────────────

  Platform.startNewChat = async function () {
    const before = location.href;
    // Prefer SPA navigation
    history.pushState({}, '', '/new');
    window.dispatchEvent(new PopStateEvent('popstate'));

    // Wait for URL to settle to /chat/{uuid} OR for composer to be present on /new
    const start = Date.now();
    while (Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 150));
      if (location.href !== before && _findComposer()) return location.href;
    }
    // Fallback: try clicking the sidebar "New chat" button
    const btn = DOM.querySelectorFirst([
      'a[href="/new"]',
      'button[aria-label*="New chat" i]',
      'a[aria-label*="New chat" i]',
    ]);
    if (btn) {
      btn.click();
      const start2 = Date.now();
      while (Date.now() - start2 < 5000) {
        await new Promise((r) => setTimeout(r, 150));
        if (location.href !== before) return location.href;
      }
    }
    return null;
  };

  Platform.detectLimitBanner = function () {
    // Returns { atLimit: boolean, releaseAtMs: number|null }
    // Uses detectQuotaSignals() which already parses all banner text.
    const signals = Platform.detectQuotaSignals();
    const hardLimit = signals.find((s) => s.type === 'hard-limit-5h' || s.type === 'hard-limit-week');
    return {
      atLimit: !!hardLimit,
      releaseAtMs: hardLimit?.releaseAtMs || null,
      type: hardLimit?.type || null,
    };
  };

  Platform.getCurrentConversationId = function () {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]+)/i)
           || location.pathname.match(/\/project\/[^/]+\/chat\/([0-9a-f-]+)/i);
    return m ? m[1] : null;
  };

  // ── Account / plan ────────────────────────────────────────────────────────

  // DOM-based plan detection — runs in content script context
  function _detectPlanFromDOM() {
    // Claude shows "Free plan" text in the header area for Free users
    // and an "Upgrade" button. Check for these signals.
    const bodyText = document.body?.innerText || '';
    const hasFreeLabel = /free plan/i.test(bodyText.slice(0, 5000)); // check header area
    const hasUpgradeBtn = document.querySelector('a[href*="/upgrade"], button[data-testid*="upgrade"]');
    if (hasFreeLabel || hasUpgradeBtn) return 'free';
    return null; // unknown from DOM
  }

  Platform.getPlan = async function () {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'GET_PLAN', platformId: 'claude' },
          (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.plan) {
              // Fall back to DOM detection if API plan unknown
              const domTier = _detectPlanFromDOM();
              if (domTier === 'free') {
                resolve({ tier: 'free', displayName: 'Free', fiveHourBudget: null, weeklyBudget: null });
              } else {
                resolve({ tier: 'unknown', displayName: 'Unknown', fiveHourBudget: null, weeklyBudget: null });
              }
              return;
            }
            // DOM detection overrides API if it says Free (API can't distinguish)
            const domTier = _detectPlanFromDOM();
            if (domTier === 'free' && resp.plan.tier !== 'free') {
              resolve({ ...resp.plan, tier: 'free', displayName: 'Free' });
            } else {
              resolve(resp.plan);
            }
          }
        );
      } catch (e) {
        resolve({ tier: 'unknown', displayName: 'Unknown', fiveHourBudget: null, weeklyBudget: null });
      }
    });
  };

  // ── UI anchors ────────────────────────────────────────────────────────────

  Platform.getOverlayAnchor = function () {
    return document.body;
  };

  Platform.getComposerAnchor = function () {
    const c = _findComposer();
    if (!c) return null;
    // Claude's composer is inside a div structure, not a <form> or <fieldset>.
    // Walk up looking for the composer toolbar container (typically 3-4 levels up).
    let el = c.parentElement;
    for (let i = 0; i < 6; i++) {
      if (!el) break;
      if (el.tagName === 'FIELDSET' || el.tagName === 'FORM') return el;
      if (el.getAttribute('role') === 'form') return el;
      // Identify the toolbar container: has multiple children, contains buttons + composer
      if (el.children.length >= 2 && el.querySelector('button')) return el;
      el = el.parentElement;
    }
    return c.parentElement;
  };

  Platform.getTurnAnchorResolver = function () {
    return function (turnId) {
      // Find user-message element by data-testid first
      let el = document.querySelector(`[data-testid="${turnId}"]`);
      if (!el) {
        // Hash-based id fallback — these were synthesized at scan time
        // and we can't recover original element from a content hash.
        return null;
      }
      // Return the element itself; injector will append a sibling badge
      return el;
    };
  };

})(typeof ClaudePlatform !== 'undefined' ? ClaudePlatform : null);
