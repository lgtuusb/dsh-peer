/*
 * lib/sessionfilter.js —— 会话列表"去垃圾"过滤（两侧行为一致）
 * ---------------------------------------------------------------
 * 背景：两侧的 session.list 来源不同 ——
 *   - 小黑侧：她的插件，自己已经过滤过（4 个）
 *   - 小白侧：DSH 自带官方桥，**不过滤**（103 个）
 * 官方桥返回的字段里没有 size，App 光靠它判断不出哪个是空壳。
 *
 * 关键洞察（小黑给的）：**会话库是共享的**（%DSH_HOME%\sessions 是指向
 * C:\Users\user\.dsh\sessions 的 junction），所以任意一侧的 bridge 插件都能算出
 * **任意会话**的真实体积和最后写入时间。小黑为此加了 `session.meta` 方法：
 *   params { ids: [...] }  →  { meta: { "<id>": { bytes, lastWrite } } }
 *
 * 所以过滤放在 App 后端做：两侧一致，以后调阈值只改一处。
 *
 * 两条安全底线（重要）：
 *   1. **拿不到 meta 就不过滤** —— `session.meta` 还没实现 / 某一侧不支持时，
 *      6 个字段全空，我们会保留全部会话。宁可多显示，也不能把功能弄成"看不到会话"。
 *   2. **不猜**：某个会话查不到 meta 时保留它，不当作空壳丢掉。
 *      隐藏一次真实对话，比多显示一个空壳严重得多。
 */
'use strict';

const META_METHOD = 'session.meta';

// 实测数据（全库 134 个会话文件）：中位数 243 KB，最大 12.8 MB，<32 KB 的有 21 个（16%）。
// 只要真跑过一轮，会话日志就远超 32 KB（系统提示 + 运行时上下文都写进去了），
// 所以 32 KB 基本等价于"建了但没用过"。
const DEFAULT_MIN_BYTES = 32768;
const DEFAULT_LIMIT = 12;

// meta 结果缓存：/api/timeline 每秒轮询，不加缓存等于每秒多打一次桥
const META_CACHE_MS = 3000;

// "刚被动过"的宽限期：用户点「＋新建」后要**立刻**用它，而新会话只有 ~16 KB，
// 会被下面的空壳规则误杀 → 下拉里没有它 → 界面报"找不到"（真机踩过，2026-10-02）。
// 一旦说了话，会话就涨过 32 KB，从此不再需要这个例外。
const JUST_TOUCHED_MS = 10 * 60 * 1000;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

const MIN_SESSION_BYTES = envInt('DSH_PAIR_MIN_BYTES', DEFAULT_MIN_BYTES);
const MAX_SESSIONS = envInt('DSH_PAIR_MAX_SESSIONS', DEFAULT_LIMIT);

const idOf = (s) => (s && (s.sessionId || s.externalSessionId)) || null;

/** 一条会话对应的 meta（两种 id 都认） */
function entryFor(meta, s) {
  if (!meta || !s) return null;
  return (s.sessionId && meta[s.sessionId]) || (s.externalSessionId && meta[s.externalSessionId]) || null;
}

const stampOf = (s) => String((s && (s.lastWrite || s.orderingTime)) || '');

/**
 * 多个候选错误里挑"更有信息量"的那个报给界面。
 * 为什么：先问自己那侧（可能答"不认识这个方法"），再问其它侧（可能连不上）。
 * 如果无脑用最后一个，用户看到的会是"另一侧连不上"，而真正的原因被盖掉了。
 */
function preferError(current, next) {
  if (!current) return next;
  if (current.kind !== 'protocol' && next.kind === 'protocol') return next;
  return current;
}

/**
 * 按 meta 过滤会话：去空壳 → 按最后写入倒序 → 只留前 N 个。
 *
 * 两个例外（都会把很小的会话留下来）：
 *   1. **刚被动过**（lastWrite 在 JUST_TOUCHED_MS 内）—— 点完「＋新建」立刻要用它；
 *   2. **调用方点名要留的**（opts.keep，界面正选着的那个）—— 用户手动切到一个很老的
 *      小会话时，它也不该突然从下拉里消失。
 *
 * @param {Array} sessions 会话列表
 * @param {object|null} meta `session.meta` 的返回；null = 拿不到 → 不过滤
 * @param {object} [opts] { minBytes, limit, keep: string[], now: number }
 * @returns {{sessions: Array, stats: object}}
 */
function filterByMeta(sessions, meta, opts) {
  const o = opts || {};
  const minBytes = Number.isFinite(o.minBytes) ? o.minBytes : MIN_SESSION_BYTES;
  const limit = Number.isFinite(o.limit) ? o.limit : MAX_SESSIONS;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const keep = new Set((Array.isArray(o.keep) ? o.keep : []).filter(Boolean));
  const list = Array.isArray(sessions) ? sessions : [];

  const stats = {
    total: list.length,
    emptyShell: 0,
    justTouched: 0,
    keptPinned: 0,
    noMeta: 0,
    truncated: 0,
    kept: 0,
    applied: !!meta
  };

  // 拿不到 meta：不猜、不动内容，但**照样排序**（只有 orderingTime 时这就是原来的"最近活跃优先"）
  if (!meta) {
    const out = list.slice().sort((a, b) => stampOf(b).localeCompare(stampOf(a)));
    stats.kept = out.length;
    return { sessions: out, stats };
  }

  const kept = [];
  for (const s of list) {
    const m = entryFor(meta, s);
    if (!m) {
      // 底线 2：查不到就留着
      stats.noMeta++;
      kept.push(s);
      continue;
    }
    const bytes = typeof m.bytes === 'number' ? m.bytes : null;
    const touchedAt = m.lastWrite ? Date.parse(m.lastWrite) : NaN;
    const justTouched = Number.isFinite(touchedAt) && now - touchedAt < JUST_TOUCHED_MS;
    const pinned = keep.has(s.sessionId) || keep.has(s.externalSessionId);
    const small = bytes !== null && bytes < minBytes;

    if (small && !justTouched && !pinned) {
      stats.emptyShell++;
      continue;
    }
    if (small && justTouched) stats.justTouched++;
    if (small && pinned) stats.keptPinned++;

    kept.push(Object.assign({}, s, { bytes, lastWrite: m.lastWrite || null }));
  }

  kept.sort((a, b) => stampOf(b).localeCompare(stampOf(a)));
  const out = kept.length > limit ? kept.slice(0, limit) : kept;
  stats.kept = out.length;
  stats.truncated = kept.length - out.length;
  return { sessions: out, stats };
}

/**
 * `session.meta` 的取用器。
 *
 * 先问"自己那侧"，再问其它侧 —— 因为会话库共享，谁都能算。这样不写死"小黑侧"，
 * 以后哪一侧先实现都能用。
 */
function createMetaLoader(opts) {
  const o = opts || {};
  const ttl = Number.isFinite(o.ttlMs) ? o.ttlMs : META_CACHE_MS;
  const cache = new Map(); // sideId -> { key, at, meta }
  const unsupported = new Set(); // sideId -> 这侧没有 session.meta

  function cached(sideId, key) {
    const hit = cache.get(sideId);
    if (hit && hit.key === key && Date.now() - hit.at < ttl) return hit;
    return null;
  }

  return {
    unsupported,
    /**
     * @param {object} ownSide 会话属于哪一侧（优先问它）
     * @param {Array} allSides 其余可问的侧
     * @param {Array<string>} ids
     * @returns {{meta: object|null, source: string|null, error: object|null, cached: boolean}}
     */
    async load(ownSide, allSides, ids) {
      const wanted = (ids || []).filter(Boolean);
      if (!wanted.length) return { meta: null, source: null, error: null, cached: false };

      const key = wanted.slice().sort().join(',');
      const order = [ownSide].concat((allSides || []).filter((s) => s && s !== ownSide));
      let lastError = null;
      const skipped = [];

      for (const side of order) {
        if (!side) continue;
        if (unsupported.has(side.id)) {
          skipped.push(side.id);
          continue;
        }

        const hit = cached(side.id, key);
        if (hit) return { meta: hit.meta, source: side.id, error: null, cached: true };

        try {
          const result = await side.call(META_METHOD, { ids: wanted });
          if (result && result.ok === false) {
            lastError = preferError(lastError, {
              side: side.id,
              kind: 'protocol',
              message: String(result.message || result.code || 'session.meta 失败')
            });
            continue;
          }
          const meta = (result && result.meta) || null;
          cache.set(side.id, { key, at: Date.now(), meta });
          return { meta, source: side.id, error: null, cached: false };
        } catch (err) {
          lastError = preferError(lastError, { side: side.id, kind: err.kind || null, message: err.message });
          // 对端不认识这个方法 = 这侧没有这个能力，别再问了（否则每次轮询都白打一次桥）
          if (err.kind === 'protocol') unsupported.add(side.id);
        }
      }
      // 全都"已知不支持"时循环一次都没进，lastError 会是 null —— 那界面就完全不知道为什么没过滤。
      // 补一条合成错误，把原因说清楚（而不是静默）。
      if (!lastError && skipped.length) {
        lastError = {
          side: skipped[0],
          kind: 'protocol',
          message: '对端不认识 session.meta（已记住，不再重试）'
        };
      }
      return { meta: null, source: null, error: lastError, cached: false };
    },

    clear() {
      cache.clear();
    }
  };
}

module.exports = {
  META_METHOD,
  DEFAULT_MIN_BYTES,
  DEFAULT_LIMIT,
  MIN_SESSION_BYTES,
  MAX_SESSIONS,
  META_CACHE_MS,
  JUST_TOUCHED_MS,
  entryFor,
  filterByMeta,
  createMetaLoader,
  idOf
};
