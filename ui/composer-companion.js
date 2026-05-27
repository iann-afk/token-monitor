// ui/composer-companion.js — output-size pill and truncation banner.

const ComposerCompanion = (function () {

  let dispatcher = null;
  let pillRoot = null;
  let bannerRoot = null;
  let lastDraft = '';
  let bannerDismissedFor = '';
  let riskTimer = null;
  let stableSinceMs = 0;

  function mount(d) {
    dispatcher = d;
    // Listen on the body to capture composer keystrokes.
    document.addEventListener('input', _onInput, true);
  }

  function _onInput() {
    if (!dispatcher) return;
    const draft = (dispatcher.getActiveModel && typeof dispatcher.getConversation === 'function')
      ? (dispatcher._state.platform.readComposerDraft() || '')
      : '';
    if (draft === lastDraft) return;
    lastDraft = draft;
    render();
  }

  function render() {
    if (!dispatcher) return;
    const platform = dispatcher._state.platform;
    if (!platform) return;
    const anchor = platform.getComposerAnchor && platform.getComposerAnchor();
    if (!anchor) {
      _removePill(); _removeBanner();
      return;
    }
    const draft = platform.readComposerDraft ? (platform.readComposerDraft() || '') : '';
    const model = dispatcher.getActiveModel();

    // Output size pill — shown only when draft has content
    if (draft && draft.trim().length > 4) {
      const pred = dispatcher.predictOutputSize(draft, model);
      _renderPill(anchor, pred);
    } else {
      _removePill();
    }

    // Truncation banner with debounce + hysteresis
    const risk = dispatcher.assessTruncationRisk(draft);
    const draftKey = (draft || '').slice(0, 200);
    if (risk.willLikelyTruncate && bannerDismissedFor !== draftKey) {
      // Debounce — require 1.5s of stable risk
      if (!riskTimer) {
        stableSinceMs = Date.now();
        riskTimer = setTimeout(() => {
          if (Date.now() - stableSinceMs >= 1400) {
            _renderBanner(anchor, risk);
          }
          riskTimer = null;
        }, 1500);
      }
    } else {
      // Risk gone — remove immediately
      if (riskTimer) { clearTimeout(riskTimer); riskTimer = null; }
      _removeBanner();
    }
  }

  function _renderPill(anchor, pred) {
    if (!pillRoot) {
      pillRoot = document.createElement('div');
      pillRoot.className = 'tm-output-pill';
      pillRoot.dataset.tmWidget = 'pill';
    }
    const sizeKey = 'inpage.outputSize.' + pred.bucket.toLowerCase();
    const cls = pred.bucket === 'XL' || pred.bucket === 'L' ? 'tm-output-pill-warn' : 'tm-output-pill-ok';
    pillRoot.className = `tm-output-pill ${cls}`;
    pillRoot.innerHTML = `<span class="tm-pill-icon" aria-hidden="true">⤴</span><span>${_escape(I18N.t(sizeKey))}</span>`;
    // Build human-readable tooltip from signals
    // Bug 3 fix: keys must match the exact strings pushed by predictOutputSize().
    // Old map used dash-separated keys ('long-prompt', 'code-block', …) but
    // predictOutputSize emits space/mixed strings ('long prompt', 'code in prompt', …).
    const sigMap = {
      'long prompt':           'Long prompt',
      'long-output keywords':  'Keywords suggest long output',
      'artifact-style request':'Artifact-style request',
      'multi-part':            'Multiple questions',
      'code in prompt':        'Contains code',
      'extended thinking':     'Extended thinking active',
    };
    const sigText = pred.signals.map(s => sigMap[s] || s).join(', ');
    pillRoot.title = `Output prediction: ${sigText || 'default heuristic'}`;
    if (pillRoot.parentElement !== anchor) {
      anchor.appendChild(pillRoot);
    }
  }

  function _removePill() {
    if (pillRoot && pillRoot.parentElement) pillRoot.parentElement.removeChild(pillRoot);
    pillRoot = null;
  }

  function _renderBanner(anchor, risk) {
    if (!bannerRoot) {
      bannerRoot = document.createElement('div');
      bannerRoot.className = 'tm-truncate-banner';
      bannerRoot.dataset.tmWidget = 'truncate';
    }
    const n = risk.questionsExtracted ? risk.questionsExtracted.length : 0;
    const body = n > 1 ? I18N.t('inpage.truncate.body', { n }) : I18N.t('inpage.truncate.bodyGeneric');
    bannerRoot.innerHTML = `
      <div class="tm-truncate-icon" aria-hidden="true">⚠</div>
      <div class="tm-truncate-text">
        <div class="tm-truncate-title">${_escape(I18N.t('inpage.truncate.title'))}</div>
        <div class="tm-truncate-body">${_escape(body)}</div>
        <div class="tm-truncate-actions">
          ${n > 1 ? `<button class="tm-btn-primary" data-act="use-first">${_escape(I18N.t('inpage.truncate.useFirst'))}</button>` : ''}
          <button class="tm-btn-ghost" data-act="dismiss">${_escape(I18N.t('inpage.truncate.sendAnyway'))}</button>
        </div>
      </div>
      <button class="tm-truncate-close" data-act="dismiss" aria-label="dismiss">×</button>
    `;
    bannerRoot.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'use-first' && risk.questionsExtracted && risk.questionsExtracted.length) {
        dispatcher._state.platform.writeComposerDraft(risk.questionsExtracted[0]);
        _removeBanner();
      } else if (act === 'dismiss') {
        bannerDismissedFor = (lastDraft || '').slice(0, 200);
        _removeBanner();
      }
    };
    if (bannerRoot.parentElement !== anchor.parentElement) {
      // Insert above anchor
      anchor.parentElement.insertBefore(bannerRoot, anchor);
    }
  }

  function _removeBanner() {
    if (bannerRoot && bannerRoot.parentElement) bannerRoot.parentElement.removeChild(bannerRoot);
    bannerRoot = null;
  }

  function _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { mount, render };
})();
