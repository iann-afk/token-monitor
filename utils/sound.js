// utils/sound.js
// ─────────────────────────────────────────────────────────────────────────────
// Web Audio API sound alerts for quota threshold crossings.
// Runs in the content script context — AudioContext requires a browsing
// context and needs to be resumed after a user gesture.
// ─────────────────────────────────────────────────────────────────────────────

const SoundPlayer = (function () {
  let _ctx = null;
  let _ready = false;

  function _getCtx() {
    if (!_ctx) {
      try {
        _ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (_) {
        return null;
      }
    }
    if (_ctx.state === 'suspended') {
      _ctx.resume().catch(() => {});
    }
    return _ctx;
  }

  // Warm up on any user interaction so subsequent automated plays work.
  function _warmUp() {
    if (_ready) return;
    const c = _getCtx();
    if (c) {
      c.resume().then(() => { _ready = true; }).catch(() => {});
    }
  }

  try {
    document.addEventListener('click',   _warmUp, { passive: true, capture: true });
    document.addEventListener('keydown', _warmUp, { passive: true, capture: true });
  } catch (_) {}

  /**
   * Play an alert sound.
   * @param {'soft'|'alert'} type
   * @param {number} volume  0–1
   */
  function play(type, volume) {
    const ctx = _getCtx();
    if (!ctx) return;
    const vol = Math.max(0, Math.min(1, volume || 0.5));

    try {
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, ctx.currentTime);

      if (type === 'alert') {
        // Two-tone alert: 660 Hz → 880 Hz
        for (let i = 0; i < 2; i++) {
          const osc = ctx.createOscillator();
          osc.connect(gain);
          osc.type = 'sine';
          const t0 = ctx.currentTime + i * 0.22;
          osc.frequency.setValueAtTime(660, t0);
          osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.18);
          gain.gain.setValueAtTime(0, t0);
          gain.gain.linearRampToValueAtTime(vol * 0.4, t0 + 0.03);
          gain.gain.linearRampToValueAtTime(0, t0 + 0.2);
          osc.start(t0);
          osc.stop(t0 + 0.22);
        }
      } else {
        // Soft: single gentle chime 880 → 440 Hz
        const osc = ctx.createOscillator();
        osc.connect(gain);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.35);
        gain.gain.linearRampToValueAtTime(vol * 0.3, ctx.currentTime + 0.04);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.35);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
      }
    } catch (_) {}
  }

  return { play };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SoundPlayer;
