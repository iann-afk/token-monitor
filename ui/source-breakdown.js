// ui/source-breakdown.js — Token 来源拆解面板 (P1)
// 挂载到 overlay 的 context 进度条行，点击展开分解详情。
// 完全在现有 tm-overlay 内部渲染，不增加新的 DOM 根节点。

const SourceBreakdown = (function () {

  let _dispatcher = null;
  // Default collapsed. This is a low-value, curiosity-only panel (token source
  // split is an estimate-of-an-estimate and doesn't change any decision), so we
  // do NOT restore a previously-expanded state — the user must opt in each time.
  let _expanded = false;

  function mount(dispatcher) {
    _dispatcher = dispatcher;
  }

  /**
   * 生成 context 行 HTML（含可展开的分解面板）。
   * 由 overlay.js 调用，替换原来的 _barRow('Context', ...) 输出。
   */
  function renderContextRow(ctxPct, ctxColor, conv, model) {
    const breakdown = _computeBreakdown(conv, model);
    // If no breakdown data (empty chat), render plain bar without expand UI
    if (!breakdown.length) {
      return `
        <div class="tm-bar-row">
          <span class="tm-bar-label">Context</span>
          <div class="tm-bar-track">
            <div class="tm-bar-fill" style="width:${Math.min(100, ctxPct)}%;background:${ctxColor};"></div>
          </div>
          <span class="tm-bar-pct" style="color:${ctxColor}">${Math.round(ctxPct)}%</span>
        </div>`;
    }
    const arrowChar = _expanded ? '▾' : '▸';

    // ── Silent context loss zone detection ──────────────────────────────
    const totalTokens  = conv ? (conv.contextTokens || 0) : 0;
    const historyTokens = breakdown.find(r => r.key === 'history')?.tokens || 0;
    const histRatio     = totalTokens > 0 ? historyTokens / totalTokens : 0;
    const turnCount     = conv?.messages?.length || 0;

    let silentLossHtml = '';
    // Serious zone: >25k tokens — Claude very likely already dropping context
    if (totalTokens >= 25000) {
      const isCN = typeof I18N !== 'undefined' && I18N.detect() === 'zh-CN';
      silentLossHtml = `<div class="tm-silent-loss tm-silent-loss--serious">
        ⚠ ${isCN ? 'Claude 可能已丢弃早期消息' : 'Claude may be dropping early messages'}
      </div>`;
    // Warning zone: >15k tokens, substantial history, multi-turn
    } else if (totalTokens >= 15000 && histRatio >= 0.5 && turnCount >= 6) {
      const isCN = typeof I18N !== 'undefined' && I18N.detect() === 'zh-CN';
      silentLossHtml = `<div class="tm-silent-loss">
        🧠 ${isCN ? '接近上下文丢失区间（建议开启新对话）' : 'Approaching silent context loss zone'}
      </div>`;
    }

    // ── Clickable hint shown only when collapsed ──────────────────────────
    const clickHint = !_expanded
      ? `<span class="tm-bd-hint">${typeof I18N !== 'undefined' && I18N.detect() === 'zh-CN' ? '点击查看来源' : 'click for source'}</span>`
      : '';

    return `
      <div class="tm-bar-row tm-ctx-row" data-act="toggle-breakdown" style="cursor:pointer" title="${typeof I18N !== 'undefined' && I18N.detect() === 'zh-CN' ? '点击展开 token 来源拆解' : 'Click to expand token source breakdown'}">
        <span class="tm-bar-label">Context</span>
        <div class="tm-bar-track">
          <div class="tm-bar-fill" style="width:${Math.min(100, ctxPct)}%;background:${ctxColor};"></div>
        </div>
        <span class="tm-bar-pct" style="color:${ctxColor}">${Math.round(ctxPct)}%</span>
        <span class="tm-bd-arrow" aria-label="展开来源">${arrowChar}</span>
      </div>
      ${clickHint}
      ${silentLossHtml}
      ${_expanded ? `<div class="tm-bd-panel">${breakdownRows(breakdown)}</div>` : ''}
    `;
  }

  function breakdownRows(breakdown) {
    return breakdown.map(({ label, tokens, pct, tooltip, color }) => {
      const w = Math.max(2, Math.round(pct));
      return `
        <div class="tm-bd-row" title="${_esc(tooltip)}">
          <span class="tm-bd-dot" style="background:${color}"></span>
          <span class="tm-bd-label">${_esc(label)}</span>
          <div class="tm-bd-track">
            <div class="tm-bd-fill" style="width:${w}%;background:${color}"></div>
          </div>
          <span class="tm-bd-num">${_fmtK(tokens)}</span>
          <span class="tm-bd-pct">${Math.round(pct)}%</span>
        </div>`;
    }).join('');
  }

  function toggle() {
    _expanded = !_expanded;
    try { localStorage.setItem('tm:breakdown:open', _expanded ? '1' : '0'); } catch (_) {}
  }

  function isExpanded() { return _expanded; }

  /**
   * 计算各来源的 token 分解。
   * 返回按 tokens 降序排列的数组。
   */
  function _computeBreakdown(conv, model) {
    if (!conv) return [];
    // If context is essentially empty (new/blank chat), return empty to avoid
    // division-by-near-zero producing absurd percentages like 60000%.
    if (!conv.contextTokens || conv.contextTokens < 200) return [];

    const attachment = conv.attachmentTokens || 0;
    const tools      = conv.toolsOverhead || 0;
    const project    = conv.projectKnowledgeTokens || 0;
    // 系统提示：按 plan 估算固定值（Claude.ai 内置约 500-800 tokens）
    const sysPrompt  = 600;
    // 对话历史 = 总量 - 其他已知分量
    const history    = Math.max(0, (conv.contextTokens || 0) - attachment - tools - project - sysPrompt);
    const total      = Math.max(1, conv.contextTokens || 1);

    const rows = [
      {
        key: 'history',
        label: I18N ? I18N.t('breakdown.history') : 'Conversation',
        tokens: history,
        color: 'var(--tm-info)',
        tooltip: I18N ? I18N.t('breakdown.history.tip') : 'All previous messages. Grows with every turn — starting a new chat resets this.',
      },
      {
        key: 'files',
        label: I18N ? I18N.t('breakdown.files') : 'Uploaded files',
        tokens: attachment,
        color: 'var(--tm-green)',
        tooltip: I18N ? I18N.t('breakdown.files.tip') : 'PDFs, images, documents you uploaded. Each costs tokens every turn.',
      },
      {
        key: 'project',
        label: I18N ? I18N.t('breakdown.project') : 'Project knowledge',
        tokens: project,
        color: 'var(--tm-amber)',
        tooltip: I18N ? I18N.t('breakdown.project.tip') : 'Files in your Project. Loaded every session — keep it lean.',
      },
      {
        key: 'tools',
        label: I18N ? I18N.t('breakdown.tools') : 'Tools & connectors',
        tokens: tools,
        color: '#a855f7',
        tooltip: I18N ? I18N.t('breakdown.tools.tip') : 'Web search, code execution, MCP connectors. Each enabled tool adds overhead.',
      },
      {
        key: 'system',
        label: I18N ? I18N.t('breakdown.system') : 'System prompt',
        tokens: sysPrompt,
        color: 'var(--tm-text-3)',
        tooltip: I18N ? I18N.t('breakdown.system.tip') : "Claude's built-in instructions. Fixed cost, can't be reduced.",
      },
    ];

    return rows
      .filter(r => r.tokens > 0)
      .map(r => ({ ...r, pct: (r.tokens / total) * 100 }))
      .sort((a, b) => b.tokens - a.tokens);
  }

  function _fmtK(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  return { mount, renderContextRow, toggle, isExpanded };

})();
