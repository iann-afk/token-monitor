// ui/handoff-modal.js — guided, beginner-friendly "summary handoff" flow.
//
// Replaces the cramped in-overlay savings card interaction with a focused,
// three-step modal. Design goals (per product direction):
//   1. CONSERVATIVE handoff — we copy the summary and give crystal-clear next
//      steps, but we do NOT auto-open / auto-jump to a new chat. The user
//      stays in control of starting the new conversation.
//   2. PROMPT IS VISIBLE & EDITABLE — before we send anything on the user's
//      behalf, they see the exact prompt, can edit it, or cancel.
//   3. ALWAYS SAY WHAT'S HAPPENING — every step explains itself in plain
//      language; the waiting state shows progress, never a frozen screen.
//
// The modal is fully self-contained (own DOM root, own styles via overlay.css
// classes prefixed tm-ho-). SavingsCard only triggers open(); all the actual
// summarize work lives here.

const HandoffModal = (function () {

  let _dispatcher = null;
  let _root = null;
  let _conv = null;
  let _summaryText = null;
  let _polling = false;

  function mount(dispatcher) { _dispatcher = dispatcher; }

  function _isZh() {
    try { return typeof I18N !== 'undefined' && I18N.detect && I18N.detect() === 'zh-CN'; }
    catch (_) { return false; }
  }

  function _defaultPrompt() {
    return _isZh()
      ? '请用 4-6 句话总结我们这个对话：关键背景、已达成的结论、以及下一步待办，让我能在新对话里直接接着继续。'
      : 'Summarize this conversation in 4-6 sentences: key context, conclusions reached, and next steps — so I can paste it into a fresh chat and continue seamlessly.';
  }

  // ── Public entry ────────────────────────────────────────────────────────
  function open(conv) {
    _conv = conv;
    _summaryText = null;
    _ensureRoot();
    _renderStep1Confirm();
    _show();
  }

  function close() {
    _polling = false;
    if (_root) { _root.classList.remove('tm-ho-open'); }
    setTimeout(() => { if (_root && _root.parentElement) _root.parentElement.removeChild(_root); _root = null; }, 160);
  }

  function _ensureRoot() {
    if (_root) return;
    _root = document.createElement('div');
    _root.className = 'tm-ho-backdrop';
    _root.dataset.tmWidget = 'handoff-modal';
    // Click outside the card closes (only when not mid-generation).
    _root.addEventListener('click', (e) => {
      if (e.target === _root && !_polling) close();
    });
    document.body.appendChild(_root);
  }

  function _show() {
    // next frame → trigger CSS transition
    requestAnimationFrame(() => { if (_root) _root.classList.add('tm-ho-open'); });
  }

  // ── Step 1: show & edit the prompt, then confirm ──────────────────────────
  function _renderStep1Confirm() {
    const zh = _isZh();
    const ctxK = Math.round((_conv?.contextTokens || 0) / 1000);
    _root.innerHTML = `
      <div class="tm-ho-card" role="dialog" aria-modal="true">
        <div class="tm-ho-head">
          <div class="tm-ho-step-dots"><span class="on"></span><span></span><span></span></div>
          <button class="tm-ho-x" data-ho="cancel" aria-label="${zh ? '关闭' : 'Close'}">×</button>
        </div>
        <div class="tm-ho-title">${zh ? '把这个对话接力到新对话' : 'Carry this chat into a fresh one'}</div>
        <div class="tm-ho-why">
          ${zh
            ? `这个对话的上下文已经到约 ${ctxK}k tokens。对话越长，每次回复越慢、越耗用量。下面这条提示会让 Claude 先帮你总结，你就能在新对话里接着聊、又轻快。`
            : `This chat's context is ~${ctxK}k tokens. Longer chats get slower and cost more each turn. The prompt below asks Claude to summarize so you can continue in a fresh, lighter chat.`}
        </div>
        <div class="tm-ho-label">${zh ? '将要发送的提示（可编辑）' : "Prompt we'll send (editable)"}</div>
        <textarea class="tm-ho-textarea" rows="4">${_escape(_defaultPrompt())}</textarea>
        <div class="tm-ho-actions">
          <button class="tm-ho-btn-ghost" data-ho="cancel">${zh ? '取消' : 'Cancel'}</button>
          <button class="tm-ho-btn-primary" data-ho="send">${zh ? '生成摘要' : 'Generate summary'}</button>
        </div>
        <div class="tm-ho-foot-note">${zh ? '这会在当前对话里发送一条消息。' : 'This sends one message in the current chat.'}</div>
      </div>`;
    _bindStep1();
  }

  function _bindStep1() {
    const card = _root.querySelector('.tm-ho-card');
    card.onclick = async (e) => {
      const act = e.target.closest('[data-ho]')?.dataset.ho;
      if (act === 'cancel') { close(); return; }
      if (act === 'send') {
        const ta = _root.querySelector('.tm-ho-textarea');
        const prompt = (ta && ta.value.trim()) || _defaultPrompt();
        _renderStep2Progress();
        await _runSummarize(prompt);
      }
    };
  }

  // ── Step 2: progress while summarizing ────────────────────────────────────
  function _renderStep2Progress() {
    const zh = _isZh();
    _root.innerHTML = `
      <div class="tm-ho-card" role="dialog" aria-modal="true">
        <div class="tm-ho-head">
          <div class="tm-ho-step-dots"><span></span><span class="on"></span><span></span></div>
        </div>
        <div class="tm-ho-progress">
          <div class="tm-ho-spinner" aria-hidden="true"></div>
          <div class="tm-ho-title" style="margin-top:14px;">${zh ? '正在生成摘要…' : 'Generating summary…'}</div>
          <div class="tm-ho-why" id="tm-ho-progress-note">
            ${zh ? 'Claude 正在总结这个对话，通常 10–30 秒。' : 'Claude is summarizing this chat — usually 10–30 seconds.'}
          </div>
        </div>
      </div>`;
    // Rotate a couple of reassuring notes so the screen never feels frozen.
    let i = 0;
    const notes = zh
      ? ['正在阅读对话历史…', '正在提炼关键结论…', '快好了…']
      : ['Reading the conversation…', 'Distilling key points…', 'Almost there…'];
    const note = _root.querySelector('#tm-ho-progress-note');
    const iv = setInterval(() => {
      if (!_polling || !note) { clearInterval(iv); return; }
      note.textContent = notes[i % notes.length]; i++;
    }, 4000);
  }

  // ── Step 3a: success — summary copied, clear next steps ───────────────────
  function _renderStep3Done() {
    const zh = _isZh();
    _root.innerHTML = `
      <div class="tm-ho-card" role="dialog" aria-modal="true">
        <div class="tm-ho-head">
          <div class="tm-ho-step-dots"><span></span><span></span><span class="on"></span></div>
          <button class="tm-ho-x" data-ho="close" aria-label="${zh ? '关闭' : 'Close'}">×</button>
        </div>
        <div class="tm-ho-check">✓</div>
        <div class="tm-ho-title" style="text-align:center;">${zh ? '摘要已复制到剪贴板' : 'Summary copied to clipboard'}</div>
        <div class="tm-ho-steps">
          <div class="tm-ho-steprow"><span class="tm-ho-num">1</span><span>${zh ? '点下面按钮打开一个新对话' : 'Open a new chat with the button below'}</span></div>
          <div class="tm-ho-steprow"><span class="tm-ho-num">2</span><span>${zh ? '在新对话里粘贴（⌘/Ctrl + V）' : 'Paste into it (⌘/Ctrl + V)'}</span></div>
          <div class="tm-ho-steprow"><span class="tm-ho-num">3</span><span>${zh ? '直接接着聊，又快又省' : 'Continue right where you left off — lighter & faster'}</span></div>
        </div>
        <div class="tm-ho-preview-wrap">
          <div class="tm-ho-label">${zh ? '摘要预览' : 'Summary preview'}</div>
          <div class="tm-ho-preview">${_escape((_summaryText || '').slice(0, 320))}${(_summaryText || '').length > 320 ? '…' : ''}</div>
        </div>
        <div class="tm-ho-actions">
          <button class="tm-ho-btn-ghost" data-ho="recopy">${zh ? '重新复制' : 'Copy again'}</button>
          <button class="tm-ho-btn-primary" data-ho="newchat">${zh ? '打开新对话' : 'Open new chat'}</button>
        </div>
        <div class="tm-ho-foot-note">${zh ? '新对话会在当前标签打开，摘要已在你的剪贴板里等着粘贴。' : 'The new chat opens in this tab; your summary is waiting on the clipboard.'}</div>
      </div>`;
    _bindStep3();
  }

  function _bindStep3() {
    const card = _root.querySelector('.tm-ho-card');
    card.onclick = async (e) => {
      const act = e.target.closest('[data-ho]')?.dataset.ho;
      if (act === 'close') { close(); return; }
      if (act === 'recopy') {
        try { await navigator.clipboard.writeText(_summaryText || ''); } catch (_) {}
        const btn = card.querySelector('[data-ho="recopy"]');
        if (btn) { const t = btn.textContent; btn.textContent = _isZh() ? '已复制 ✓' : 'Copied ✓'; setTimeout(() => { if (btn) btn.textContent = t; }, 1500); }
        return;
      }
      if (act === 'newchat') {
        // CONSERVATIVE handoff: we open a new chat (a navigation the user
        // explicitly clicked for) but we DO NOT auto-paste/auto-send. The
        // summary is on the clipboard; the user pastes when ready.
        try {
          if (_dispatcher?._state?.platform?.startNewChat) {
            await _dispatcher._state.platform.startNewChat();
          }
        } catch (_) {}
        close();
      }
    };
  }

  // ── Step 3b: failure — honest, with a manual fallback ─────────────────────
  function _renderStep3Error(reason) {
    const zh = _isZh();
    const msg = {
      'write-failed':  zh ? '无法写入输入框，可能页面结构变化了。' : "Couldn't write to the message box (the page may have changed).",
      'submit-failed': zh ? '无法发送消息，请手动发送试试。' : "Couldn't send the message — try sending manually.",
      'timeout':       zh ? '等待回复超时了。摘要可能仍在生成，请稍后在对话里查看。' : 'Timed out waiting for the reply. The summary may still be generating — check the chat.',
      'no-platform':   zh ? '当前页面不可用。' : 'Not available on this page.',
    }[reason] || (zh ? '出了点问题。' : 'Something went wrong.');
    _root.innerHTML = `
      <div class="tm-ho-card" role="dialog" aria-modal="true">
        <div class="tm-ho-head"><button class="tm-ho-x" data-ho="close" aria-label="close">×</button></div>
        <div class="tm-ho-title">${zh ? '没能自动生成摘要' : "Couldn't generate the summary"}</div>
        <div class="tm-ho-why">${_escape(msg)}</div>
        <div class="tm-ho-actions">
          <button class="tm-ho-btn-ghost" data-ho="close">${zh ? '关闭' : 'Close'}</button>
          <button class="tm-ho-btn-primary" data-ho="retry">${zh ? '重试' : 'Try again'}</button>
        </div>
      </div>`;
    const card = _root.querySelector('.tm-ho-card');
    card.onclick = (e) => {
      const act = e.target.closest('[data-ho]')?.dataset.ho;
      if (act === 'close') close();
      if (act === 'retry') _renderStep1Confirm();
    };
  }

  // ── The actual summarize work (sends prompt, waits, grabs reply) ──────────
  async function _runSummarize(prompt) {
    const platform = _dispatcher?._state?.platform;
    if (!platform) { _renderStep3Error('no-platform'); return; }

    _polling = true;

    const before = _conv?.messages ? _conv.messages.filter(m => m.role === 'assistant').length : 0;

    const wrote = platform.writeComposerDraft(prompt);
    if (!wrote) { _polling = false; _renderStep3Error('write-failed'); return; }

    await new Promise(r => setTimeout(r, 90));
    const submitted = platform.submitComposer();
    if (!submitted) { _polling = false; _renderStep3Error('submit-failed'); return; }

    const started = Date.now();
    while (_polling && Date.now() - started < 90000) {
      await new Promise(r => setTimeout(r, 1500));
      const streamState = platform.detectStreamState ? platform.detectStreamState() : 'idle';
      if (streamState !== 'streaming' && streamState !== 'submitting') {
        const newConv = platform.scanConversation ? platform.scanConversation() : null;
        const assistants = newConv?.messages ? newConv.messages.filter(m => m.role === 'assistant') : [];
        if (assistants.length > before) {
          const summary = assistants[assistants.length - 1].text;
          if (summary && summary.length > 20) {
            _summaryText = summary;
            try { await navigator.clipboard.writeText(summary); } catch (_) {}
            _polling = false;
            _renderStep3Done();
            return;
          }
        }
        break;
      }
    }
    _polling = false;
    if (_summaryText) _renderStep3Done(); else _renderStep3Error('timeout');
  }

  function _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { mount, open, close };
})();
