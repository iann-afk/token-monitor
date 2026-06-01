// background.js — MV3 service worker.

importScripts('utils/remote-config.js');

const SCHEMA_VERSION = 1;
const REFRESH_INTERVAL_MIN = 2;
const QUOTA_TTL_MS = 60 * 1000; // serve cached up to 60s

// ── Install / boot ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  // Migrations
  const { 'schema:version': v = 0 } = await chrome.storage.local.get('schema:version');
  if (v < SCHEMA_VERSION) await chrome.storage.local.set({ 'schema:version': SCHEMA_VERSION });

  // First-run onboarding: only on a genuine fresh install (not on update/reload),
  // and only if we haven't already onboarded this profile.
  if (details && details.reason === 'install') {
    const { 'ui:onboarded': done } = await chrome.storage.local.get('ui:onboarded');
    if (!done) await chrome.storage.local.set({ 'ui:onboarded': false });
  }

  // Default settings
  const { recallSettings } = await chrome.storage.sync.get('recallSettings');
  if (!recallSettings) {
    await chrome.storage.sync.set({
      recallSettings: {
        contextWarn: 70, contextCritical: 90,
        fiveHourWarn: 75, fiveHourCritical: 90,
        weeklyWarn: 80, weeklyCritical: 95,
        alarmEnabled: true,
        soundType: 'soft',
        volume: 0.5,
        language: 'auto',
        notifyOnRefill: true,
      }
    });
  }

  chrome.alarms.create('refresh-quota', { periodInMinutes: REFRESH_INTERVAL_MIN });
  chrome.alarms.create('refresh-status', { periodInMinutes: 5 }); // Bug 3 fix
  chrome.alarms.create('refresh-config', { periodInMinutes: 360 });
  RemoteConfig.fetchAndCache();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('refresh-quota', { periodInMinutes: REFRESH_INTERVAL_MIN });
  chrome.alarms.create('refresh-status', { periodInMinutes: 5 }); // Bug 3 fix
  chrome.alarms.create('refresh-config', { periodInMinutes: 360 });
});

// ── Cross-tab message bus ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'PING') {
        sendResponse({ ok: true, at: Date.now(), version: chrome.runtime.getManifest().version });
      } else if (msg.type === 'GET_QUOTA') {
        const snap = await getQuotaCached(msg.platformId);
        sendResponse({ snapshot: snap });
      } else if (msg.type === 'REFRESH_QUOTA') {
        const snap = await refreshQuota(msg.platformId, true);
        sendResponse({ snapshot: snap });
      } else if (msg.type === 'GET_PLAN') {
        const plan = await getPlanCached(msg.platformId);
        sendResponse({ plan });
      } else if (msg.type === 'DIAGNOSE') {
        // Read the last persisted diagnosis without triggering a new fetch.
        // Triggering a fetch here can race with the popup's message channel
        // closing in MV3. The user can press Recheck quota first if they
        // want fresh data.
        const diagKey = `diag:${msg.platformId}`;
        const quotaKey = `quota:${msg.platformId}`;
        const planKey = `plan:${msg.platformId}`;
        const data = await chrome.storage.local.get([diagKey, quotaKey, planKey]);
        sendResponse({
          snapshot: data[quotaKey] || null,
          plan: data[planKey] || null,
          diag: data[diagKey] || null,
        });
      } else if (msg.type === 'BROADCAST') {
        await broadcastToTabs(msg.payload, sender.tab?.id);
        sendResponse({ ok: true });
      } else {
        sendResponse({ error: 'unknown-type' });
      }
    } catch (e) {
      console.error('[tm:bg] error', e);
      sendResponse({ error: String(e) });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refresh-quota') {
    refreshAllPlatforms();
  } else if (alarm.name === 'refresh-config') {
    if (await RemoteConfig.isStale()) RemoteConfig.fetchAndCache();
  }
});

// ── Quota fetching ─────────────────────────────────────────────────────────

async function getQuotaCached(platformId) {
  const key = `quota:${platformId}`;
  const data = await chrome.storage.local.get(key);
  const cached = data[key];
  if (cached && Date.now() - cached.fetchedAtMs < QUOTA_TTL_MS) {
    // Bug 2 fix: preserve 'unavailable' from a failed fetch so the overlay
    // doesn't show fake 0% bars as real data for up to 60 s after a failure.
    // Only promote to 'fresh' when the cached snapshot itself succeeded.
    const src = cached.source === 'unavailable' ? 'unavailable' : 'fresh';
    return { ...cached, source: src };
  }
  if (cached) {
    // Fire refresh in background, return stale
    refreshQuota(platformId, false);
    return { ...cached, source: 'stale' };
  }
  // No cache — try fresh fetch
  return await refreshQuota(platformId, true);
}

async function getPlanCached(platformId) {
  const key = `plan:${platformId}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || { tier: 'unknown', displayName: 'Unknown', fiveHourBudget: null, weeklyBudget: null };
}

async function refreshAllPlatforms() {
  // Find any open tab that matches a supported platform
  const tabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
  if (!tabs.length) return; // nobody using it, skip
  await refreshQuota('claude', false);
}

async function refreshQuota(platformId, force) {
  if (platformId !== 'claude') {
    return { fiveHourPercent: 0, weeklyPercent: 0, fiveHourReleaseAtMs: null, weeklyResetAtMs: null, fetchedAtMs: Date.now(), source: 'unavailable', _diag: { reason: 'unsupported-platform' } };
  }

  const tabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
  if (!tabs.length) {
    return { fiveHourPercent: 0, weeklyPercent: 0, fiveHourReleaseAtMs: null, weeklyResetAtMs: null, fetchedAtMs: Date.now(), source: 'unavailable', _diag: { reason: 'no-claude-tab' } };
  }

  // Strategy 1: Fetch directly from the SW. host_permissions covers claude.ai
  // and credentials: 'include' carries cookies automatically.
  let snapshot = await fetchQuotaFromSW();

  // Strategy 2: If SW fetch totally failed, fall back to executeScript
  // in the tab context (different origin behavior).
  if (!snapshot || snapshot._diag?.reason === 'sw-fetch-failed') {
    const tab = tabs[0];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrapeClaudeUsageInTab,
      });
      const tabResult = results && results[0] && results[0].result;
      if (tabResult && (tabResult.fiveHourPercent > 0 || tabResult.weeklyPercent > 0 || tabResult._plan)) {
        snapshot = tabResult;
      } else if (tabResult) {
        snapshot = { ...snapshot, _diag: { ...(snapshot?._diag || {}), tabFallback: tabResult._diag || 'tab-fetch-empty' } };
      }
    } catch (e) {
      console.warn('[tm:bg] executeScript failed', e);
      snapshot = { ...(snapshot || {}), _diag: { ...(snapshot?._diag || {}), executeScriptError: String(e) } };
    }
  }

  if (!snapshot) {
    snapshot = { fiveHourPercent: 0, weeklyPercent: 0, fiveHourReleaseAtMs: null, weeklyResetAtMs: null, source: 'unavailable', _diag: { reason: 'all-strategies-failed' } };
  }
  snapshot.fetchedAtMs = Date.now();
  if (!snapshot.source) {
    snapshot.source = (snapshot.fiveHourPercent > 0 || snapshot.weeklyPercent > 0 || snapshot._plan) ? 'fresh' : 'unavailable';
  }

  // Strategy 3 — Plan verification via DOM probe.
  // API fields (rate_limit_upsell, billing_type) are unreliable for Free vs
  // Pro distinction. The Claude.ai sidebar/footer always shows the plan name
  // on Free accounts ("Free plan" / "Upgrade") — read it directly.
  try {
    const tab = tabs[0];
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: probePlanFromDom,
    });
    const domPlan = results && results[0] && results[0].result;
    if (domPlan) {
      snapshot._diag = snapshot._diag || {};
      snapshot._diag.domPlanProbe = domPlan;

      if (domPlan.detectedTier) {
        // DOM signal beats API inference. If SW thought "Pro" but DOM clearly
        // says "Free", override. Same for inverse.
        if (domPlan.detectedTier === 'free' && snapshot._plan?.tier !== 'free') {
          console.log('[tm:bg] DOM override: SW guessed', snapshot._plan?.tier, 'but DOM says free');
          snapshot._plan = { tier: 'free', displayName: 'Free', fiveHourBudget: null, weeklyBudget: null };
        } else if (domPlan.detectedTier === 'pro' && snapshot._plan?.tier === 'free') {
          snapshot._plan = { tier: 'pro', displayName: 'Pro', fiveHourBudget: null, weeklyBudget: null };
        } else if (!snapshot._plan) {
          const map = {
            free: 'Free', pro: 'Pro',
            'max-5x': 'Max 5x', 'max-20x': 'Max 20x',
            team: 'Team', enterprise: 'Enterprise',
          };
          snapshot._plan = {
            tier: domPlan.detectedTier,
            displayName: map[domPlan.detectedTier] || 'Unknown',
            fiveHourBudget: null, weeklyBudget: null,
          };
        }
      }
      // If detectedTier is null, leave SW's API inference alone (it's better
      // than nothing — at least billingType="apple_subscription"/"stripe"
      // strongly implies paid).
    }
  } catch (e) {
    console.warn('[tm:bg] DOM plan probe failed', e);
  }

  // Detect refill (limit cleared)
  const prevKey = `quota:${platformId}`;
  const prev = (await chrome.storage.local.get(prevKey))[prevKey];
  const wasAtLimit = prev && (prev.fiveHourPercent >= 99 || prev.weeklyPercent >= 99);
  const nowOk = snapshot.fiveHourPercent < 95 && snapshot.weeklyPercent < 95;
  if (wasAtLimit && nowOk) notifyLimitRefilled();

  await chrome.storage.local.set({ [prevKey]: snapshot });

  if (snapshot._plan) {
    await chrome.storage.local.set({ [`plan:${platformId}`]: snapshot._plan });
  }

  // Persist last diagnosis for the popup's Diagnose button
  await chrome.storage.local.set({ [`diag:${platformId}`]: { at: Date.now(), snapshot } });


  // ── (removed) Daily history log ─────────────────────────────────────────
  // The 90-day usage-history chart + CSV export were removed: they accumulated
  // the fragile quota figures (unavailable on Free accounts) and the feature
  // didn't change any user decision. We no longer write `history:*` keys here.
  // One-time cleanup of any history data left over from older versions:
  try {
    const allKeys = Object.keys(await chrome.storage.local.get(null));
    const oldHistKeys = allKeys.filter(k => k.startsWith('history:'));
    if (oldHistKeys.length) await chrome.storage.local.remove(oldHistKeys);
  } catch (_) {}

  await broadcastQuota(platformId, snapshot);
  updateBadge(snapshot);
  console.log('[tm:bg] refresh complete', { source: snapshot.source, fh: snapshot.fiveHourPercent, wk: snapshot.weeklyPercent, plan: snapshot._plan?.displayName, diag: snapshot._diag });
  return snapshot;
}

// Fetch directly from the service worker (preferred path).
async function fetchQuotaFromSW() {
  const log = (...args) => console.log('[tm:bg:fetch]', ...args);
  const diag = { tried: [], errors: {} };

  // Try common Claude API endpoints. Discover org first if possible.
  let orgId = null;
  try {
    const r = await fetch('https://claude.ai/api/organizations', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    diag.tried.push({ path: '/api/organizations', status: r.status });
    if (r.ok) {
      const orgs = await r.json();
      if (Array.isArray(orgs) && orgs.length) {
        const active = orgs.find((o) => !o.archived_at) || orgs[0];
        orgId = active && (active.uuid || active.id);
        log('orgId', orgId);
      }
    }
  } catch (e) {
    diag.errors.orgFetch = String(e);
    log('orgs fetch error', e);
  }

  let usageJson = null;
  let hitPath = null;
  const candidates = [];
  if (orgId) {
    candidates.push(`https://claude.ai/api/organizations/${orgId}/usage`);
    candidates.push(`https://claude.ai/api/organizations/${orgId}/usage_stats`);
    candidates.push(`https://claude.ai/api/organizations/${orgId}/rate_limit`);
    candidates.push(`https://claude.ai/api/organizations/${orgId}/account/usage`);
    candidates.push(`https://claude.ai/api/bootstrap/${orgId}`);
  }
  candidates.push('https://claude.ai/api/account');
  candidates.push('https://claude.ai/api/bootstrap');
  candidates.push('https://claude.ai/api/usage');

  for (const url of candidates) {
    const path = url.replace('https://claude.ai', '');
    try {
      const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      diag.tried.push({ path, status: r.status });
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) continue;
      const data = await r.json();
      log('candidate', path, 'keys:', JSON.stringify(Object.keys(data || {})).slice(0, 200));
      // Prefer responses that look like Anthropic's usage shape directly
      if (data && (data.five_hour || data.seven_day || data.usage || data.rate_limit || data.rate_limits)) {
        usageJson = data;
        hitPath = path;
        log('matched', path);
        break;
      }
      // Otherwise, accept any plan/subscription info as secondary
      if (data && (data.plan || data.subscription || data.tier)) {
        if (!usageJson) {
          usageJson = data;
          hitPath = path;
        }
      }
    } catch (e) {
      diag.errors[path] = String(e);
    }
  }

  // Strategy: HTML scrape /settings/usage
  let htmlPct = { fh: 0, wk: 0 };
  let htmlPlan = null;
  let htmlSample = null;
  try {
    const r = await fetch('https://claude.ai/settings/usage', { credentials: 'include' });
    diag.tried.push({ path: '/settings/usage', status: r.status });
    if (r.ok) {
      const html = await r.text();
      const parsed = parseUsageHtml(html);
      htmlPct = parsed.percents;
      htmlPlan = parsed.plan;
      diag.htmlBars = parsed.barCount;
      diag.htmlAriaValues = parsed.allValues;
      // Look for any percentage-like text near "5-hour" / "weekly" keywords
      const fhCtx = html.match(/.{0,80}(5.hour|five.hour|window).{0,80}/i);
      const wkCtx = html.match(/.{0,80}(weekly|week).{0,80}/i);
      diag.htmlFhContext = fhCtx ? fhCtx[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200) : null;
      diag.htmlWkContext = wkCtx ? wkCtx[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200) : null;
      log('html scrape', parsed);
    }
  } catch (e) {
    diag.errors.html = String(e);
    log('html error', e);
  }

  // Always also try to fetch plan info — usage endpoint doesn't include it.
  if (!usageJson?.plan && !usageJson?.subscription) {
    try {
      const r = await fetch('https://claude.ai/api/organizations', {
        credentials: 'include', headers: { Accept: 'application/json' },
      });
      if (r.ok) {
        const orgs = await r.json();
        if (Array.isArray(orgs) && orgs.length) {
          const active = orgs.find((o) => !o.archived_at) || orgs[0];
          // Capture raw to see actual fields
          diag.orgKeys = Object.keys(active || {});
          diag.orgSample = JSON.stringify(active).slice(0, 800);
          // Actual Anthropic org fields (observed 2026-05):
          //   rate_limit_tier: "free" | "claude_pro" | "claude_max_5" | "claude_max_20" | ...
          const rlt = active.rate_limit_tier || active.tier || active.billing_tier;
          const candidatePlan = active.plan || active.subscription || active.account_plan;
          // rate_limit_upsell is non-null when Anthropic wants to upsell → Free account
          const hasUpsell = active.rate_limit_upsell != null && active.rate_limit_upsell !== false;
          // billing_type values observed:
          //   'none' or null   → Free
          //   'stripe'          → paid (web)
          //   'apple_subscription' → paid (iOS in-app)
          //   'google_play'     → paid (Android in-app)
          // Any non-null, non-'none' value indicates a paying user.
          const billingType = active.billing_type;
          const isPaid = billingType && billingType !== 'none';
          // Final isFree: paid signal overrides everything; otherwise fall
          // back to upsell signal.
          const isFree = !isPaid && (hasUpsell || !billingType || billingType === 'none');
          let planObj = null;
          if (rlt) {
            const rltStr = String(rlt).toLowerCase();
            const tierMap = {
              'free': { tier: 'free', display: 'Free' },
              'claude_free': { tier: 'free', display: 'Free' },
              'default': { tier: 'free', display: 'Free' },
              // default_claude_ai is used for both Free and Pro — use upsell/billing signal
              'default_claude_ai': isFree ? { tier: 'free', display: 'Free' } : { tier: 'pro', display: 'Pro' },
              'claude_pro': { tier: 'pro', display: 'Pro' },
              'pro': { tier: 'pro', display: 'Pro' },
              'claude_max_5': { tier: 'max-5x', display: 'Max 5x' },
              'claude_max_5x': { tier: 'max-5x', display: 'Max 5x' },
              'max_5': { tier: 'max-5x', display: 'Max 5x' },
              'claude_max_20': { tier: 'max-20x', display: 'Max 20x' },
              'claude_max_20x': { tier: 'max-20x', display: 'Max 20x' },
              'max_20': { tier: 'max-20x', display: 'Max 20x' },
              'team': { tier: 'team', display: 'Team' },
              'enterprise': { tier: 'enterprise', display: 'Enterprise' },
            };
            const mapped = tierMap[rltStr];
            if (mapped) {
              planObj = { tier: mapped.tier, displayName: mapped.display, fiveHourBudget: null, weeklyBudget: null };
            } else {
              planObj = { tier: rltStr.replace(/^claude_/, ''), displayName: String(rlt).replace(/_/g, ' '), fiveHourBudget: null, weeklyBudget: null };
            }
            diag.rateLimitTier = rltStr;
            diag.isFreeDetected = isFree;
            diag.hasUpsell = hasUpsell;
            diag.billingType = billingType;
            diag.freeCreditsStatus = active.free_credits_status;
          } else if (candidatePlan) {
            const tier = (candidatePlan.tier || candidatePlan.name || candidatePlan.id || candidatePlan).toString().toLowerCase().replace(/\s+/g, '-');
            const displayName = candidatePlan.display_name || candidatePlan.name || (typeof candidatePlan === 'string' ? candidatePlan : 'Unknown');
            planObj = { tier, displayName, fiveHourBudget: null, weeklyBudget: null };
          }
          if (planObj) {
            usageJson = usageJson || {};
            usageJson.plan = planObj;
          }
        }
      }
    } catch (e) { diag.errors.planFetch = String(e); }
  }


  // Combine plan from various sources (priority: explicit usage plan, then derived above, then HTML)
  let plan = null;
  if (usageJson) {
    if (usageJson.plan) {
      plan = usageJson.plan;
    } else {
      const p = usageJson.account?.plan || usageJson.organization?.plan || usageJson.subscription;
      if (p) {
        plan = {
          tier: String(p.tier || p.name || p.id || 'unknown').toLowerCase().replace(/\s+/g, '-'),
          displayName: p.display_name || p.name || 'Unknown',
          fiveHourBudget: null, weeklyBudget: null,
        };
      }
    }
  }
  if (!plan && htmlPlan) plan = htmlPlan;

  let fhPct = 0, wkPct = 0, fhReset = null, wkReset = null;
  if (usageJson) {
    // Anthropic's actual shape (observed 2026-05): top-level five_hour and
    // seven_day, each with { utilization, resets_at }.
    // There are also seven_day_opus / seven_day_sonnet for per-model quotas
    // on Max plans (null for Pro), and seven_day_oauth_apps, seven_day_cowork
    // etc. for adjacent products.
    const fh = usageJson.five_hour || usageJson.usage?.five_hour;
    if (fh) {
      // utilization is 0-100 (API returns integer percent, e.g. 45 = 45%)
      fhPct = Number(fh.utilization ?? fh.percent ?? 0);
      fhReset = fh.resets_at ? new Date(fh.resets_at).getTime() : null;
    }
    const wk = usageJson.seven_day || usageJson.weekly || usageJson.usage?.seven_day || usageJson.usage?.weekly;
    if (wk) {
      wkPct = Number(wk.utilization ?? wk.percent ?? 0);
      wkReset = wk.resets_at ? new Date(wk.resets_at).getTime() : null;
    }
    // Capture per-model quota as side info (used later for Q5 model awareness)
    const opus = usageJson.seven_day_opus;
    const sonnet = usageJson.seven_day_sonnet;
    if (opus || sonnet) {
      diag.modelQuota = {
        opus: opus ? { utilization: opus.utilization, resets_at: opus.resets_at } : null,
        sonnet: sonnet ? { utilization: sonnet.utilization, resets_at: sonnet.resets_at } : null,
      };
    }
    // Fallback to legacy shapes if newer ones are missing
    if (!fhPct) {
      const u = usageJson.usage || usageJson.rate_limit || usageJson.rate_limits || {};
      if (u.five_hour_percent) fhPct = Number(u.five_hour_percent);
      else if (u.window_percent) fhPct = Number(u.window_percent);
      if (u.message_count != null && u.message_limit) {
        fhPct = Math.min(100, (u.message_count / u.message_limit) * 100);
      }
    }
    if (!wkPct) {
      const u = usageJson.usage || usageJson.rate_limit || usageJson.rate_limits || {};
      if (u.weekly_percent) wkPct = Number(u.weekly_percent);
    }
  }
  if (!fhPct && htmlPct.fh) fhPct = htmlPct.fh;
  if (!wkPct && htmlPct.wk) wkPct = htmlPct.wk;

  diag.hitPath = hitPath;
  diag.usageKeys = usageJson ? Object.keys(usageJson) : null;
  diag.rawSample = usageJson ? JSON.stringify(usageJson).slice(0, 1500) : null;
  diag.fhFromApi = !!(hitPath && !diag.errors?.usageFetch);  // true = API returned data (even if utilization=0)
  diag.fhFromHtml = !!htmlPct.fh;

  if (fhPct > 0 || wkPct > 0 || plan) {
    return {
      fiveHourPercent: fhPct,
      weeklyPercent: wkPct,
      fiveHourReleaseAtMs: fhReset,
      weeklyResetAtMs: wkReset,
      _plan: plan,
      _diag: diag,
    };
  }

  diag.reason = 'sw-fetch-failed';
  return { fiveHourPercent: 0, weeklyPercent: 0, fiveHourReleaseAtMs: null, weeklyResetAtMs: null, _plan: plan, _diag: diag };
}

// Parse the HTML of /settings/usage (callable from SW context, no DOMParser
// access there — use string-level parsing).
function parseUsageHtml(html) {
  const result = { percents: { fh: 0, wk: 0 }, plan: null, barCount: 0, allValues: [] };

  const valueRe = /aria-valuenow="(\d+(?:\.\d+)?)"/g;
  const values = [];
  let m;
  while ((m = valueRe.exec(html)) !== null) {
    values.push(Number(m[1]));
  }
  result.barCount = values.length;
  result.allValues = values.slice(0, 10);

  const valid = values.filter((v) => v >= 0 && v <= 100);
  if (valid.length >= 1) result.percents.fh = valid[0];
  if (valid.length >= 2) result.percents.wk = valid[1];

  const planMatch = html.match(/\b(Free|Pro|Max\s*5x|Max\s*20x|Team|Enterprise)\b/);
  if (planMatch) {
    result.plan = {
      tier: planMatch[1].toLowerCase().replace(/\s+/g, '-'),
      displayName: planMatch[1],
      fiveHourBudget: null, weeklyBudget: null,
    };
  }
  return result;
}

// Fallback function injected INTO the tab context if SW fetch totally fails.
// Injected into the tab — read the plan directly from page DOM.
// More reliable than API for distinguishing Free vs Pro.
function probePlanFromDom() {
  const out = { detectedTier: null, signals: {} };
  try {
    // Strategy A: target the account/plan footer specifically — usually
    // the bottom of the sidebar with "Free plan / Upgrade" or
    // "Pro plan" or "Max plan" etc. This is far more reliable than
    // scanning whole sidebar (which contains chat titles).
    //
    // Common patterns:
    //   - <button>...</button>  account dropdown trigger
    //   - <a href="/upgrade">Upgrade</a> for free users
    //   - Plan name appears near user avatar/email
    const footerCandidates = [
      // Sidebar footer / account section
      'aside [class*="footer"]',
      'aside [class*="account"]',
      'nav [class*="footer"]',
      'nav [class*="account"]',
      // Settings pages
      '[class*="plan-card"]',
      '[class*="subscription"]',
      // The account/avatar button at sidebar bottom
      'button[aria-label*="account" i]',
      '[data-testid*="user-menu"]',
    ];

    let footerText = '';
    let matchedSource = null;
    for (const sel of footerCandidates) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const t = (el.innerText || '').trim();
          if (t) {
            footerText += '\n' + t;
            if (!matchedSource) matchedSource = sel;
          }
        }
      } catch (_) {}
    }
    out.signals.footerSources = matchedSource;
    out.signals.footerTextSample = footerText.slice(0, 500);

    // Strict patterns: match plan name with explicit "plan" / "tier" word
    // boundary, OR with surrounding currency/upgrade context.
    const tests = [
      // English: "Free plan" / "Pro plan" / "Max plan" / "Team plan"
      { tier: 'free', re: /\bFree\s+plan\b/i },
      { tier: 'max-20x', re: /\bMax\s*20x?\b/i },
      { tier: 'max-5x', re: /\bMax\s*5x?\b/i },
      { tier: 'pro', re: /\bPro\s+plan\b/i },
      { tier: 'team', re: /\bTeam\s+plan\b/i },
      { tier: 'enterprise', re: /\bEnterprise\s+plan\b/i },
      // Chinese
      { tier: 'free', re: /免费(版|账户|计划)/ },
      { tier: 'pro', re: /专业(版|账户|计划)/ },
    ];
    for (const t of tests) {
      const m = footerText.match(t.re);
      if (m) {
        out.detectedTier = t.tier;
        out.signals.matchedSnippet = m[0];
        break;
      }
    }

    // Strategy B (fallback): if no plan name found in footer, look for
    // an Upgrade CTA. Free accounts always have it; paid accounts don't.
    if (!out.detectedTier) {
      const upgrade = document.querySelector('a[href*="/upgrade"], a[href*="/pricing"], button[aria-label*="Upgrade" i]');
      out.signals.hasUpgradeCta = !!upgrade;
      if (upgrade) {
        out.detectedTier = 'free';
        out.signals.matchedSnippet = 'upgrade-cta:' + (upgrade.tagName || '');
      }
    }
  } catch (e) {
    out.error = String(e);
  }
  return out;
}


function scrapeClaudeUsageInTab() {
  return new Promise(async (resolve) => {
    const diag = { tried: [], errors: {} };
    try {
      const r = await fetch('/settings/usage', { credentials: 'include' });
      diag.tried.push({ path: '/settings/usage', status: r.status });
      if (!r.ok) { resolve({ _diag: { ...diag, reason: 'tab-html-status' } }); return; }
      const html = await r.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const bars = doc.querySelectorAll('[role="progressbar"], [aria-valuenow]');
      let fhPct = 0, wkPct = 0;
      for (const bar of bars) {
        const v = Number(bar.getAttribute('aria-valuenow'));
        if (!isFinite(v)) continue;
        const ctx = (bar.parentElement?.textContent || '').toLowerCase();
        if (/5.hour|hour|window/.test(ctx)) fhPct = Math.max(fhPct, v);
        else if (/week/.test(ctx)) wkPct = Math.max(wkPct, v);
      }
      const planText = (doc.body.textContent || '').match(/\b(Free|Pro|Max\s*5x|Max\s*20x|Team|Enterprise)\b/i);
      diag.barCount = bars.length;
      resolve({
        fiveHourPercent: fhPct,
        weeklyPercent: wkPct,
        fiveHourReleaseAtMs: null,
        weeklyResetAtMs: null,
        _plan: planText ? { tier: planText[1].toLowerCase().replace(/\s+/g, '-'), displayName: planText[1], fiveHourBudget: null, weeklyBudget: null } : null,
        _diag: diag,
      });
    } catch (e) {
      resolve({ _diag: { ...diag, reason: 'tab-fetch-error', error: String(e) } });
    }
  });
}

// ── Broadcast to all tabs of a platform ────────────────────────────────────

async function broadcastQuota(platformId, snapshot) {
  const tabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
  for (const tab of tabs) {
    try {
      // Use callback form so we can swallow "Receiving end does not exist"
      chrome.tabs.sendMessage(tab.id, { type: 'QUOTA_UPDATED', platformId, snapshot }, () => {
        // Reading lastError marks it as handled
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }
  // Notify popup if open — same dance
  try {
    chrome.runtime.sendMessage({ type: 'QUOTA_UPDATED', platformId, snapshot }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {}
}

async function broadcastToTabs(payload, exceptTabId) {
  const tabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
  for (const tab of tabs) {
    if (tab.id === exceptTabId) continue;
    try {
      chrome.tabs.sendMessage(tab.id, payload, () => { void chrome.runtime.lastError; });
    } catch (_) {}
  }
}

// ── Badge ──────────────────────────────────────────────────────────────────

function updateBadge(snapshot) {
  if (!snapshot || snapshot.source === 'unavailable') {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const max = Math.max(snapshot.fiveHourPercent || 0, snapshot.weeklyPercent || 0);
  const text = max > 0 ? Math.round(max) + '%' : '';
  let color = '#22c55e';
  if (max > 90) color = '#ef4444';
  else if (max > 70) color = '#f59e0b';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ── Notifications ──────────────────────────────────────────────────────────

async function notifyLimitRefilled() {
  const { recallSettings } = await chrome.storage.sync.get('recallSettings');
  if (recallSettings && recallSettings.notifyOnRefill === false) return;

  // 1. Chrome system notification (requires permission grant)
  try {
    chrome.notifications.create('tm-refill-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Claude is back ✓',
      message: 'Your usage window has refilled. Ready to chat.',
      priority: 2,
    });
  } catch (_) {}

  // 2. Broadcast to all claude.ai tabs → overlay toast + tab title flash
  try {
    const tabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'TM_REFILL_NOTIFY' }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch (_) {}
}

// ── Anthropic Service Status (v2.1) ────────────────────────────────────────

const STATUS_URL = 'https://status.anthropic.com/api/v2/summary.json';
const STATUS_TTL_MS = 5 * 60 * 1000; // 5 min cache

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refresh-status') {
    refreshAnthropicStatus();
  }
});

async function refreshAnthropicStatus() {
  try {
    const resp = await fetch(STATUS_URL, { cache: 'no-store' });
    if (!resp.ok) return;
    const data = await resp.json();

    // Determine worst status level across all components
    const components = data.components || [];
    const statuses = components.map(c => c.status);
    let level = 'none';
    if (statuses.some(s => s === 'major_outage'))      level = 'major';
    else if (statuses.some(s => s === 'partial_outage')) level = 'partial';
    else if (statuses.some(s => s === 'degraded_performance')) level = 'degraded';

    const snapshot = { level, updatedAt: Date.now(), indicator: data.status?.indicator || 'none' };
    await chrome.storage.local.set({ 'status:anthropic': snapshot });

    // Broadcast to all claude.ai tabs so they can update sessionStorage
    const tabs = await chrome.tabs.query({ url: ['*://claude.ai/*', '*://*.claude.ai/*'] });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'TM_STATUS_UPDATE', status: snapshot })
        .catch(() => {});
    }
  } catch (e) {
    // Network failure — silently ignore, don't show error to user
  }
}

// Run once on install/startup
refreshAnthropicStatus();
