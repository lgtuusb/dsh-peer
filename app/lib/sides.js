/*
 * lib/sides.js —— 两侧连接的统一管理
 * ---------------------------------------------------------------
 * 一个 side = 一个 DSH 实例的 bridge 端点（一个 endpoint.json）。
 * 两侧说同一套 JSON-RPC，所以这里只是把 peer/lib/bridge.js 包一层：
 *   - 懒连接 + 单飞（同一时刻只建一条连接）
 *   - 每次重连都重读 endpoint.json（对方重启后 port/token 会变）
 *   - 失败退避（避免 UI 轮询把连不上的端点打爆）
 *   - 记住最后一次错误，供界面显示"为什么离线"
 *
 * 协议层是复用 ../peer/lib/bridge.js，不重复实现。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Bridge, readEndpoint } = require(path.join(__dirname, '..', '..', 'peer', 'lib', 'bridge.js'));

const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 15000;

/** 默认两侧（可用 app/sides.json 或 --sides 覆盖） */
const DEFAULT_SIDES = [
  {
    id: 'desktop',
    short: 'Desktop',
    label: 'Desktop',
    workspace: '%WORKSPACE_B%',
    // DSH_HOME 用于身份牌显示（"我是谁、家在哪"）。
    // 注意 %DSH_HOME% 只是个壳：它的 sessions/profiles/... 全是指向这个目录的 junction。
    dshHome: path.join(os.homedir(), '.dsh'),
    role: '实现、测试、启动器、前端行为',
    endpointPath: path.join(os.homedir(), '.dsh', 'agents-anywhere', 'bridge', 'endpoint.json')
  },
  {
    id: 'harness',
    short: 'Harness',
    label: 'Harness',
    workspace: '%WORKSPACE_A%',
    dshHome: '%DSH_HOME%',
    role: '设计、协议、复验、文档、打包',
    endpointPath: '%DSH_HOME%\\agents-anywhere\\bridge\\endpoint.json'
  }
];

/** 按 id 找内置默认值（自定义 sides.json 缺字段时用来兜底） */
function builtinSide(id) {
  return DEFAULT_SIDES.find((s) => s.id === id) || null;
}

class AppError extends Error {
  constructor(message, httpStatus, code) {
    super(message);
    this.name = 'AppError';
    this.httpStatus = httpStatus || 500;
    this.code = code || 'app_error';
  }
}

function loadSides(configPath) {
  if (!configPath) return DEFAULT_SIDES.map((s) => Object.assign({}, s));
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new AppError(`读不到 sides 配置：${configPath}（${err.code || err.message}）`, 500, 'bad_sides_config');
  }
  const arr = Array.isArray(raw) ? raw : raw.sides;
  if (!Array.isArray(arr) || !arr.length) {
    throw new AppError(`sides 配置里没有 sides 数组：${configPath}`, 500, 'bad_sides_config');
  }
  return arr.map((s, i) => {
    if (!s || !s.endpointPath) {
      throw new AppError(`sides[${i}] 缺少 endpointPath`, 500, 'bad_sides_config');
    }
    const id = String(s.id || `side${i + 1}`);
    // dshHome / role 是身份牌要显示的，缺了就拿内置默认值补（自定义 sides.json 常常只写端点）
    const fallback = builtinSide(id);
    return {
      id,
      short: String(s.short || s.id || `side${i + 1}`),
      label: String(s.label || s.id || `side${i + 1}`),
      workspace: s.workspace ? String(s.workspace) : null,
      dshHome: s.dshHome ? String(s.dshHome) : (fallback ? fallback.dshHome : null),
      role: s.role ? String(s.role) : (fallback ? fallback.role : null),
      endpointPath: String(s.endpointPath)
    };
  });
}

class Side {
  constructor(cfg) {
    this.id = cfg.id;
    this.short = cfg.short;
    this.label = cfg.label;
    this.workspace = cfg.workspace;
    this.dshHome = cfg.dshHome || null;
    this.role = cfg.role || null;
    this.endpointPath = cfg.endpointPath;

    this.bridge = null;
    this.connecting = null;
    this.identity = null;
    this.lastError = null; // {kind, code, message}
    this.lastAttemptAt = 0;
    this.lastAttemptStamp = undefined;
    this.failCount = 0;
    this.lastOnlineAt = 0;
  }

  get online() {
    return !!(this.bridge && !this.bridge.closed && this.identity);
  }

  backoffMs() {
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.max(0, this.failCount - 1)));
  }

  /** endpoint.json 现状（只读文件，不建连接），给界面显示 port/pid 用 */
  describeEndpoint() {
    try {
      const ep = readEndpoint(this.endpointPath);
      return { ok: true, host: ep.host, port: ep.port, pid: ep.pid, path: ep.path };
    } catch (err) {
      return {
        ok: false,
        path: this.endpointPath,
        error: { kind: err.kind || 'endpoint', message: err.message }
      };
    }
  }

  /** endpoint.json 的指纹：文件被改写（对方重启）就允许立刻重试，不用等退避 */
  endpointStamp() {
    try {
      const st = fs.statSync(this.endpointPath);
      return `${Math.round(st.mtimeMs)}:${st.size}`;
    } catch (err) {
      return `missing:${err.code || 'ERR'}`;
    }
  }

  invalidate() {
    const b = this.bridge;
    this.bridge = null;
    this.identity = null;
    if (b) {
      try {
        b.close();
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  async connect(force) {
    if (this.online && !force) return this.bridge;
    if (this.connecting) return this.connecting;

    // 退避：连不上时别让 UI 的轮询每次都真去连。
    // 但如果 endpoint.json 变了（对方重启后 port/token 会变），立刻放行重试。
    const stamp = this.endpointStamp();
    const endpointChanged = this.lastAttemptStamp !== undefined && stamp !== this.lastAttemptStamp;
    if (
      !force &&
      this.failCount > 0 &&
      !endpointChanged &&
      Date.now() - this.lastAttemptAt < this.backoffMs()
    ) {
      const waitMs = this.backoffMs() - (Date.now() - this.lastAttemptAt);
      const why = this.lastError ? this.lastError.message : '未知原因';
      throw new AppError(
        `${this.short} 离线：${why}\n  还要 ${Math.ceil(waitMs / 1000)}s 才会重试（连续失败 ${this.failCount} 次）`,
        503,
        'offline'
      );
    }

    this.lastAttemptStamp = stamp;
    this.lastAttemptAt = Date.now();
    this.connecting = (async () => {
      const b = new Bridge({
        endpointPath: this.endpointPath,
        diagnostics: () => {},
        requestTimeoutMs: 20000,
        connectTimeoutMs: 5000
      });
      try {
        await b.connect();
        this.bridge = b;
        this.identity = b.identity;
        this.lastError = null;
        this.failCount = 0;
        this.lastOnlineAt = Date.now();
        return b;
      } catch (err) {
        try {
          b.close();
        } catch (e) {
          /* 忽略 */
        }
        this.bridge = null;
        this.identity = null;
        this.failCount++;
        this.lastError = { kind: err.kind || 'internal', code: err.code || null, message: err.message };
        throw err;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  /** 发一个请求；**传输层**失败让连接作废，下次重新读 endpoint.json 再连 */
  async call(method, params) {
    const b = await this.connect();
    try {
      return await b.request(method, params);
    } catch (err) {
      const kind = err.kind || 'internal';
      this.lastError = { kind, code: err.code || null, message: err.message };
      // 业务级错误（JSON-RPC error，kind='protocol'）说明**连接是好的**，只是这个方法失败了
      // —— 比如对端根本不认识 session.createAndStart。
      // 早先这里不分青红皂白地作废连接 + 记一次失败，代价很大：整侧假离线 3 秒起步、
      // 界面闪"离线"、紧随其后的请求全部跟着失败。实测踩过：
      // 点一次"新建会话"（对端不支持）→ Desktop 侧连着 3 秒不可用。
      if (kind !== 'protocol') {
        this.failCount = Math.max(1, this.failCount);
        this.invalidate();
      }
      throw err;
    }
  }

  status() {
    const ep = this.describeEndpoint();
    return {
      id: this.id,
      short: this.short,
      label: this.label,
      workspace: this.workspace,
      dshHome: this.dshHome,
      role: this.role,
      endpointPath: this.endpointPath,
      endpoint: ep,
      online: this.online,
      identity: this.identity
        ? {
            runtime: this.identity.runtime,
            displayName: this.identity.displayName,
            bridgeVersion: this.identity.bridgeVersion,
            runtimeVersion: this.identity.runtimeVersion
          }
        : null,
      error: this.lastError,
      failCount: this.failCount,
      lastOnlineAt: this.lastOnlineAt || null
    };
  }
}

class SideManager {
  constructor(configs) {
    this.order = configs.map((c) => c.id);
    this.sides = new Map(configs.map((c) => [c.id, new Side(c)]));
  }

  get(id) {
    const side = this.sides.get(String(id || ''));
    if (!side) {
      throw new AppError(`未知的 side：${id || '(空)'}（可用：${this.order.join(', ')}）`, 400, 'unknown_side');
    }
    return side;
  }

  list() {
    return this.order.map((id) => this.sides.get(id));
  }

  ids() {
    return this.order.slice();
  }
}

/** 路径归一化，用来比工作区 */
function normPath(p) {
  return String(p || '')
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/** 最近活跃的排前面（Harness那边已经给 session.list 补上了 orderingTime） */
function byRecency(a, b) {
  return String((b && b.orderingTime) || '').localeCompare(String((a && a.orderingTime) || ''));
}

/**
 * 按 side.workspace 过滤会话。
 *
 * 为什么需要：两个 App 的 sessions 目录指向**同一份** junction（RULES/ROADMAP 里记过），
 * 所以 Harness 侧的 session.list 会把 Desktop 的会话也列出来（实测 110 条 vs 1 条）。
 * 每侧的 workspace 我们是知道的，就在这儿过滤。
 *
 * 过滤后为空时**退回不过滤** —— 宁可多显示，也不能把功能弄成"看不到任何会话"。
 */
function filterByWorkspace(side, sessions, includeAll) {
  const total = sessions.length;
  if (includeAll || !side.workspace) return { sessions, filtered: false, total };
  const ws = normPath(side.workspace);
  const mine = sessions.filter((s) => normPath(s.cwd || (s.metadata && s.metadata.cwd)) === ws);
  if (!mine.length) return { sessions, filtered: false, total, noMatch: true };
  return { sessions: mine, filtered: mine.length < total, total };
}

/** 选会话：指定就在全量里找；否则优先本工作区里**最近活跃**的 live 会话 */
async function resolveSession(side, requested, opts) {
  const o = opts || {};
  // 允许调用方把已经取好的全量列表传进来（server.js 为了做去垃圾过滤已经调过 session.list 了，
  // 不传的话同一轮就要打两次桥）
  let sessions;
  if (Array.isArray(o.sessions)) {
    sessions = o.sessions;
  } else {
    const list = await side.call('session.list', {});
    sessions = list && Array.isArray(list.sessions) ? list.sessions : [];
  }
  if (!sessions.length) {
    throw new AppError(`${side.short} 上没有任何会话（session.list 返回空）`, 409, 'no_sessions');
  }

  const visible = filterByWorkspace(side, sessions, o.includeAll);
  const meta = {
    workspaceFiltered: visible.filtered,
    totalSessions: visible.total,
    visibleSessions: visible.sessions.length,
    workspace: side.workspace || null,
    noWorkspaceMatch: visible.noMatch === true
  };

  if (requested) {
    // 显式指定的会话在全量里找（用户明确要看的，哪怕不在本工作区）
    const hit = sessions.find((s) => s.sessionId === requested || s.externalSessionId === requested);
    if (!hit) {
      throw new AppError(
        `在 ${side.short} 上找不到会话：${requested}\n` +
          `  提示：内部 sessionId（sess_dsh_…）每次连接都会变，请用 externalSessionId（session-…）`,
        409,
        'no_such_session'
      );
    }
    return Object.assign({}, hit, meta, {
      offWorkspace: normPath(hit.cwd || (hit.metadata && hit.metadata.cwd)) !== normPath(side.workspace)
    });
  }

  const live = visible.sessions.filter((s) => s.metadata && s.metadata.live === true);
  live.sort(byRecency);

  // 调用方给了"去垃圾后"的候选列表时，直接用它的第一个 ——
  // 默认选中空壳会话正是"消息投错会话"的根因（orderingTime 是创建时间，刚建的空壳排最前）。
  if (o.candidates && o.candidates.length) {
    const pick = o.candidates[0];
    const candLive = o.candidates.filter((s) => s.metadata && s.metadata.live === true).length;
    return Object.assign({}, pick, meta, {
      // ambiguous 的语义是"有多个 live 会话，我只能猜一个"，不是"候选很多" ——
      // 过滤后候选常常有十几个，用候选数当 ambiguous 会让界面永远挂着警告。
      ambiguous: candLive > 1,
      liveCount: candLive,
      pickedBy: 'filtered',
      emptyShellSkipped: true
    });
  }

  const pool = live.length ? live : visible.sessions.slice().sort(byRecency);
  const pick = pool[0];
  return Object.assign({}, pick, meta, { ambiguous: live.length > 1, liveCount: live.length });
}

module.exports = {
  SideManager,
  Side,
  AppError,
  loadSides,
  resolveSession,
  filterByWorkspace,
  normPath,
  byRecency,
  DEFAULT_SIDES
};
