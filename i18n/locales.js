// i18n/locales.js — runtime UI strings.

const I18N = (function () {

  const en = {
    'header.title': 'Token monitor',
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
    'btn.recheck': 'Recheck quota',
    'btn.showOverlay': 'Show overlay',
    'btn.hideOverlay': 'Hide overlay',
    'btn.recheck.loading': 'Refreshing...',
    'btn.newChat.atLimit': 'At limit — open anyway',
    'btn.bugReport': 'Bug Report',
    'btn.bugReport.collecting': 'Collecting report...',
    'btn.bugReport.sending': 'Sending...',
    'btn.bugReport.sent': 'Sent!',
    'btn.bugReport.failed': 'Failed — check console',
    'btn.notOnClaude': 'Switch to Claude tab first',
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

    'sound.off': 'Off',
    'sound.soft': 'Soft chime',
    'sound.alert': 'Alert tone',

    'footer.disclaimer': 'Quota fetched from Settings → Usage · all data on-device',

    // In-page
    'inpage.streaming': 'streaming · {input} input committed · ~{output} output so far',
    'inpage.streamingHint': 'Stop saves remaining output. Edit-to-resend re-bills the input.',
    'inpage.truncate.title': 'This question may be cut off',
    'inpage.truncate.body': 'You\'re asking {n} things at once. Try just the first — you\'ll get a fuller answer.',
    'inpage.truncate.bodyGeneric': 'The expected reply is too long for what\'s left in this chat.',
    'inpage.truncate.useFirst': 'Use just question 1',
    'inpage.truncate.sendAnyway': 'Send anyway',
    'inpage.outputSize.s': 'Short reply',
    'inpage.outputSize.m': 'Medium reply',
    'inpage.outputSize.l': 'Long reply',
    'inpage.outputSize.xl': 'Very long reply',
    'inpage.turnBadge': '{tokens} tokens · {pct}% of 5h',
    'inpage.turnBadgeTrend': '{x}x turn 1',

    // Notifications
    'notif.refill.title': 'Claude is back',
    'notif.refill.body': 'Your usage window has refilled.',

    // Overlay extras
    'overlay.minimize': 'Minimize',
    'overlay.close': 'Close',
    'overlay.unknownPlan': 'Unknown',
  };

  const zh = {
    'header.title': 'Token 监控',
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
    'btn.recheck': '刷新配额',
    'btn.showOverlay': '显示浮窗',
    'btn.hideOverlay': '隐藏浮窗',
    'btn.recheck.loading': '刷新中...',
    'btn.newChat.atLimit': '已达上限，仍要开启',
    'btn.bugReport': '问题反馈',
    'btn.bugReport.collecting': '采集中...',
    'btn.bugReport.sending': '发送中...',
    'btn.bugReport.sent': '已发送！',
    'btn.bugReport.failed': '发送失败，请查看控制台',
    'btn.notOnClaude': '请先切换到 Claude 标签页',
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

    'sound.off': '关闭',
    'sound.soft': '轻柔',
    'sound.alert': '警示',

    'footer.disclaimer': '数据来自 Settings → Usage · 全部本地保存',

    'inpage.streaming': '正在生成 · 已提交输入 {input} · 输出 ~{output}',
    'inpage.streamingHint': '现在停止可省下剩余输出。改后重发会重新计费输入部分。',
    'inpage.truncate.title': '此问题可能被截断',
    'inpage.truncate.body': '你一次问了 {n} 个问题。先问第一个能拿到更完整的回答。',
    'inpage.truncate.bodyGeneric': '预测回复太长，可能超出当前对话剩余空间。',
    'inpage.truncate.useFirst': '只问第 1 个',
    'inpage.truncate.sendAnyway': '继续发送',
    'inpage.outputSize.s': '短回复',
    'inpage.outputSize.m': '中等回复',
    'inpage.outputSize.l': '较长回复',
    'inpage.outputSize.xl': '超长回复',
    'inpage.turnBadge': '{tokens} tokens · 占 5h 的 {pct}%',
    'inpage.turnBadgeTrend': '是第 1 轮的 {x} 倍',

    'notif.refill.title': 'Claude 已恢复',
    'notif.refill.body': '配额窗口已重新释放。',

    'overlay.minimize': '最小化',
    'overlay.close': '关闭',
    'overlay.unknownPlan': '未知',
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
