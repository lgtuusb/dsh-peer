/*
 * theme.js —— 主题三态切换（协议见小黑定的那套）
 * ---------------------------------------------------------------
 * 小黑的 CSS 已经覆盖三种情况（style.css 归她）：
 *   :root                      → 深色令牌（默认）
 *   :root[data-theme="dark"]   → 深色
 *   :root[data-theme="light"]  → 浅色
 *   :root:not([data-theme]) / :root[data-theme="auto"] → 跟随系统
 * 所以 JS 这边只做一件事：往 <html> 上写 data-theme = 'auto' | 'light' | 'dark'。
 * 不传 class、不碰 DOM 结构，纯属性，符合"样式归她、行为归我"的分工。
 *
 * 载入位置：<head> 里（早于首屏绘制，避免闪一下）。
 * 那时按钮还不存在，所以按钮接线放在 wire()，由 app.js 在 DOM 就绪后调用。
 */
'use strict';

(function () {
  var STORAGE_KEY = 'dsh-pair.theme';
  var MODES = ['auto', 'light', 'dark']; // 三态循环顺序：跟随系统 → 浅色 → 深色
  var LABELS = { auto: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' };

  function normalize(mode) {
    return MODES.indexOf(mode) >= 0 ? mode : 'auto'; // 存了脏值就当跟随系统
  }

  function readStored(storage) {
    try {
      return normalize(storage.getItem(STORAGE_KEY));
    } catch (err) {
      return 'auto'; // localStorage 被禁用（file:// 等）时不影响使用
    }
  }

  function writeStored(storage, mode) {
    try {
      storage.setItem(STORAGE_KEY, normalize(mode));
    } catch (err) {
      /* 忽略 */
    }
  }

  function apply(doc, mode) {
    doc.documentElement.dataset.theme = normalize(mode);
  }

  function next(mode) {
    return MODES[(MODES.indexOf(normalize(mode)) + 1) % MODES.length];
  }

  function current(doc) {
    return normalize(doc.documentElement.dataset.theme);
  }

  function updateButton(btn, mode) {
    if (!btn) return;
    btn.textContent = LABELS[mode] || LABELS.auto;
    btn.title = '点一下切换：跟随系统 → 浅色 → 深色（选择会记在本机）';
  }

  /** 接线按钮（幂等）：DOM 就绪后由 app.js 调用 */
  function wire(doc, storage) {
    var d = doc || document;
    var s = storage || window.localStorage;
    var btn = d.getElementById('theme-btn');
    if (btn && !btn.dataset.themeWired) {
      btn.dataset.themeWired = '1';
      updateButton(btn, current(d));
      btn.addEventListener('click', function () {
        var mode = next(current(d));
        apply(d, mode);
        writeStored(s, mode);
        updateButton(btn, mode);
      });
    }
    updateButton(btn, current(d));
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    MODES: MODES,
    LABELS: LABELS,
    normalize: normalize,
    readStored: readStored,
    apply: apply,
    next: next,
    current: current,
    wire: wire
  };

  if (typeof window !== 'undefined') window.DshPairTheme = api;

  // 载入即应用（在 <head> 里跑，避免主题闪烁）
  if (typeof document !== 'undefined' && document.documentElement) {
    var storage = typeof window !== 'undefined' ? window.localStorage : null;
    apply(document, storage ? readStored(storage) : 'auto');
  }
})();
