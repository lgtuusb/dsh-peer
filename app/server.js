#!/usr/bin/env node
/*
 * server.js —— dsh-pair 后端（零依赖 Node HTTP 服务）
 * ---------------------------------------------------------------
 * 一个页面同时连两个 DSH 实例：读两份 endpoint.json，对两边说同一套 JSON-RPC。
 * 协议层复用 ../peer/lib/bridge.js（不重复实现），连接管理在 lib/sides.js。
 *
 * 接口（全部只绑 127.0.0.1，且要带 x-dsh-pair 令牌头 —— 见 README 的"为什么有令牌"）：
 *   GET  /api/health
 *   GET  /api/sides                          两侧的连接状态 / identity / endpoint
 *   GET  /api/identity[?side=<id>]           身份牌（实时读 endpoint.json；带"对方换了会话"检测）
 *   POST /api/identity/give  {from,to}       把 from 侧的身份牌塞进 to 侧的当前会话
 *   POST /api/identity/ack   {side}          清掉某一侧"开了新会话"的待办提示
 *   GET  /api/sessions?side=<id>             某侧的会话列表
 *   POST /api/sessions/new {side, text?, cwd?} 在某侧新建会话（session.createAndStart）
 *   GET  /api/timeline?side=&session=&after=&tail=
 *                                            某会话的新条目 + status(idle|running) + 会话信息
 *   POST /api/send     {side, session?, text} 发消息（session 省略则用该侧 live 会话）
 *   POST /api/interrupt{side, session?}       打断该会话当前回合
 *
 * 用法：node server.js [--port 8787] [--host 127.0.0.1] [--sides <path>]
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const { SideManager, AppError, loadSides, resolveSession, filterByWorkspace, byRecency } = require('./lib/sides');
const { projectTimeline, seqOf } = require('./lib/project');
const { renderCard, endpointText, createSessionWatch, CARD_MAX_CHARS } = require('./lib/identity');
const {
  createMetaLoader,
  filterByMeta,
  idOf,
  MIN_SESSION_BYTES,
  MAX_SESSIONS
} = require('./lib/sessionfilter');

// ---------------------------------------------------------------- 参数
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '--host' || a === '--sides') {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--port=')) {
      out.port = a.slice(7);
    } else if (a.startsWith('--sides=')) {
      out.sides = a.slice(8);
    } else if (a.startsWith('--host=')) {
      out.host = a.slice(7);
    }
  }
  return out;
}

const ARGS = parseArgv(process.argv.slice(2));
const PORT = Number(ARGS.port || process.env.DSH_PAIR_PORT || 8787);
const HOST = ARGS.host || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_TOKEN = crypto.randomBytes(16).toString('hex');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TAIL = 30;
const MAX_TAIL = 200;

// 新建会话时的默认首条消息。
// 为什么不能留空：桥的 session.createAndStart 是"建了就开始跑"，空正文会被拒；
// 而且Harness的 impl.cjs 会把**空壳会话**从列表里过滤掉 —— 不留一句话，新会话建了等于看不见。
// 代价是这一轮真的会跑（花 token），所以界面上必须写清楚。
const DEFAULT_NEW_SESSION_TEXT = '（新会话）';

const manager = new SideManager(loadSides(ARGS.sides || process.env.DSH_PAIR_SIDES));

// "对方开了新会话"的检测状态。后端记着（前端刷新一下就忘了），界面据此提示递牌。
const sessionWatch = createSessionWatch();

// 会话去垃圾过滤用的 meta 取用器（见 lib/sessionfilter.js 的说明）
const metaLoader = createMetaLoader();

// ---------------------------------------------------------------- 运行日志
// 为什么必须有：后端"干净地消失"过一次（进程被外部回收），用户只看到连不上的界面，
// 事后完全查不出原因。日志落在 logs\server-<port>.log。
// ⚠️ 绝不写 token/凭据（RULES 第 4 条）——只写 host:port、路径、错误这类信息。
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, `server-${PORT}.log`);
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const STARTED_AT = new Date().toISOString();

function logLine(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch (err) {
      /* 文件还不存在或改名失败，忽略 */
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (err) {
    /* 日志失败绝不能拖垮服务 */
  }
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

// ---------------------------------------------------------------- 小工具
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, err) {
  let status = err instanceof AppError ? err.httpStatus : 500;
  const code = err instanceof AppError ? err.code : 'internal_error';
  // 连接类失败给语义化状态码：503 离线 / 504 超时 / 502 其它协议问题。
  // 这几个都不是"客户端写错了"，但界面靠 res.ok === false 统一处理。
  const kind = err && err.kind ? err.kind : null;
  if (!(err instanceof AppError)) {
    if (kind === 'endpoint' || kind === 'connect' || kind === 'handshake') status = 503;
    else if (kind === 'timeout') status = 504;
    else if (kind) status = 502;
  }
  sendJson(res, status, {
    ok: false,
    code,
    kind,
    message: err && err.message ? err.message : String(err)
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError(`请求体超过 ${MAX_BODY_BYTES} 字节上限`, 413, 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new AppError(`请求体不是合法 JSON：${err.message}`, 400, 'bad_json'));
      }
    });
    req.on('error', reject);
  });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  // 目录穿越保护：必须仍在 public/ 里
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', message: '路径越界' });
    return;
  }
  let data;
  try {
    data = fs.readFileSync(target);
  } catch (err) {
    sendJson(res, 404, { ok: false, code: 'not_found', message: `没有这个文件：${rel}` });
    return;
  }
  // index.html 里注入本次运行的令牌（前端 fetch 要带这个头）
  if (rel === 'index.html') {
    data = Buffer.from(data.toString('utf8').split('__PAIR_TOKEN_VALUE__').join(API_TOKEN), 'utf8');
  }
  const type = CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': data.length });
  res.end(data);
}

// ---------------------------------------------------------------- 接口实现
async function apiSideStatus() {
  const sides = [];
  for (const side of manager.list()) {
    // 先尝试连一下（决定"在线"还是"为什么离线"），**再**取状态快照 ——
    // 顺序反了的话，第一次调用会拿到 connect 之前那份空 lastError。
    let connectError = null;
    try {
      await side.connect();
    } catch (err) {
      connectError = { kind: err.kind || (err.code === 'offline' ? 'offline' : 'connect'), message: err.message };
    }
    const base = side.status();
    base.connectError = connectError;
    base.online = side.online;
    base.identity = side.identity
      ? {
          runtime: side.identity.runtime,
          displayName: side.identity.displayName,
          bridgeVersion: side.identity.bridgeVersion,
          runtimeVersion: side.identity.runtimeVersion
        }
      : null;
    sides.push(base);
  }
  return { ok: true, sides };
}

// ---------------------------------------------------------------- 身份牌
/**
 * 只读的"我是谁"快照 —— **不需要连上**就能给出。
 * 端点每次现读 endpoint.json（对方一重启 port/token 就变，缓存一定是错的）。
 */
function lightIdentity(side) {
  const ep = side.describeEndpoint();
  return {
    id: side.id,
    short: side.short,
    label: side.label,
    workspace: side.workspace || null,
    dshHome: side.dshHome || null,
    role: side.role || null,
    endpointPath: side.endpointPath,
    endpoint: ep.ok ? { host: ep.host, port: ep.port, pid: ep.pid } : null,
    endpointText: endpointText(ep),
    endpointError: ep.ok ? null : { kind: ep.error.kind, message: ep.error.message }
  };
}

/** 一侧的完整身份牌：还要"当前在哪个会话"，所以得连上 */
async function apiIdentitySide(side) {
  const base = lightIdentity(side);

  let connectError = null;
  try {
    await side.connect();
  } catch (err) {
    connectError = { kind: err.kind || 'connect', message: err.message };
  }
  const st = side.status();

  let session = null;
  let sessionError = null;
  if (st.online) {
    try {
      session = await resolveVisible(side, null).then((r) => r.resolved);
    } catch (err) {
      sessionError = { code: err.code || 'unknown', message: err.message };
    }
  }
  const sessionId = session ? session.externalSessionId : null;
  // 记一笔：这一侧的会话 id 变了 = 用户开了新会话 → 界面提示递牌
  const watch = sessionWatch.note(side.id, sessionId);

  return Object.assign(base, {
    online: st.online,
    identity: st.identity,
    sessionId,
    internalSessionId: session ? session.sessionId : null,
    sessionTitle: session ? session.title : null,
    sessionCwd: session ? session.cwd : null,
    // resolveSession 给回来的是**原始** session 对象：live 在 metadata.live 里，
    // 顶层没有 live 字段（踩过一次：写成 session.live 就恒为 false）
    sessionLive: !!(session && ((session.metadata && session.metadata.live === true) || session.live === true)),
    ambiguous: session ? session.ambiguous === true : false,
    liveCount: session && session.liveCount != null ? session.liveCount : null,
    lastActive: session ? session.orderingTime || null : null,
    lastOnlineAt: st.lastOnlineAt,
    connectError,
    sessionError,
    changed: watch ? watch.changed : false,
    changedAt: watch ? watch.changedAt : null,
    previousSessionId: watch ? watch.previousSessionId : null
  });
}

async function apiIdentity(query) {
  const only = query && query.side ? String(query.side) : null;
  const targets = only ? [manager.get(only)] : manager.list();
  const sides = [];
  for (const side of targets) sides.push(await apiIdentitySide(side));
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    cardMaxChars: CARD_MAX_CHARS,
    sides
  };
}

/**
 * 递牌：把 from 侧的身份牌塞进 to 侧的**当前会话**。
 * 这是唯一会"主动写进对方会话"的接口 —— 只能由用户点按钮触发，绝不许自动跑
 * （每递一次都要花对方的 token）。
 */
async function apiIdentityGive(body) {
  const fromId = String((body && body.from) || '');
  const toId = String((body && body.to) || '');
  if (!fromId) throw new AppError('缺少 from', 400, 'bad_give');
  if (!toId) throw new AppError('缺少 to', 400, 'bad_give');
  if (fromId === toId) throw new AppError('from 和 to 不能是同一侧', 400, 'same_side');

  const from = manager.get(fromId);
  const to = manager.get(toId);

  // 牌只要 from 的静态事实 + 端点（现读）—— **from 离线也能递**，
  // 因为收牌方需要的是"回信该往哪个路径发"，那是常量。
  const text = renderCard(lightIdentity(from), lightIdentity(to));

  const session = (await resolveVisible(to, body && body.session)).resolved;
  const clientMessageId = crypto.randomUUID();
  const result = await to.call('session.startTurn', {
    sessionId: session.sessionId,
    content: text,
    clientMessageId
  });
  if (result && result.ok === false) {
    throw new AppError(`递牌被拒绝：${result.code || 'unknown'} ${result.message || ''}`.trim(), 409, 'give_rejected');
  }
  if (!result || result.accepted !== true) {
    throw new AppError(`递牌被拒绝（accepted !== true）：${JSON.stringify(result)}`, 409, 'give_rejected');
  }
  // 牌递到了 —— 这一侧"开了新会话"的待办算处理完了
  sessionWatch.ack(to.id);
  return {
    ok: true,
    from: from.id,
    to: to.id,
    accepted: true,
    sessionId: result.sessionId || session.sessionId,
    externalSessionId: result.externalSessionId || session.externalSessionId,
    clientMessageId,
    chars: text.length,
    maxChars: CARD_MAX_CHARS,
    text
  };
}

/** 用户手动关掉"对方开了新会话"的提示 */
function apiIdentityAck(body) {
  const side = manager.get(body && body.side);
  const watch = sessionWatch.ack(side.id);
  return {
    ok: true,
    side: side.id,
    changed: watch ? watch.changed : false,
    sessionId: watch ? watch.sessionId : null
  };
}

async function apiSessionsNew(body) {
  const side = manager.get(body && body.side);
  const text = typeof (body && body.text) === 'string' ? body.text : '';
  const content = text.trim() ? text : DEFAULT_NEW_SESSION_TEXT;

  // cwd 很关键：新会话必须落在**该侧的工作区**里，否则会被 filterByWorkspace 挡在下拉之外，
  // 用户会觉得"点了新建但什么都没发生"。
  const cwd = (body && typeof body.cwd === 'string' && body.cwd) || side.workspace || undefined;

  const clientMessageId = crypto.randomUUID();
  // 注意：**不带 sessionId** —— 新建时还没有会话 id 可带。
  const params = { content, clientMessageId };
  if (cwd) params.cwd = cwd;

  const result = await side.call('session.createAndStart', params);

  // 桥把失败放在 result 里（不是 JSON-RPC error），必须当失败处理
  if (result && result.ok === false) {
    throw new AppError(
      `${side.short} 拒绝新建会话：${result.code || 'unknown'} ${result.message || ''}`.trim(),
      502,
      'new_session_rejected'
    );
  }
  if (!result || result.accepted !== true) {
    throw new AppError(`${side.short} 新建会话被拒绝（accepted !== true）：${JSON.stringify(result)}`, 502, 'new_session_rejected');
  }

  const externalSessionId = result.externalSessionId || result.sessionId || null;
  if (!externalSessionId) {
    throw new AppError(`${side.short} 新建会话成功但没有返回会话 id：${JSON.stringify(result)}`, 502, 'new_session_no_id');
  }

  return {
    ok: true,
    side: side.id,
    accepted: true,
    sessionId: result.sessionId || externalSessionId,
    externalSessionId,
    clientMessageId,
    cwd: cwd || null,
    chars: content.length,
    // 这一轮是真的跑起来了（要花 token），如实告诉界面
    startedTurn: true,
    content
  };
}

// ---------------------------------------------------------------- 会话列表（含去垃圾）
/** `?keep=a,b` → ['a','b']：界面正选着的会话，不管多小都不许被藏掉 */
function parseKeep(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 取某一侧"该给用户看的"会话：按工作区过滤 → 去空壳 → 按最后写入倒序 → 限量。
 *
 * 两种情况都安全：`session.meta` 拿不到（还没实现／对端不认识）时**不过滤**，
 * 只做排序，等于退回原来的行为。
 */
async function listVisibleSessions(side, includeAll, keep) {
  const raw = await side.call('session.list', {});
  const all = raw && Array.isArray(raw.sessions) ? raw.sessions : [];
  const visible = filterByWorkspace(side, all, includeAll);

  const ids = visible.sessions.map(idOf).filter(Boolean);
  const meta = await metaLoader.load(side, manager.list(), ids);

  const filtered = filterByMeta(visible.sessions, meta.meta, {
    minBytes: MIN_SESSION_BYTES,
    // "全部会话"是用户自己按的逃生门：去空壳照做，但不再限量，否则跨工作区会被砍掉一整边
    limit: includeAll ? Number.MAX_SAFE_INTEGER : MAX_SESSIONS,
    // 刚动过的 + 界面正选着的，都不当空壳（见 lib/sessionfilter.js 的两个例外）
    keep: keep || []
  });

  return { all, visible, filtered, meta };
}

/**
 * 无标题会话在界面上也得能认出来。
 * 真机上 12 条会话的 title 全是 null —— 下拉里就是 12 个「(无标题)」，等于没信息。
 * 给个短 id 至少能区分，也方便对着身份牌/桥消息里的 session id 找。
 */
function shortSessionId(id) {
  const t = String(id || '');
  const m = t.match(/^session-([0-9a-f]{8})/);
  if (m) return `会话 ${m[1]}`;
  return t.length > 16 ? t.slice(0, 16) + '…' : t;
}

/** 把会话列表整理成前端下拉要的形状 */
function toSessionOptions(sessions) {
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    externalSessionId: s.externalSessionId,
    title: s.title || shortSessionId(s.externalSessionId || s.sessionId),
    untitled: !s.title,
    cwd: s.cwd || (s.metadata && s.metadata.cwd) || null,
    live: !!(s.metadata && s.metadata.live),
    readOnly: !!(s.metadata && s.metadata.readOnly),
    // Harness加的标记：native = 本实例会话，agents-anywhere = 手机端连接(v2)产生的会话。
    // 她的决定是"不隐藏、只标记"——那些是用户在手机端真实聊出来的历史，不能当垃圾排掉。
    kind: s.kind || null,
    orderingTime: s.orderingTime || null,
    // 去垃圾过滤顺带给出的真实体积/最后写入时间（拿不到就是 null）
    bytes: typeof s.bytes === 'number' ? s.bytes : null,
    lastWrite: s.lastWrite || null
  }));
}

/**
 * 选会话 —— 默认选中**去垃圾之后**的第一个。
 * 不改这条的话，orderingTime（=创建时间）会让刚建的空壳排最前被选中，
 * 消息就投进了没人看的会话（用户抱怨过的"投错会话"）。
 */
async function resolveVisible(side, requested, opts) {
  const o = opts || {};
  const lv = await listVisibleSessions(side, o.includeAll, o.keep);
  const resolved = await resolveSession(
    side,
    requested,
    Object.assign({}, o, {
      sessions: lv.all, // 显式指定时仍要在**全量**里找（用户明确要看的，哪怕不在本工作区）
      candidates: lv.filtered.sessions
    })
  );
  return { resolved, all: lv.all, visible: lv.visible, filtered: lv.filtered, meta: lv.meta };
}

async function apiSessions(sideId, includeAll, keep) {
  const side = manager.get(sideId);
  const lv = await listVisibleSessions(side, includeAll, keep);
  return {
    ok: true,
    side: side.id,
    sessions: toSessionOptions(lv.filtered.sessions),
    workspace: side.workspace || null,
    workspaceFiltered: lv.visible.filtered,
    totalSessions: lv.visible.total,
    noWorkspaceMatch: lv.visible.noMatch === true,
    sessionFilter: lv.filtered.stats,
    metaSource: lv.meta.source,
    metaError: lv.meta.error
  };
}

async function apiTimeline(query) {
  const side = manager.get(query.side);
  const includeAll = query.all === '1' || query.all === 'true';
  // 用"去垃圾后"的候选来定默认会话 —— 否则默认会挑中刚建的空壳
  // 界面正选着的那个会话（?session=）也算"点名要留"：用户手动切到一个小会话时，
  // 它不该在下一轮轮询里突然从下拉消失
  const keep = parseKeep(query.keep).concat(query.session ? [query.session] : []);
  const rv = await resolveVisible(side, query.session, { includeAll, keep });
  const session = rv.resolved;
  const after = Number(query.after) || 0;
  const tailRaw = Number(query.tail) || DEFAULT_TAIL;
  const tail = Math.min(MAX_TAIL, Math.max(1, tailRaw));

  const snapshot = await side.call('session.getSnapshot', {
    sessionId: session.sessionId,
    limit: tail
  });
  const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
  const rows = projectTimeline(items, after);

  // 空洞检测（长会话/高频输出时最要命）：客户端是"记住 lastSeq 只取增量"，
  // 而每次只取 tail 条。如果两轮轮询之间对方产生了**超过 tail 条**新条目，
  // 那么窗口里最老的一条也会 > after+1 —— 中间那批就永远看不到了。
  // 这里显式告诉客户端"有空洞，去拉更大的窗口"。
  const rawSeqs = items.map(seqOf).filter((n) => n > 0);
  const oldestRawSeq = rawSeqs.length ? Math.min(...rawSeqs) : null;
  const gap = after > 0 && oldestRawSeq !== null && oldestRawSeq > after + 1;
  const state = await side.call('session.getState', { sessionId: session.sessionId });
  const all = toSessionOptions(rv.filtered.sessions);

  return {
    ok: true,
    side: side.id,
    session: {
      sessionId: session.sessionId,
      externalSessionId: session.externalSessionId,
      title: session.title || '(无标题)',
      cwd: session.cwd || (session.metadata && session.metadata.cwd) || null,
      ambiguous: session.ambiguous === true,
      liveCount: session.liveCount == null ? null : session.liveCount,
      offWorkspace: session.offWorkspace === true
    },
    sessions: all,
    workspace: side.workspace || null,
    workspaceFiltered: rv.visible.filtered,
    totalSessions: rv.visible.total,
    noWorkspaceMatch: session.noWorkspaceMatch === true,
    sessionFilter: rv.filtered.stats,
    metaSource: rv.meta.source,
    metaError: rv.meta.error,
    status: state ? state.status : null,
    model: state && state.metadata && state.metadata.modelSelection ? state.metadata.modelSelection.model : null,
    items: rows,
    returned: rows.length,
    oldestSeq: oldestRawSeq,
    gap,
    lastSeq: rows.length ? rows[rows.length - 1].orderSeq : (items.length ? seqOf(items[items.length - 1]) : after),
    watermark: snapshot ? snapshot.watermark : null
  };
}

async function apiSend(body) {
  const side = manager.get(body.side);
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    throw new AppError('text 不能为空', 400, 'empty_text');
  }
  const session = (await resolveVisible(side, body.session)).resolved;
  const clientMessageId = crypto.randomUUID();
  const result = await side.call('session.startTurn', {
    sessionId: session.sessionId,
    content: text,
    clientMessageId
  });
  if (result && result.ok === false) {
    throw new AppError(`发送被拒绝：${result.code || 'unknown'} ${result.message || ''}`.trim(), 409, 'send_rejected');
  }
  if (!result || result.accepted !== true) {
    throw new AppError(`发送被拒绝（accepted !== true）：${JSON.stringify(result)}`, 409, 'send_rejected');
  }
  return {
    ok: true,
    side: side.id,
    accepted: true,
    sessionId: result.sessionId || session.sessionId,
    externalSessionId: result.externalSessionId || session.externalSessionId,
    clientMessageId,
    chars: text.length
  };
}

async function apiInterrupt(body) {
  const side = manager.get(body.side);
  const session = (await resolveVisible(side, body.session)).resolved;
  let result = null;
  let error = null;
  try {
    result = await side.call('session.interrupt', { sessionId: session.sessionId });
  } catch (err) {
    error = { kind: err.kind || null, message: err.message };
  }
  if (error) throw new AppError(`打断失败：${error.message}`, 502, 'interrupt_failed');
  return { ok: true, side: side.id, result };
}

// ---------------------------------------------------------------- 路由
async function route(req, res, parsed) {
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams.entries());

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '只支持 GET' });
      return;
    }
    serveStatic(req, res, pathname);
    return;
  }

  // --- 令牌校验：浏览器里的页面拿得到（注入在 HTML 里），外部网页拿不到 ---
  // /api/health 例外：启动器要用它探活，拿不到令牌；它只回 pid/port/side 名，不泄露内容。
  const token = req.headers['x-dsh-pair'];
  if (pathname !== '/api/health' && token !== API_TOKEN) {
    sendJson(res, 403, {
      ok: false,
      code: 'bad_token',
      message: '缺少或错误的 x-dsh-pair 令牌头。请通过 http://127.0.0.1:%d/ 打开界面。'.replace('%d', PORT)
    });
    return;
  }
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    sendJson(res, 403, { ok: false, code: 'bad_origin', message: `拒绝来自 ${origin} 的跨站请求` });
    return;
  }

  if (pathname === '/api/health') {
    // appDir 是给 bin/stop.js 用的：它据此判断"这个实例到底属于哪个目录"，
    // 而不是靠命令行猜路径（相对路径启动的实例猜不出来，曾因此误杀别的实例）。
    // logPath/startedAt 是给界面用的：后端挂了以后用户能知道去哪儿看原因。
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      port: PORT,
      appDir: __dirname,
      logPath: LOG_FILE,
      startedAt: STARTED_AT,
      uptimeMs: Date.now() - new Date(STARTED_AT).getTime(),
      sides: manager.ids()
    });
    return;
  }

  if (pathname === '/api/sides' && req.method === 'GET') {
    sendJson(res, 200, await apiSideStatus());
    return;
  }

  if (pathname === '/api/identity' && req.method === 'GET') {
    sendJson(res, 200, await apiIdentity(query));
    return;
  }

  if (pathname === '/api/identity/give' && req.method === 'POST') {
    sendJson(res, 200, await apiIdentityGive(await readBody(req)));
    return;
  }

  if (pathname === '/api/identity/ack' && req.method === 'POST') {
    sendJson(res, 200, apiIdentityAck(await readBody(req)));
    return;
  }

  if (pathname === '/api/sessions' && req.method === 'GET') {
    sendJson(res, 200, await apiSessions(query.side, query.all === '1' || query.all === 'true', parseKeep(query.keep)));
    return;
  }

  if (pathname === '/api/sessions/new' && req.method === 'POST') {
    sendJson(res, 200, await apiSessionsNew(await readBody(req)));
    return;
  }

  if (pathname === '/api/timeline' && req.method === 'GET') {
    sendJson(res, 200, await apiTimeline(query));
    return;
  }

  if (pathname === '/api/send' && req.method === 'POST') {
    sendJson(res, 200, await apiSend(await readBody(req)));
    return;
  }

  if (pathname === '/api/interrupt' && req.method === 'POST') {
    sendJson(res, 200, await apiInterrupt(await readBody(req)));
    return;
  }

  sendJson(res, 404, { ok: false, code: 'not_found', message: `没有这个接口：${pathname}` });
}

const server = http.createServer((req, res) => {  let parsed;
  try {
    parsed = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch (err) {
    sendJson(res, 400, { ok: false, code: 'bad_url', message: 'URL 解析失败' });
    return;
  }
  route(req, res, parsed).catch((err) => {
    const status = err instanceof AppError ? err.httpStatus : 500;
    const first = String((err && err.message) || err).split('\n')[0];
    // 只记错误，不记每个请求（前端 1s 轮询一次，记请求会把日志刷爆）
    logLine(status >= 500 ? 'ERROR' : 'WARN', `${req.method} ${parsed.pathname} -> ${status} ${first}`);
    if (!res.headersSent) sendError(res, err);
    else {
      try {
        res.end();
      } catch (e) {
        /* 忽略 */
      }
    }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[dsh-pair] port ${PORT} is already in use.`);
    console.error(`[dsh-pair] Another dsh-pair server may already be running - just open http://${HOST}:${PORT}/`);
    console.error('[dsh-pair] Or pick another port:  node server.js --port 8788');
    process.exit(2);
  }
  console.error('[dsh-pair] server error:', err.message);
  process.exit(1);
});

// ---------------------------------------------------------------- PID 文件
// 给 stop.cmd 用：**只按 PID 停自己**，绝不 taskkill /IM node.exe
// （那会连搭档/用户自己在跑的 node 一起杀掉 —— 实测踩过）。
// 按端口分开写，否则同目录起两个实例时后一个会覆盖前一个，stop 只能停掉一个。
const PID_FILE = path.join(__dirname, 'server.pid'); // 最近启动的那个（方便人看）
const PID_FILE_PORT = (port) => path.join(__dirname, `server-${port}.pid`);

function writePidFile() {
  const payload = JSON.stringify(
    { pid: process.pid, port: PORT, url: `http://${HOST}:${PORT}/`, startedAt: new Date().toISOString() },
    null,
    0
  );
  for (const f of [PID_FILE, PID_FILE_PORT(PORT)]) {
    try {
      fs.writeFileSync(f, payload, 'utf8');
    } catch (err) {
      console.error(`[dsh-pair] could not write ${f}: ${err.message}`);
    }
  }
}

function removePidFile() {
  for (const f of [PID_FILE, PID_FILE_PORT(PORT)]) {
    try {
      // 只删自己写的那个（PID 对得上才删）
      const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (cur && cur.pid === process.pid) fs.unlinkSync(f);
    } catch (err) {
      /* 文件不在或不是自己的，忽略 */
    }
  }
}

server.listen(PORT, HOST, () => {
  writePidFile();
  // 启动时把这些写进日志：出了事至少要知道"当时是什么状态"
  logLine(
    'INFO',
    `started pid=${process.pid} port=${PORT} host=${HOST} appDir=${__dirname} node=${process.version} ` +
      `pidFile=${path.basename(PID_FILE_PORT(PORT))}`
  );
  for (const side of manager.list()) {
    const ep0 = side.describeEndpoint();
    const where0 = ep0.ok ? `${ep0.host}:${ep0.port} (pid ${ep0.pid})` : `offline: ${String(ep0.error.message).split('\n')[0]}`;
    logLine('INFO', `side ${side.id} -> ${where0}  [${side.endpointPath}]`);
  }
  logLine('INFO', `listening on http://${HOST}:${PORT}/  log=${LOG_FILE}`);
  // 心跳：进程被外部"干净地回收"时，日志里至少留下最后一次活着的时刻
  const heartbeat = setInterval(() => {
    logLine('INFO', `alive rss=${Math.round(process.memoryUsage().rss / 1048576)}MB uptime=${Math.round(process.uptime())}s`);
  }, 5 * 60 * 1000);
  if (heartbeat.unref) heartbeat.unref();

  console.log('');
  console.log('  dsh-pair is running.');
  console.log(`  UI:  http://${HOST}:${PORT}/`);
  console.log(`  log: ${LOG_FILE}`);
  console.log('  sides:');
  for (const side of manager.list()) {
    const ep = side.describeEndpoint();
    const where = ep.ok ? `${ep.host}:${ep.port} (pid ${ep.pid})` : `offline: ${ep.error.message.split('\n')[0]}`;
    console.log(`    - ${side.id.padEnd(8)} ${where}`);
    console.log(`      ${side.endpointPath}`);
  }
  console.log('');
  console.log('  Close this window to stop it.');
  console.log('');
});

process.on('uncaughtException', (err) => {
  logLine('ERROR', `uncaughtException: ${err && err.stack ? err.stack : err}`);
  // 未捕获异常之后继续跑是不安全的（状态可能已经坏了）；让启动器/看门狗去处理重启
  try {
    removePidFile();
  } catch (e) {
    /* 忽略 */
  }
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logLine('ERROR', `unhandledRejection: ${err && err.stack ? err.stack : err}`);
  console.error('[dsh-pair] unhandled rejection:', err && err.message ? err.message : err);
});
process.on('SIGINT', () => {
  logLine('INFO', 'SIGINT received - shutting down (Ctrl-C or a stop request)');
  console.log('\n[dsh-pair] shutting down');
  removePidFile();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
});
// 被 kill/停止时要清掉 pid 文件，免得留下"看着像在跑"的残留
process.on('SIGTERM', () => {
  logLine('INFO', 'SIGTERM received - shutting down (stop.cmd or a supervisor asked us to)');
  removePidFile();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
});
process.on('exit', (code) => {
  removePidFile();
  try {
    logLine('INFO', `exiting code=${code} uptime=${Math.round(process.uptime())}s`);
  } catch (err) {
    /* 忽略 */
  }
});
