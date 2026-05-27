// scripts/probe-selectors.js
// ─────────────────────────────────────────────────────────────────────────────
// Paste this whole script into the Claude.ai DevTools console.
// It will check each selector chain we rely on and print a report.
//
// Usage:
//   1. Open claude.ai with an active chat
//   2. Open DevTools (Cmd+Opt+I / F12)
//   3. Console tab, paste this whole file, press Enter
//   4. Read the report
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const probes = [
    {
      name: 'model selector button',
      selectors: [
        'button[data-testid*="model"]',
        'button[data-testid*="Model"]',
        'header button[aria-haspopup="menu"]',
        'main button[aria-haspopup="menu"]',
        'button[aria-haspopup="menu"]',
      ],
      validate: (el) => /sonnet|opus|haiku/i.test(el.textContent || ''),
    },
    {
      name: 'extended thinking toggle',
      selectors: [
        'button[aria-label*="thinking" i]',
        'button[aria-label*="extended" i]',
        '[role="switch"][aria-label*="thinking" i]',
        'button[data-testid*="thinking"]',
      ],
    },
    {
      name: 'user message turns',
      selectors: [
        '[data-testid="user-message"]',
        'div[data-test-render-count] [class*="font-user-message"]',
        '[data-testid*="user"][data-testid*="message"]',
      ],
    },
    {
      name: 'assistant message turns',
      selectors: [
        '[data-testid="assistant-message"]',
        'div[data-test-render-count] [class*="font-claude-message"]',
        '[data-testid*="assistant"][data-testid*="message"]',
      ],
    },
    {
      name: 'attachment chips',
      selectors: [
        '[data-testid*="attachment"]',
        '[data-testid*="file"]',
        '[role="button"][aria-label*="file" i]',
      ],
    },
    {
      name: 'composer input',
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
      name: 'stop button (only present while streaming)',
      selectors: [
        'button[aria-label*="Stop" i]',
        'button[aria-label*="stop response" i]',
        'button[data-testid*="stop"]',
      ],
    },
    {
      name: 'banners (alerts / status)',
      selectors: [
        '[role="alert"]',
        '[role="status"]',
        '[data-testid*="banner"]',
        '[data-testid*="warning"]',
        '[data-testid*="limit"]',
      ],
    },
    {
      name: 'new chat button',
      selectors: [
        'a[href="/new"]',
        'button[aria-label*="New chat" i]',
        'a[aria-label*="New chat" i]',
      ],
    },
  ];

  console.log('%c━━━━━ Token Monitor — selector probe ━━━━━', 'font-weight:bold;color:#2563eb');
  console.log('URL:', location.href);
  console.log('Time:', new Date().toLocaleString());
  console.log('');

  for (const probe of probes) {
    let hitIndex = -1;
    let count = 0;
    let firstEl = null;
    for (let i = 0; i < probe.selectors.length; i++) {
      try {
        const nodes = document.querySelectorAll(probe.selectors[i]);
        const filtered = probe.validate ? Array.from(nodes).filter(probe.validate) : Array.from(nodes);
        if (filtered.length > 0) {
          hitIndex = i;
          count = filtered.length;
          firstEl = filtered[0];
          break;
        }
      } catch (_) {}
    }

    if (hitIndex === -1) {
      console.log(`%c❌ ${probe.name}`, 'color:#ef4444');
      console.log('   none of', probe.selectors.length, 'selectors matched');
    } else if (hitIndex === 0) {
      console.log(`%c✅ ${probe.name}`, 'color:#16a34a', `(${count} match${count > 1 ? 'es' : ''})`);
    } else {
      console.log(`%c⚠️  ${probe.name}`, 'color:#f59e0b', `(fallback #${hitIndex}, ${count} match${count > 1 ? 'es' : ''})`);
      console.log('   primary selector failed:', probe.selectors[0]);
      console.log('   fallback that worked  :', probe.selectors[hitIndex]);
    }
    if (firstEl) {
      console.log('   sample:', firstEl);
    }
    console.log('');
  }

  console.log('%cDone. Share screenshots of any ❌ or ⚠️ rows so primary selectors can be updated.', 'color:#5b6068');
})();
