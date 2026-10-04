/*
 * lib/project.js —— 时间线条目 → 前端要显示的最小结构
 * ---------------------------------------------------------------
 * 关键点：只有 type === "message" 的才是对话正文。
 * 真机上 reasoning 条目（type=system, kind=reasoning）**也带 content.text**，
 * 那是模型的思考过程，不能当回复显示。工具条目只给摘要，不给 output（可能几十 KB）。
 *
 * "什么算回复正文"这件事只允许有一个定义，所以直接复用 peer.js 里的 messageText。
 */
'use strict';

const path = require('path');
const { messageText } = require(path.join(__dirname, '..', '..', 'peer', 'peer.js'));

const seqOf = (item) => Number(item && item.orderSeq) || 0;

/** DSH 自己注入的"假 user 消息"，不是人说的话（Harness那边的桥会标 source.kind） */
const INJECTED_SOURCE_KINDS = new Set(['runtime-context', 'skill-catalog']);
/** 回合正常结束的 reason.kind（实测正常是 "completed"） */
const NORMAL_TURN_REASONS = new Set(['completed', 'normal', 'success', 'finished', 'end', 'ok']);

function isInjected(item) {
  const kind = item && item.source && item.source.kind;
  return !!kind && INJECTED_SOURCE_KINDS.has(String(kind));
}

// ---------------------------------------------------------------- 工具调用的"在干什么"
// 用户要看"Desktop在跑什么"，所以工具条目要能说清"对哪个文件做了什么"。
// **安全红线（RULES 第 4 条）**：命令正文（bash/pwsh 的 command）一律不显示 ——
// 用户会截图，而命令行里可能带 token/key。只取路径和短文本字段。
const HINT_PATH_KEYS = ['file_path', 'filePath', 'path', 'target', 'notebook_path'];
const HINT_TEXT_KEYS = ['pattern', 'query', 'url', 'description'];
const HINT_MAX = 56;

function clip(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** 从工具入参里挑一条**可以安全展示**的短提示；没有就返回 null（宁可不显示） */
function inputHint(input) {
  if (!input || typeof input !== 'object') return null;
  for (const k of HINT_PATH_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return clip(v, HINT_MAX);
  }
  for (const k of HINT_TEXT_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return clip(v, HINT_MAX);
  }
  return null;
}

/** turn.end 的 content.reason 实测是对象：{kind:"completed"}；被拦时是 blocked 之类 */
function turnReasonKind(item) {
  const content = (item && item.content) || {};
  const reason = content.reason;
  if (!reason) return null;
  if (typeof reason === 'string') return reason;
  return reason.kind || reason.type || null;
}

function projectItem(item) {
  const content = (item && item.content) || {};
  const text = messageText(item);
  const row = {
    orderSeq: seqOf(item),
    id: (item && item.id) || null,
    type: (item && item.type) || null,
    role: (item && item.role) || null,
    status: (item && item.status) || null,
    kind: content.kind || null,
    sourceKind: (item && item.source && item.source.kind) || null,
    toolName: content.toolName || null,
    isError: content.isError === true,
    text: text === null ? null : text,
    chars: text === null ? 0 : text.length,
    time: (item && item.source && item.source.time) || null
  };
  if (item && item.type === 'tool') {
    row.outputChars = typeof content.output === 'string' ? content.output.length : 0;
    row.title = content.title || null;
    // "当前在干什么"用：只给路径/短文本，**绝不给命令正文**（见 inputHint 的说明）
    row.inputHint = inputHint(content.input);
  }
  if (item && item.type === 'turn.end') {
    row.reasonKind = turnReasonKind(item);
    row.abnormal = !NORMAL_TURN_REASONS.has(String(row.reasonKind || '').toLowerCase());
  }
  return row;
}

/**
 * 只保留界面有意义的东西：对话正文、工具活动、**异常结束的回合**。
 *
 * 两条过滤规则都不是想当然加的：
 *   1. source.kind 是 runtime-context / skill-catalog 的，是 DSH 注入的假 user 消息，不是人说的；
 *   2. turn.end 只在 reason 异常时显示 —— 实测正常是 reason.kind="completed"，
 *      而"被权限挡下"时回合会静默结束（Harness踩过：消息进了 inbox 但 agent 一步没动，界面上什么都看不到）。
 */
function projectTimeline(items, afterSeq) {
  const out = [];
  for (const item of items) {
    const seq = seqOf(item);
    if (afterSeq && seq <= afterSeq) continue;
    if (isInjected(item)) continue;

    const type = item && item.type;
    if (type === 'message') {
      const row = projectItem(item);
      if (row.text !== null) out.push(row);
      continue;
    }
    if (type === 'tool') {
      out.push(projectItem(item));
      continue;
    }
    if (type === 'turn.end') {
      const row = projectItem(item);
      if (row.abnormal) out.push(row); // 正常结束不打扰用户
      continue;
    }
    // turn.start / reasoning / 其它一律不显示
  }
  out.sort((a, b) => a.orderSeq - b.orderSeq);
  return out;
}

module.exports = { projectItem, projectTimeline, seqOf, turnReasonKind, isInjected, NORMAL_TURN_REASONS, INJECTED_SOURCE_KINDS };
