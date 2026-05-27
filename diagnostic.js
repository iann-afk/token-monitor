// diagnostic.js — runs a set of probes and assembles a copy-pasteable report.

(function () {

  const probes = [
    {
      name: 'Extension version & manifest',
      run: async () => {
        const m = chrome.runtime.getManifest();
        return { status: 'pass', detail: { name: m.name, version: m.version, permissions: m.permissions, hosts: m.host_permissions } };
      },
    },

    {
      name: 'Service worker reachability',
      run: async () => {
        const start = Date.now();
        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'PING' }, (r) => {
            void chrome.runtime.lastError;
            resolve({ r, lastError: chrome.runtime.lastError?.message });
          });
        });
        const ms = Date.now() - start;
        if (resp.lastError) return { status: 'fail', detail: { error: resp.lastError, roundTripMs: ms } };
        return { status: 'pass', detail: { roundTripMs: ms, response: resp.r } };
      },
    },

    {
      name: 'Active Claude tab',
      run: async () => {
        const tabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
        if (!tabs.length) return { status: 'warn', detail: 'No claude.ai tabs are open' };
        return { status: 'pass', detail: { count: tabs.length, urls: tabs.map((t) => t.url).slice(0, 3) } };
      },
    },

    {
      name: 'Stored settings',
      run: async () => {
        const data = await chrome.storage.sync.get('tokenMonitorSettings');
        return { status: 'pass', detail: data.tokenMonitorSettings || '(default)' };
      },
    },

    {
      name: 'Stored quota cache',
      run: async () => {
        const data = await chrome.storage.local.get('quota:claude');
        const snap = data['quota:claude'];
        if (!snap) return { status: 'warn', detail: 'No cached snapshot yet' };
        const ageMs = Date.now() - (snap.fetchedAtMs || 0);
        const status = snap.source === 'unavailable' ? 'fail' : (ageMs > 300000 ? 'warn' : 'pass');
        return { status, detail: { ...snap, ageMinutes: Math.round(ageMs / 60000) } };
      },
    },

    {
      name: 'Stored plan',
      run: async () => {
        const data = await chrome.storage.local.get('plan:claude');
        const plan = data['plan:claude'];
        if (!plan || plan.tier === 'unknown') return { status: 'warn', detail: plan || '(none)' };
        return { status: 'pass', detail: plan };
      },
    },

    {
      name: 'Stored calibration',
      run: async () => {
        const data = await chrome.storage.local.get('calibration:claude');
        const c = data['calibration:claude'];
        if (!c) return { status: 'warn', detail: '(no calibration data yet)' };
        return { status: 'pass', detail: { budget: c.estimatedFiveHourBudget, observations: c.observations?.length || 0 } };
      },
    },

    {
      name: 'Trigger fresh quota fetch',
      run: async () => {
        const start = Date.now();
        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'REFRESH_QUOTA', platformId: 'claude' }, (r) => {
            void chrome.runtime.lastError;
            resolve({ r, lastError: chrome.runtime.lastError?.message });
          });
        });
        const ms = Date.now() - start;
        if (resp.lastError) return { status: 'fail', detail: { error: resp.lastError, ms } };
        const snap = resp.r?.snapshot;
        if (!snap) return { status: 'fail', detail: { ms, response: resp.r } };
        const status = snap.source === 'unavailable' ? 'fail' : 'pass';
        return { status, detail: { ms, snapshot: snap } };
      },
    },

    {
      name: 'Diagnosis blob (last fetch)',
      run: async () => {
        const data = await chrome.storage.local.get('diag:claude');
        const d = data['diag:claude'];
        if (!d) return { status: 'fail', detail: '(no diagnosis stored)' };
        return { status: 'pass', detail: d };
      },
    },

    {
      name: 'Live tab — content script reachability',
      run: async () => {
        // Use any Claude tab, not just the active one (diagnostic page itself is active)
        const claudeTabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
        if (!claudeTabs.length) {
          return { status: 'warn', detail: 'No Claude tabs open. Open claude.ai and rerun.' };
        }
        const tab = claudeTabs.find(t => /chat/.test(t.url || '')) || claudeTabs[0];
        const start = Date.now();
        const resp = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, { type: 'TM_GET_LIVE' }, (r) => {
            void chrome.runtime.lastError;
            resolve({ r, lastError: chrome.runtime.lastError?.message });
          });
        });
        const ms = Date.now() - start;
        if (resp.lastError) return { status: 'fail', detail: { error: resp.lastError, ms, tabUrl: tab.url } };
        return { status: 'pass', detail: { ms, tabUrl: tab.url, response: resp.r } };
      },
    },

    {
      name: 'Live tab — limit banner & stream state',
      run: async () => {
        const claudeTabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
        if (!claudeTabs.length) return { status: 'warn', detail: 'No Claude tabs open.' };
        const tab = claudeTabs.find(t => /chat/.test(t.url || '')) || claudeTabs[0];
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Test detectLimitBanner via dispatcher
            let bannerResult = null;
            try {
              bannerResult = (typeof Dispatcher !== 'undefined')
                ? Dispatcher._state?.platform?.detectLimitBanner?.()
                : null;
            } catch(e) { bannerResult = { error: String(e) }; }
            // Test detectStreamState
            let streamState = null;
            try {
              streamState = (typeof Dispatcher !== 'undefined')
                ? Dispatcher._state?.platform?.detectStreamState?.()
                : null;
            } catch(e) { streamState = { error: String(e) }; }
            // Test readComposerDraft
            let draft = null;
            try {
              draft = (typeof Dispatcher !== 'undefined')
                ? Dispatcher._state?.platform?.readComposerDraft?.()
                : null;
            } catch(e) { draft = { error: String(e) }; }
            return { bannerResult, streamState, composerDraft: (draft || '').slice(0, 100) };
          },
        });
        const data = results?.[0]?.result;
        if (!data) return { status: 'fail', detail: 'executeScript returned no result' };
        const status = data.bannerResult?.error || data.streamState?.error ? 'warn' : 'pass';
        return { status, detail: { tabUrl: tab.url, ...data } };
      },
    },

    {
      name: 'Live tab — conversation DOM structure',
      run: async () => {
        const claudeTabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
        if (!claudeTabs.length) return { status: 'warn', detail: 'No Claude tabs open.' };
        const tab = claudeTabs.find(t => /chat/.test(t.url || '')) || claudeTabs[0];
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const userMsgs = Array.from(document.querySelectorAll('[data-testid="user-message"]'));
            if (!userMsgs.length) return { error: 'no user-message elements found' };
            const out = [];
            userMsgs.forEach((um, i) => {
              const parent = um.parentElement;
              const grandParent = parent?.parentElement;
              // Dump parent's children summary
              const siblings = parent ? Array.from(parent.children).map(el => ({
                tag: el.tagName,
                testid: el.getAttribute('data-testid'),
                classes: el.className.slice(0, 120),
                childCount: el.children.length,
                textLen: (el.innerText || '').length,
                outerStart: el.outerHTML.slice(0, 150),
              })) : [];
              out.push({
                userMsgIndex: i,
                parentTag: parent?.tagName,
                parentClasses: parent?.className.slice(0, 100),
                grandParentTag: grandParent?.tagName,
                grandParentClasses: grandParent?.className.slice(0, 100),
                siblings,
              });
            });
            return out;
          },
        });
        const data = results?.[0]?.result;
        if (!data) return { status: 'fail', detail: 'executeScript returned no result' };
        if (data.error) return { status: 'fail', detail: data };
        return { status: 'pass', detail: data };
      },
    },

    {
      name: 'Live tab — data-testid inventory',
      run: async () => {
        const claudeTabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
        if (!claudeTabs.length) return { status: 'warn', detail: 'No Claude tabs open.' };
        const tab = claudeTabs.find(t => /chat/.test(t.url || '')) || claudeTabs[0];
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const all = document.querySelectorAll('[data-testid]');
            const counts = {};
            all.forEach(el => {
              const id = el.getAttribute('data-testid');
              counts[id] = (counts[id] || 0) + 1;
            });
            // Also grab first 300 chars of outerHTML for message-like testids
            const messageSamples = {};
            all.forEach(el => {
              const id = el.getAttribute('data-testid');
              if (/message|chat|response|turn|human|assistant|ai|claude|user/i.test(id) && !messageSamples[id]) {
                messageSamples[id] = el.outerHTML.slice(0, 200);
              }
            });
            return { counts, messageSamples };
          },
        });
        const data = results?.[0]?.result;
        if (!data) return { status: 'fail', detail: 'executeScript returned no result' };
        const messageRelated = Object.fromEntries(
          Object.entries(data.counts).filter(([k]) => /message|chat|response|turn|human|assistant|ai|claude|user/i.test(k))
        );
        return { status: 'pass', detail: { tabUrl: tab.url, messageRelatedTestIds: messageRelated, messageSamples: data.messageSamples, totalTestIds: Object.keys(data.counts).length } };
      },
    },

    {
      name: 'Live tab — scanConversation results (LIVE)',
      run: async () => {
        const claudeTabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
        if (!claudeTabs.length) return { status: 'warn', detail: 'No Claude tabs open.' };
        const tab = claudeTabs.find(t => /chat/.test(t.url || '')) || claudeTabs[0];

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Run the SAME selector chains scanConversation uses, in same order.
            // This tells us exactly which one matched and how many turns the
            // platform module is finding.
            const userSelectors = [
              '[data-testid="user-message"]',
              '[class*="font-user-message"]',
              'div[data-test-render-count] [class*="font-user-message"]',
              '[data-testid*="user"][data-testid*="message"]',
            ];
            const assistantSelectors = [
              '[class*="font-claude-response"]',        // primary (2026-05+)
              '[data-testid="assistant-message"]',
              '[class*="font-claude-message"]',
              'div[data-test-render-count] [class*="font-claude-message"]',
              '[data-testid*="assistant"][data-testid*="message"]',
            ];
            const probe = (sels) => sels.map((sel) => {
              try { return { sel, count: document.querySelectorAll(sel).length }; }
              catch (e) { return { sel, count: -1, error: String(e) }; }
            });

            const sampleFirstMatch = (sels) => {
              for (const sel of sels) {
                try {
                  const el = document.querySelector(sel);
                  if (el) {
                    return {
                      sel,
                      tag: el.tagName,
                      classes: (el.className || '').slice(0, 100),
                      textLen: (el.innerText || '').length,
                      textSample: (el.innerText || '').slice(0, 200),
                      outerStart: el.outerHTML.slice(0, 200),
                    };
                  }
                } catch (_) {}
              }
              return null;
            };

            return {
              userSelectorMatches: probe(userSelectors),
              assistantSelectorMatches: probe(assistantSelectors),
              firstUserSample: sampleFirstMatch(userSelectors),
              firstAssistantSample: sampleFirstMatch(assistantSelectors),
              url: location.href,
            };
          },
        });
        const data = results?.[0]?.result;
        if (!data) return { status: 'fail', detail: 'executeScript returned no result' };
        const totalUser = data.userSelectorMatches.reduce((s, m) => s + Math.max(0, m.count), 0);
        const totalAssistant = data.assistantSelectorMatches.reduce((s, m) => s + Math.max(0, m.count), 0);
        let status = 'pass';
        if (totalUser === 0 && totalAssistant === 0) status = 'fail';
        else if (totalUser === 0 || totalAssistant === 0) status = 'warn';
        return { status, detail: data };
      },
    },

    {
      name: 'Live tab — find assistant message DOM (heuristic)',
      run: async () => {
        const claudeTabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
        if (!claudeTabs.length) return { status: 'warn', detail: 'No Claude tabs open.' };
        const tab = claudeTabs.find(t => /chat/.test(t.url || '')) || claudeTabs[0];

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Strategy: find user messages, then walk forward through their
            // siblings/cousins to find the assistant response that follows.
            const userMsgs = Array.from(document.querySelectorAll('[data-testid="user-message"]'));
            if (!userMsgs.length) return { error: 'no user-message elements' };

            const out = {
              userMsgCount: userMsgs.length,
              candidates: [],
              dataTestIdInventory: {},
              assistantStructureGuesses: [],
            };

            // Walk up to find a stable "turn container" wrapper
            const findTurnContainer = (el) => {
              let cur = el;
              for (let i = 0; i < 12 && cur; i++) {
                if (cur.parentElement && cur.parentElement.children.length >= 2) {
                  // Likely a turn-list parent
                  return cur;
                }
                cur = cur.parentElement;
              }
              return null;
            };

            // For each user message, try to find what comes AFTER it visually
            // (DOM-order or sibling-order)
            const firstUser = userMsgs[0];
            const turnContainer = findTurnContainer(firstUser);
            const turnList = turnContainer?.parentElement;

            if (turnList) {
              // List all children of turn-list with their attributes
              const children = Array.from(turnList.children).map((el, i) => ({
                idx: i,
                tag: el.tagName,
                testid: el.getAttribute('data-testid'),
                role: el.getAttribute('role'),
                ariaLabel: el.getAttribute('aria-label'),
                classesPrefix: (el.className || '').slice(0, 150),
                hasUserMsg: !!el.querySelector('[data-testid="user-message"]'),
                textLen: (el.innerText || '').length,
                textSample: (el.innerText || '').slice(0, 100),
                directChildren: el.children.length,
                outerStart: el.outerHTML.slice(0, 250),
              }));
              out.turnListSummary = {
                tag: turnList.tagName,
                classesPrefix: (turnList.className || '').slice(0, 150),
                childCount: children.length,
                children,
              };
            }

            // Use first user message as anchor; find next sibling/relative
            // that contains a long block of text (assistant reply pattern)
            const findNextAssistantLike = (userEl) => {
              // Walk up to common ancestor with siblings
              let pivot = userEl;
              for (let i = 0; i < 10 && pivot; i++) {
                if (pivot.nextElementSibling) {
                  return {
                    foundAt: 'nextElementSibling',
                    levelsUp: i,
                    el: pivot.nextElementSibling,
                  };
                }
                pivot = pivot.parentElement;
              }
              return null;
            };

            for (let i = 0; i < Math.min(2, userMsgs.length); i++) {
              const next = findNextAssistantLike(userMsgs[i]);
              if (next?.el) {
                const el = next.el;
                out.candidates.push({
                  fromUserMsgIndex: i,
                  foundAt: next.foundAt,
                  levelsUp: next.levelsUp,
                  tag: el.tagName,
                  testid: el.getAttribute('data-testid'),
                  role: el.getAttribute('role'),
                  classesPrefix: (el.className || '').slice(0, 150),
                  textLen: (el.innerText || '').length,
                  textSample: (el.innerText || '').slice(0, 200),
                  outerStart: el.outerHTML.slice(0, 300),
                });
              }
            }

            // Also list ALL data-testid values in the chat area, with counts
            // (filtered to those near user messages)
            const allTestIds = {};
            document.querySelectorAll('[data-testid]').forEach(el => {
              const id = el.getAttribute('data-testid');
              allTestIds[id] = (allTestIds[id] || 0) + 1;
            });
            out.dataTestIdInventory = allTestIds;

            // Look for class-name patterns that suggest assistant content
            // (anything matching common ML/AI/claude/response/message terms)
            const classCandidates = new Set();
            document.querySelectorAll('div[class]').forEach(el => {
              const cls = el.className || '';
              if (typeof cls !== 'string') return;
              if (/claude|assistant|response|model|reply|answer/i.test(cls)) {
                cls.split(/\s+/).forEach(c => {
                  if (c.length > 4 && /claude|assistant|response|reply|answer|prose/i.test(c)) {
                    classCandidates.add(c);
                  }
                });
              }
            });
            out.classCandidates = Array.from(classCandidates).slice(0, 50);

            // Try common modern selectors that might be the new assistant marker
            const modernCandidates = [
              '[class*="prose"]',
              '[class*="message-content"]',
              '[class*="response"]',
              '[class*="claude-response"]',
              'div.prose',
              'article',
              '[data-message-author-role]',
              '[data-author]',
              '[data-message-id]',
              '[data-turn]',
              'div[data-id]',
            ];
            out.modernCandidateProbes = modernCandidates.map(sel => {
              try {
                const els = document.querySelectorAll(sel);
                const sample = els[0] ? {
                  tag: els[0].tagName,
                  textLen: (els[0].innerText || '').length,
                  textSample: (els[0].innerText || '').slice(0, 150),
                  outerStart: els[0].outerHTML.slice(0, 200),
                } : null;
                return { sel, count: els.length, firstSample: sample };
              } catch (e) {
                return { sel, count: -1, error: String(e) };
              }
            }).filter(p => p.count > 0);

            return out;
          },
        });

        const data = results?.[0]?.result;
        if (!data) return { status: 'fail', detail: 'executeScript returned no result' };
        if (data.error) return { status: 'fail', detail: data };
        return { status: 'pass', detail: data };
      },
    },

    {
      name: 'Live tab — selector probe',
      run: async () => {
        const claudeTabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
        if (!claudeTabs.length) {
          return { status: 'warn', detail: 'No Claude tabs open.' };
        }
        const tab = claudeTabs.find(t => /chat/.test(t.url || '')) || claudeTabs[0];
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: probeSelectorsInTab,
        });
        const data = results?.[0]?.result;
        if (!data) return { status: 'fail', detail: 'executeScript returned no result' };
        const failed = data.filter((p) => p.status === 'miss');
        const fellback = data.filter((p) => p.status === 'fallback');
        const status = failed.length > 0 ? 'warn' : (fellback.length > 0 ? 'warn' : 'pass');
        return { status, detail: { tabUrl: tab.url, probes: data } };
      },
    },
  ];

  // ── Function injected into Claude.ai tab ─────────────────────────────────

  function probeSelectorsInTab() {
    const tests = [
      {
        name: 'model button',
        selectors: [
          'button[data-testid*="model"]', 'button[data-testid*="Model"]',
          'header button[aria-haspopup="menu"]', 'main button[aria-haspopup="menu"]',
          'button[aria-haspopup="menu"]',
        ],
        validate: (el) => /sonnet|opus|haiku/i.test(el.textContent || ''),
      },
      {
        name: 'user messages',
        selectors: [
          '[data-testid="user-message"]',
          'div[data-test-render-count] [class*="font-user-message"]',
          '[data-testid*="user"][data-testid*="message"]',
        ],
      },
      {
        name: 'assistant messages',
        selectors: [
          '[class*="font-claude-response"]',
          '[data-testid="assistant-message"]',
          '[class*="font-claude-message"]',
          'div[data-test-render-count] [class*="font-claude-message"]',
          '[data-testid*="assistant"][data-testid*="message"]',
        ],
      },
      {
        name: 'composer',
        selectors: [
          'div[contenteditable="true"]',
          'textarea[placeholder*="Reply" i]',
          'textarea[placeholder*="Message" i]',
        ],
      },
      {
        name: 'send button',
        selectors: [
          'button[aria-label*="Send" i]',
          'button[data-testid*="send"]',
          'fieldset button[type="submit"]',
        ],
      },
      {
        name: 'stop button',
        selectors: [
          'button[aria-label*="Stop" i]',
          'button[aria-label*="stop response" i]',
          'button[data-testid*="stop"]',
        ],
      },
      {
        name: 'banners',
        selectors: [
          '[role="alert"]', '[role="status"]',
          '[data-testid*="banner"]', '[data-testid*="warning"]', '[data-testid*="limit"]',
        ],
      },
    ];

    const out = [];
    for (const t of tests) {
      let hitIndex = -1, count = 0, sample = null;
      for (let i = 0; i < t.selectors.length; i++) {
        try {
          const all = document.querySelectorAll(t.selectors[i]);
          const filtered = t.validate ? Array.from(all).filter(t.validate) : Array.from(all);
          if (filtered.length > 0) {
            hitIndex = i; count = filtered.length;
            sample = (filtered[0].outerHTML || '').slice(0, 240);
            break;
          }
        } catch (_) {}
      }
      out.push({
        name: t.name,
        status: hitIndex === -1 ? 'miss' : (hitIndex === 0 ? 'primary' : 'fallback'),
        hitIndex, count, primarySelector: t.selectors[0],
        matchedSelector: hitIndex >= 0 ? t.selectors[hitIndex] : null,
        sampleHTML: sample,
      });
    }
    return out;
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  const probesEl = document.getElementById('probes');
  const reportEl = document.getElementById('report');
  const statusEl = document.getElementById('status');

  for (const p of probes) {
    p.el = document.createElement('div');
    p.el.className = 'probe';
    p.el.innerHTML = `
      <div class="probe-head">
        <span class="probe-icon pending">·</span>
        <span class="probe-name"></span>
        <span class="probe-detail-summary"></span>
      </div>
      <div class="probe-body"></div>
    `;
    p.el.querySelector('.probe-name').textContent = p.name;
    p.el.querySelector('.probe-head').addEventListener('click', () => p.el.classList.toggle('open'));
    probesEl.appendChild(p.el);
  }

  function renderProbe(p, result) {
    const icon = p.el.querySelector('.probe-icon');
    const summary = p.el.querySelector('.probe-detail-summary');
    const body = p.el.querySelector('.probe-body');

    if (!result) {
      icon.className = 'probe-icon running';
      icon.textContent = '…';
      summary.textContent = 'running';
      return;
    }

    const map = { pass: '✓', warn: '!', fail: '✗' };
    icon.className = 'probe-icon ' + result.status;
    icon.textContent = map[result.status] || '?';
    summary.textContent = typeof result.detail === 'string' ? result.detail : '';
    body.textContent = JSON.stringify(result.detail, null, 2);
  }

  document.getElementById('run').addEventListener('click', async () => {
    statusEl.textContent = 'running…';
    document.getElementById('run').disabled = true;
    const results = [];
    for (const p of probes) {
      renderProbe(p, null);
      let result;
      try {
        result = await Promise.race([
          p.run(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 10s')), 10000)),
        ]);
      } catch (e) {
        result = { status: 'fail', detail: { error: String(e) } };
      }
      results.push({ name: p.name, ...result });
      renderProbe(p, result);
    }
    document.getElementById('run').disabled = false;
    statusEl.textContent = `done · ${results.filter((r) => r.status === 'pass').length} pass · ${results.filter((r) => r.status === 'warn').length} warn · ${results.filter((r) => r.status === 'fail').length} fail`;
    reportEl.value = buildReport(results);
  });

  document.getElementById('copy').addEventListener('click', async () => {
    if (!reportEl.value) return;
    try {
      await navigator.clipboard.writeText(reportEl.value);
      const s = document.getElementById('copy-status');
      s.textContent = 'copied';
      setTimeout(() => { s.textContent = ''; }, 2000);
    } catch (_) {
      reportEl.select();
      document.execCommand('copy');
    }
  });

  function buildReport(results) {
    const lines = [];
    lines.push('=== Token Monitor self-test report ===');
    lines.push('Generated: ' + new Date().toISOString());
    lines.push('UA: ' + navigator.userAgent);
    lines.push('');
    for (const r of results) {
      lines.push('--- [' + r.status.toUpperCase() + '] ' + r.name);
      lines.push(JSON.stringify(r.detail, null, 2));
      lines.push('');
    }
    lines.push('=== End ===');
    return lines.join('\n');
  }
})();
