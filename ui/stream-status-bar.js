// ui/stream-status-bar.js — transient turn-cost bar above the composer.
//
// Non-persistent: visible ONLY while a response is actively streaming
// (spinning icon + live input/output tokens). Disappears when idle.

const StreamStatusBar = (function () {

  let dispatcher = null;
  let root = null;
  let pollTimer = null;

  function mount(d) {
    dispatcher = d;
    pollTimer = setInterval(render, 800);
  }

  function render() {
    if (!dispatcher) return;
    const platform = dispatcher._state.platform;
    const anchor = platform && platform.getComposerAnchor && platform.getComposerAnchor();
    if (!anchor) { _remove(); return; }

    const stream = dispatcher.getInflightStream();

    // Non-persistent: this bar appears ONLY while a response is actively
    // streaming, then disappears. The old idle state ("last turn cost / chat
    // totals") was always-on screen clutter showing after-the-fact info that
    // didn't change the next decision — and it carried the fragile 5h% figure.
    // Live streaming tokens, by contrast, are useful in the moment.
    if (!stream) { _remove(); return; }

    const metrics = dispatcher.getChatMetrics();
    const conv = dispatcher.getConversation();
    const quota = dispatcher.getQuota();

    if (!root) {
      root = document.createElement('div');
      root.className = 'tm-stream-bar';
      root.dataset.tmWidget = 'stream-bar';
    }

    _renderStreaming(stream);

    if (root.parentElement !== anchor.parentElement) {
      anchor.parentElement.insertBefore(root, anchor);
    }
  }

  function _renderStreaming(stream) {
    const inputK = _fmtK(stream.inputCommitted);
    const outputK = _fmtK(stream.outputSoFar);
    root.classList.remove('tm-stream-bar-idle');
    root.classList.add('tm-stream-bar-streaming');
    root.innerHTML = `
      <span class="tm-stream-spin" aria-hidden="true">◐</span>
      <span class="tm-stream-text">${_escape(I18N.t('inpage.streaming', { input: inputK, output: outputK }))}</span>
      <span class="tm-stream-hint">${_escape(I18N.t('inpage.streamingHint'))}</span>
    `;
  }

  function _isZh() {
    try { return I18N.detect && I18N.detect() === 'zh-CN'; }
    catch (_) { return false; }
  }

  function _fmtK(n) {
    if (!n || n < 0) return '0';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function _remove() {
    if (root && root.parentElement) root.parentElement.removeChild(root);
    root = null;
  }

  function _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { mount, render };
})();
