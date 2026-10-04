/*
 * lib/identity.js —— 身份牌：渲染 + "新会话"检测
 * ---------------------------------------------------------------
 * 为什么要有这个文件：
 *   两个实例共用同一份会话库（sessions/profiles 是 junction），协议层又认不出
 *   "这条消息是谁发的"，所以新会话开局是**空白**的。文件层（IDENTITY.md）靠自觉去读，
 *   这里做的是**程序层加速**：把"我是谁"主动塞进对方的当前会话。
 *
 * 两条硬约束：
 *   1. 牌必须**极短** —— 用户在意 token。CARD_MAX_CHARS 是硬上限，超了就截断。
 *   2. 牌里**绝不能出现 token/凭据** —— 只允许 host:port（RULES 第 4 条）。
 *
 * 这个模块是纯函数 + 纯状态，不碰网络、不碰文件系统，所以能直接单测。
 */
'use strict';

// 一张牌的总字符上限。用户在意 token，180 字左右 ≈ 100 token，够用又不肉疼。
const CARD_MAX_CHARS = 180;

// 详细文档的位置：牌里只给路径，不把整份文档塞进上下文
const DOC_PATH = '%REPO%\\IDENTITY.md';

/** endpoint 描述 → "host:port"；不可用时给 null（不编造） */
function endpointText(endpoint) {
  if (!endpoint || endpoint.ok !== true) return null;
  return `${endpoint.host}:${endpoint.port}`;
}

/** 超长时按字符截断，并留一个可见的省略号（绝不悄悄吞掉内容） */
function clamp(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * 把"我是谁"渲染成一段极短文本 —— 这是要真的塞进对方会话、消耗对方 token 的东西。
 *
 * @param {object} from 发牌方 {label, id, workspace, role, endpoint}
 * @param {object} to   收牌方 {label} —— 只用来拼"回信署名"的模板
 * @returns {string} 不超过 CARD_MAX_CHARS 个字符
 */
function renderCard(from, to) {
  const f = from || {};
  const t = to || {};
  // 调用方（lib/sides 的 lightIdentity）已经算好 endpointText 了 —— 优先用它。
  // 直接用 f.endpoint 会踩坑：那里是剥过的 {host,port,pid}，没有 ok 字段。
  const ep = f.endpointText || endpointText(f.endpoint) || '当前离线（重启后会变）';
  // 用代号（Harness/Desktop）而不是全名：牌是要花对方 token 的，越短越好
  const toLabel = t.short || t.label || '对方';
  const fromLabel = f.short || f.label || '我';

  const lines = [
    `[身份牌] ${fromLabel} · ${f.id || '?'} ｜ 工作区 ${f.workspace || '?'} ｜ 桥端点 ${ep}`,
    `分工：${f.role || '未注明'}`,
    `回信：[${toLabel}→${fromLabel}] 意图:… ｜ 会话:<你的 session id> ｜ 详见 ${DOC_PATH}`
  ];
  return clamp(lines.join('\n'), CARD_MAX_CHARS);
}

/**
 * "某一侧开了新会话"的检测器。
 *
 * 为什么要后端记：前端刷新一下就忘了；后端记着，界面上才能稳定地提示
 * "对方换了会话，要不要递牌"。
 *
 * 关键设计：**观察不到会话（离线/空列表）时不覆盖基线**。
 * 否则"离线 → 恢复"会被误报成"开了新会话"，用户会被假提示烦死。
 */
function createSessionWatch() {
  const seen = new Map();

  function snapshot(entry, changed) {
    if (!entry) return null;
    return {
      sessionId: entry.sessionId,
      previousSessionId: entry.previous,
      firstSeenAt: entry.firstSeenAt,
      changedAt: entry.changedAt,
      changed: changed === undefined ? Boolean(entry.changedAt) : Boolean(changed)
    };
  }

  return {
    /** 记下这次看到的外部会话 id；返回这一侧此刻的检测结果 */
    note(sideId, sessionId) {
      const id = sessionId ? String(sessionId) : null;
      const prev = seen.get(sideId);

      // 看不到会话 —— 不改基线，也绝不算"变化"
      if (!id) return snapshot(prev, false);

      if (!prev) {
        const entry = { sessionId: id, previous: null, firstSeenAt: Date.now(), changedAt: null };
        seen.set(sideId, entry);
        return snapshot(entry);
      }
      if (prev.sessionId !== id) {
        prev.previous = prev.sessionId;
        prev.sessionId = id;
        prev.changedAt = Date.now();
        return snapshot(prev);
      }
      return snapshot(prev);
    },

    get(sideId) {
      return snapshot(seen.get(sideId));
    },

    /** 用户已经处理过（递过牌 / 手动关掉提示）—— 清掉待办标记 */
    ack(sideId) {
      const entry = seen.get(sideId);
      if (entry) {
        entry.changedAt = null;
        entry.previous = null;
      }
      return snapshot(entry);
    },

    reset() {
      seen.clear();
    }
  };
}

module.exports = { CARD_MAX_CHARS, DOC_PATH, endpointText, renderCard, createSessionWatch };
