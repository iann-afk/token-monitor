// ui/onboarding.js — gentle first-run welcome.
//
// Shown ONCE, only on a fresh install, only on claude.ai. A small, friendly,
// non-blocking card in the corner that answers the three questions a brand-new
// user has: (1) what is this? (2) what's that little pill? (3) how do I use it?
// Dismissing it (or clicking "Got it") marks onboarding done forever.
//
// Deliberately NOT a full-screen modal — that would be jarring on first load.
// It sits in the corner, explains itself, and gets out of the way.

const Onboarding = (function () {

  let _root = null;
  let _shown = false;

  function _isZh() {
    try { return typeof I18N !== 'undefined' && I18N.detect && I18N.detect() === 'zh-CN'; }
    catch (_) { return false; }
  }

  // Called by dispatcher/content init after the overlay is up.
  async function maybeShow() {
    if (_shown) return;
    try {
      const { 'ui:onboarded': done } = await chrome.storage.local.get('ui:onboarded');
      // `false` means "installed, not yet onboarded". `undefined` means an
      // older install predating onboarding — don't nag those users.
      if (done !== false) return;
    } catch (_) { return; }

    _shown = true;
    _render();
  }

  function _markDone() {
    try { chrome.storage.local.set({ 'ui:onboarded': true }); } catch (_) {}
  }

  function _render() {
    const zh = _isZh();
    _root = document.createElement('div');
    _root.className = 'tm-onb';
    _root.dataset.tmWidget = 'onboarding';
    _root.innerHTML = `
      <div class="tm-onb-card">
        <div class="tm-onb-head">
          <span class="tm-onb-spark">✨</span>
          <span class="tm-onb-title">${zh ? '欢迎使用 Recall' : 'Welcome to Recall'}</span>
          <button class="tm-onb-x" data-onb="close" aria-label="${zh ? '关闭' : 'Close'}">×</button>
        </div>
        <div class="tm-onb-body">
          ${zh
            ? '它帮你盯住对话的「上下文用量」——对话越长越慢、越费用量。Recall 会在合适的时候提醒你，让你聊得更顺、更省。'
            : 'It keeps an eye on your conversation\'s context usage — longer chats get slower and costlier. Recall nudges you at the right moments so you chat smoother and cheaper.'}
        </div>
        <div class="tm-onb-points">
          <div class="tm-onb-point">
            <span class="tm-onb-pilldemo"><span class="tm-onb-pilldot"></span>${zh ? '上下文 42%' : 'Context 42%'}</span>
            <span>${zh ? '角落这颗小药丸显示当前上下文，点它展开看详情。' : 'This little pill in the corner shows your context — click it to expand.'}</span>
          </div>
          <div class="tm-onb-point">
            <span class="tm-onb-ico">⚠</span>
            <span>${zh ? '问题太大可能被截断时，会在输入框上方提醒你。' : 'If a question might get cut off, you\'ll see a heads-up above the message box.'}</span>
          </div>
          <div class="tm-onb-point">
            <span class="tm-onb-ico">💡</span>
            <span>${zh ? '对话变长时，可一键总结并接力到新对话。' : 'When a chat gets long, summarize and continue in a fresh one — in one click.'}</span>
          </div>
        </div>
        <div class="tm-onb-actions">
          <button class="tm-onb-btn" data-onb="close">${zh ? '知道了' : 'Got it'}</button>
        </div>
      </div>`;
    _root.addEventListener('click', (e) => {
      if (e.target === _root || e.target.closest('[data-onb="close"]')) {
        _markDone();
        _root.classList.remove('tm-onb-open');
        setTimeout(() => { if (_root && _root.parentElement) _root.parentElement.removeChild(_root); _root = null; }, 200);
      }
    });
    document.body.appendChild(_root);
    requestAnimationFrame(() => { if (_root) _root.classList.add('tm-onb-open'); });
  }

  return { maybeShow };
})();
