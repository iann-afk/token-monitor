// ui/savings-card.js — proactive "your chat is getting full" nudge.
//
// This card ONLY decides when to nudge and renders a small prompt inside the
// overlay. The actual summarize→handoff flow lives in HandoffModal, opened on
// click. Keeping the trigger here and the heavy interaction in a focused modal
// is what makes the experience beginner-friendly: the card stays a glanceable
// hint, the modal gives each step room to breathe.

const SavingsCard = (function () {

  let _dispatcher = null;
  let _dismissedConvId = null;   // dismissed → don't nudge again this conversation

  function mount(dispatcher) { _dispatcher = dispatcher; }

  function shouldShow(conv, ctxPct) {
    if (!conv || !_dispatcher) return false;
    const convId = conv.conversationId;
    if (convId && convId === _dismissedConvId) return false;

    const historyTokens = _estimateHistory(conv);
    const historyRatio  = conv.contextTokens > 0 ? historyTokens / conv.contextTokens : 0;
    const turns         = conv.messages ? conv.messages.length : 0;
    const hasSubstantialContext = (conv.contextTokens || 0) > 8000;

    return (
      (ctxPct >= 50 && historyRatio >= 0.55) ||
      (ctxPct >= 70) ||
      (turns >= 12 && hasSubstantialContext && historyRatio >= 0.4)
    );
  }

  function renderCard(conv, ctxPct) {
    const isCN = (typeof I18N !== 'undefined') && I18N.detect() === 'zh-CN';
    const ctxK = Math.round((conv.contextTokens || 0) / 1000);

    // Beginner-friendly: lead with the plain-language consequence, not a
    // "% savings" stat. The detail lives in the modal.
    return `
      <div class="tm-savings-card" data-savings-convid="${_escAttr(conv.conversationId || '')}">
        <div class="tm-savings-icon">💡</div>
        <div class="tm-savings-content">
          <div class="tm-savings-title">
            ${isCN ? '这个对话越来越长了' : 'This chat is getting long'}
          </div>
          <div class="tm-savings-sub">
            ${isCN
              ? `已用约 ${ctxK}k 上下文。越长越慢、越费用量——可以一键总结后换个新对话继续。`
              : `~${ctxK}k context used. Longer chats get slower & costlier — summarize and continue in a fresh one.`}
          </div>
          <div class="tm-savings-actions">
            <button class="tm-btn-savings-primary" data-act-savings="handoff">
              ${isCN ? '总结并接力 →' : 'Summarize & continue →'}
            </button>
            <button class="tm-btn-savings-ghost" data-act-savings="dismiss">
              ${isCN ? '暂不' : 'Not now'}
            </button>
          </div>
        </div>
        <button class="tm-savings-close" data-act-savings="dismiss" aria-label="close">×</button>
      </div>`;
  }

  // Called by overlay's event delegation.
  function handleAction(act, conv) {
    if (act === 'dismiss') {
      _dismissedConvId = conv ? conv.conversationId : null;
      return 'dismissed';
    }
    if (act === 'handoff') {
      if (typeof HandoffModal !== 'undefined') HandoffModal.open(conv);
      return 'opened';
    }
    return null;
  }

  function _estimateHistory(conv) {
    if (!conv) return 0;
    const other = (conv.attachmentTokens || 0) + (conv.toolsOverhead || 0)
                + (conv.projectKnowledgeTokens || 0) + 600; // sysPrompt estimate
    return Math.max(0, (conv.contextTokens || 0) - other);
  }

  function _escAttr(s) { return String(s).replace(/"/g, '&quot;'); }

  // Kept for overlay's render-hash compatibility; modal owns "done" state now.
  function isDone() { return false; }

  return { mount, shouldShow, renderCard, handleAction, isDone };

})();
