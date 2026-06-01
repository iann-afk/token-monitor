// i18n/locales.js — runtime UI strings.

const I18N = (function () {

  const en = {
    'header.title': 'Recall',
    'header.lastUpdate': '{n}m ago',
    'header.justNow': 'just now',

    'card.context': 'Context window',
    'card.fiveHour': '5-hour window',
    'card.weekly': 'Weekly cap',

    'context.subtitle': '{used}k of {total}k',
    'context.burnRate': '· each turn now ~{x}x cost of turn 1',
    'fiveHour.subtitle': '~{n} messages at current pace · across web · desktop · code',
    'fiveHour.subtitleNoBudget': 'Across web · desktop · code',
    'fiveHour.releases': 'Earliest releases {time}',
    'weekly.subtitle': 'Resets {day} {time} · {days}d left',

    'thisChat.title': 'This chat',
    'thisChat.summary': '{pct}% of 5h budget',
    'thisChat.input': 'input',
    'thisChat.output': 'output',
    'thisChat.turns': '{turns} turns · {tokens}k tokens this conversation',

    'btn.newChat': 'New chat',
    'status.partial': '⚡ Anthropic: partial service issues',
    'status.major': '⚠ Anthropic: major outage',
    'btn.recheck': 'Recheck quota',
    'btn.showOverlay': 'Show overlay',
    'btn.hideOverlay': 'Hide overlay',
    'btn.recheck.loading': 'Refreshing...',
    'btn.recheck.done': '✓ Updated',
    'btn.recheck.unavailable': 'Quota N/A on this account',
    'btn.recheck.noTab': 'No Claude tab found',
    'btn.newChat.atLimit': 'At limit — open anyway',
    'btn.bugReport': 'Bug Report',
    'btn.bugReport.collecting': 'Collecting report...',
    'btn.bugReport.sending': 'Sending...',
    'btn.bugReport.sent': 'Sent!',
    'btn.bugReport.failed': 'Failed — check console',
    'btn.notOnClaude': 'Switch to Claude tab first',
    'btn.exportChat': 'Export chat',
    'popup.openReport': 'Open self-test report →',
    'btn.summarizeGreen': 'Summarize & continue elsewhere · ~1 turn cost',
    'btn.summarizeAmber': 'Summarize now (last chance) · ~1 turn cost',
    'btn.summarizeRed': 'Save manual notes (no AI cost)',

    'settings.thresholds': 'Alert thresholds',
    'settings.contextWarn': 'Context · warn / critical',
    'settings.fiveHourWarn': '5-hour · warn / critical',
    'settings.weeklyWarn': 'Weekly · warn / critical',
    'settings.sound': 'Sound',
    'settings.language': 'Language',
    'settings.notifyRefill': 'Notify when limit refills',

    'sound.off':    'Off',
    'sound.soft':   'Soft fade',
    'sound.chime':  'Triple chime',
    'sound.pop':    'Pop',
    'sound.alert':  'Alert',
    'sound.urgent': 'Urgent',
    'sound.preview':'▶ Preview',

    'footer.disclaimer': 'Quota fetched from Settings → Usage · all data on-device',

    // In-page
    'inpage.streaming': 'streaming · {input} input committed · ~{output} output so far',
    'inpage.streamingHint': 'Stop saves remaining output. Edit-to-resend re-bills the input.',
    'inpage.truncate.title': 'This reply might get cut off',
    'inpage.truncate.body': 'You\'re asking {n} things at once. Try just the first — you\'ll get a fuller answer.',
    'inpage.truncate.bodyGeneric': 'The expected reply is too long for what\'s left in this chat.',
    'inpage.truncate.reasonLongChatBig': 'This chat is already long, and this looks like a big question — the answer may not fully fit. Asking it in a fresh chat (or splitting it) gets a more complete reply.',
    'inpage.truncate.reasonLongChat': 'This chat is getting long, so there\'s less room left for a full answer. A fresh chat would give a more complete reply.',
    'inpage.truncate.reasonBigAsk': 'This looks like a big question — the reply may be long enough to get cut off. Splitting it into parts gets fuller answers.',
    'inpage.truncate.useFirst': 'Use just question 1',
    'inpage.truncate.sendAnyway': 'Send anyway',
    'inpage.outputSize.s': 'Short reply',
    'inpage.outputSize.m': 'Medium reply',
    'inpage.outputSize.l': 'Long reply',
    'inpage.outputSize.xl': 'Very long reply',
    'inpage.turnBadge': '{tokens} tokens',
    'inpage.turnBadgeTrend': '{x}x turn 1',

    // Notifications
    'notif.refill.title': 'Claude is back',
    'notif.refill.body': 'Your usage window has refilled.',

    // Overlay extras
    'overlay.minimize': 'Minimize',
    'overlay.close': 'Close',
    'overlay.unknownPlan': 'Unknown',

    // Token source breakdown (v2.1)
    'breakdown.history': 'Conversation',
    'breakdown.history.tip': 'All previous messages. Grows every turn — a new chat resets this.',
    'breakdown.files': 'Files',
    'breakdown.files.tip': 'PDFs, images, docs you uploaded. Re-charged every turn.',
    'breakdown.project': 'Project',
    'breakdown.project.tip': 'Files stored in your Project. Loaded every session — keep it lean.',
    'breakdown.tools': 'Tools',
    'breakdown.tools.tip': 'Web search, code runner, MCP connectors. Each adds overhead per turn.',
    'breakdown.system': 'System',
    'breakdown.system.tip': "Claude's built-in instructions. Fixed cost, can't be reduced.",
    'breakdown.expandHint': 'Click to see token breakdown',

    // Savings card (v2.1)
    'savings.title': '~{pct}% savings available',
    'savings.sub': 'History uses {pct}% of context. A fresh chat + pasted summary saves quota.',
    'savings.cta': 'Summarize & copy',
    'savings.dismiss': 'Dismiss',
    'savings.done.title': 'Summary copied!',
    'savings.done.sub': 'Paste it in a new chat to continue.',
  };

  const zh = {
    'header.title': 'Recall',
    'header.lastUpdate': '{n} 分钟前',
    'header.justNow': '刚刚',

    'card.context': '上下文窗口',
    'card.fiveHour': '5 小时窗口',
    'card.weekly': '每周配额',

    'context.subtitle': '已用 {used}k / {total}k',
    'context.burnRate': '· 当前每轮约为第 1 轮的 {x} 倍',
    'fiveHour.subtitle': '按当前速度还能发 ~{n} 条 · 网页 · 桌面 · Code 共享',
    'fiveHour.subtitleNoBudget': '网页 · 桌面 · Code 共享',
    'fiveHour.releases': '最早 {time} 释放下一批',
    'weekly.subtitle': '{day} {time} 重置 · 还剩 {days} 天',

    'thisChat.title': '当前对话',
    'thisChat.summary': '占 5 小时配额 {pct}%',
    'thisChat.input': '输入',
    'thisChat.output': '输出',
    'thisChat.turns': '{turns} 轮 · 累计 {tokens}k tokens',

    'btn.newChat': '新建对话',
    'status.partial': '⚡ Anthropic：部分服务异常',
    'status.major': '⚠ Anthropic：服务中断',
    'btn.recheck': '刷新配额',
    'btn.showOverlay': '显示浮窗',
    'btn.hideOverlay': '隐藏浮窗',
    'btn.recheck.loading': '刷新中...',
    'btn.recheck.done': '✓ 已更新',
    'btn.recheck.unavailable': '当前账号无配额数据',
    'btn.recheck.noTab': '未检测到 Claude 页面',
    'btn.newChat.atLimit': '已达上限，仍要开启',
    'btn.bugReport': '问题反馈',
    'btn.bugReport.collecting': '采集中...',
    'btn.bugReport.sending': '发送中...',
    'btn.bugReport.sent': '已发送！',
    'btn.bugReport.failed': '发送失败，请查看控制台',
    'btn.notOnClaude': '请先切换到 Claude 标签页',
    'btn.exportChat': '导出对话',
    'popup.openReport': '打开自检报告 →',
    'btn.summarizeGreen': '总结对话并迁移 · 约 1 轮成本',
    'btn.summarizeAmber': '立即总结（最后机会） · 约 1 轮成本',
    'btn.summarizeRed': '导出手记（不耗 token）',

    'settings.thresholds': '告警阈值',
    'settings.contextWarn': '上下文 · 警告 / 严重',
    'settings.fiveHourWarn': '5 小时 · 警告 / 严重',
    'settings.weeklyWarn': '每周 · 警告 / 严重',
    'settings.sound': '提示音',
    'settings.language': '语言',
    'settings.notifyRefill': '配额释放时通知',

    'sound.off':    '关闭',
    'sound.soft':   '柔和渐出',
    'sound.chime':  '三音叮咚',
    'sound.pop':    '轻弹',
    'sound.alert':  '双音提示',
    'sound.urgent': '紧急三连',
    'sound.preview':'▶ 试听',

    'footer.disclaimer': '数据来自 Settings → Usage · 全部本地保存',

    'inpage.streaming': '正在生成 · 已提交输入 {input} · 输出 ~{output}',
    'inpage.streamingHint': '现在停止可省下剩余输出。改后重发会重新计费输入部分。',
    'inpage.truncate.title': '这个回复可能会被截断',
    'inpage.truncate.body': '你一次问了 {n} 个问题。先问第一个能拿到更完整的回答。',
    'inpage.truncate.bodyGeneric': '预测回复太长，可能超出当前对话剩余空间。',
    'inpage.truncate.reasonLongChatBig': '这个对话已经很长了，而且这个问题比较大——回答可能放不下。换个新对话问（或拆开问）能得到更完整的回复。',
    'inpage.truncate.reasonLongChat': '这个对话越来越长，留给完整回答的空间变少了。换个新对话能得到更完整的回复。',
    'inpage.truncate.reasonBigAsk': '这个问题比较大——回复可能长到被截断。拆成几部分问能得到更完整的回答。',
    'inpage.truncate.useFirst': '只问第 1 个',
    'inpage.truncate.sendAnyway': '继续发送',
    'inpage.outputSize.s': '短回复',
    'inpage.outputSize.m': '中等回复',
    'inpage.outputSize.l': '较长回复',
    'inpage.outputSize.xl': '超长回复',
    'inpage.turnBadge': '{tokens} tokens',
    'inpage.turnBadgeTrend': '是第 1 轮的 {x} 倍',

    'notif.refill.title': 'Claude 已恢复',
    'notif.refill.body': '配额窗口已重新释放。',

    'overlay.minimize': '最小化',
    'overlay.close': '关闭',
    'overlay.unknownPlan': '未知',

    // Token 来源拆解 (v2.1)
    'breakdown.history': '对话历史',
    'breakdown.history.tip': '所有历史消息。每轮增加——新建对话可归零。',
    'breakdown.files': '上传文件',
    'breakdown.files.tip': '你上传的 PDF、图片和文档，每轮都会计费。',
    'breakdown.project': '项目知识',
    'breakdown.project.tip': '存储在 Project 中的文件，每次会话都会加载，保持精简可节省 token。',
    'breakdown.tools': '工具',
    'breakdown.tools.tip': '网络搜索、代码执行、MCP 连接器，每个启用的工具每轮都会增加开销。',
    'breakdown.system': '系统提示',
    'breakdown.system.tip': 'Claude 的内置指令，固定消耗，无法减少。',
    'breakdown.expandHint': '点击查看 token 来源',

    // 省量建议卡片 (v2.1)
    'savings.title': '可节省约 {pct}% token',
    'savings.sub': '对话历史占用 {pct}%，新建对话并粘贴摘要可大幅降低消耗。',
    'savings.cta': '生成摘要并复制',
    'savings.dismiss': '忽略',
    'savings.done.title': '摘要已复制！',
    'savings.done.sub': '在新对话中粘贴即可无缝继续。',
  };

  const STRINGS = { en, 'zh-CN': zh, 'zh-TW': zh };

  let _lang = null;

  function detect() {
    if (_lang) return _lang;
    let stored = null;
    try { stored = (chrome.storage && chrome.storage.sync) ? null : null; } catch (_) {}
    // Async settings load happens via setLang(); default to navigator
    const nav = (typeof navigator !== 'undefined' ? navigator.language : 'en') || 'en';
    if (/^zh/i.test(nav)) _lang = 'zh-CN';
    else _lang = 'en';
    return _lang;
  }

  function setLang(lang) {
    if (lang === 'auto') { _lang = null; return detect(); }
    _lang = STRINGS[lang] ? lang : 'en';
    return _lang;
  }

  function t(key, vars) {
    const lang = detect();
    const dict = STRINGS[lang] || STRINGS.en;
    let s = dict[key] != null ? dict[key] : (STRINGS.en[key] != null ? STRINGS.en[key] : key);
    if (vars) {
      for (const k of Object.keys(vars)) {
        s = s.split('{' + k + '}').join(String(vars[k]));
      }
    }
    return s;
  }

  return { t, setLang, detect };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = I18N;