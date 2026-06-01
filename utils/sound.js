// utils/sound.js — Web Audio API sound alerts v2.1.1
// 5 distinct sounds: soft / chime / pop / alert / urgent

const SoundPlayer = (function () {
  let _ctx = null;
  let _ready = false;

  function _getCtx() {
    if (!_ctx) {
      try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (_) { return null; }
    }
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    return _ctx;
  }

  function _warmUp() {
    if (_ready) return;
    const c = _getCtx();
    if (c) c.resume().then(() => { _ready = true; }).catch(() => {});
  }

  try {
    document.addEventListener('click',   _warmUp, { passive: true, capture: true });
    document.addEventListener('keydown', _warmUp, { passive: true, capture: true });
  } catch (_) {}

  // ── Sound definitions ────────────────────────────────────────────────────

  const SOUNDS = {

    // 1. Soft: gentle sine fade 880→440 Hz  (original)
    soft(ctx, vol, t0) {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t0);
      osc.frequency.exponentialRampToValueAtTime(440, t0 + 0.35);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol * 0.30, t0 + 0.04);
      g.gain.linearRampToValueAtTime(0, t0 + 0.38);
      osc.start(t0); osc.stop(t0 + 0.4);
    },

    // 2. Chime: three ascending notes — C5 E5 G5
    chime(ctx, vol, t0) {
      [523, 659, 784].forEach((freq, i) => {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.type = 'sine';
        const t = t0 + i * 0.14;
        osc.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol * 0.28, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        osc.start(t); osc.stop(t + 0.5);
      });
    },

    // 3. Pop: short percussive click  (token-counter style)
    pop(ctx, vol, t0) {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, t0);
      osc.frequency.exponentialRampToValueAtTime(200, t0 + 0.06);
      g.gain.setValueAtTime(vol * 0.5, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
      osc.start(t0); osc.stop(t0 + 0.1);
    },

    // 4. Alert: two-tone 660→880 Hz  (original)
    alert(ctx, vol, t0) {
      for (let i = 0; i < 2; i++) {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.type = 'sine';
        const t = t0 + i * 0.22;
        osc.frequency.setValueAtTime(660, t);
        osc.frequency.exponentialRampToValueAtTime(880, t + 0.18);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol * 0.40, t + 0.03);
        g.gain.linearRampToValueAtTime(0, t + 0.20);
        osc.start(t); osc.stop(t + 0.22);
      }
    },

    // 5. Urgent: three rapid descending pulses 900→600 Hz
    urgent(ctx, vol, t0) {
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.type = 'sawtooth';
        const t = t0 + i * 0.18;
        osc.frequency.setValueAtTime(900, t);
        osc.frequency.exponentialRampToValueAtTime(600, t + 0.14);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol * 0.25, t + 0.02);
        g.gain.linearRampToValueAtTime(0, t + 0.15);
        osc.start(t); osc.stop(t + 0.18);
      }
    },
  };

  /**
   * Play a named sound.
   * @param {'soft'|'chime'|'pop'|'alert'|'urgent'} type
   * @param {number} volume  0–1
   */
  function play(type, volume) {
    const ctx = _getCtx();
    if (!ctx) return;
    const vol = Math.max(0, Math.min(1, volume ?? 0.5));
    const fn  = SOUNDS[type] || SOUNDS.soft;
    try { fn(ctx, vol, ctx.currentTime); } catch (_) {}
  }

  /** Preview a sound from the settings UI — always audible even before warmUp */
  function preview(type, volume) {
    const ctx = _getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => play(type, volume)).catch(() => {});
      return;
    }
    play(type, volume);
  }

  return { play, preview };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SoundPlayer;
