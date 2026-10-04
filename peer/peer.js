#!/usr/bin/env node
/*
 * peer.js —— dsh-peer CLI：让两个 DSH 实例互相收发消息
 * ---------------------------------------------------------------
 * 协议层在 lib/bridge.js；这里只做：参数解析 / 会话选择 / 等待回合结束 / 输出。
 *
 * 最重要的约定（SPEC 4.2 第 6 条）：
 *   `send --wait` 的 **stdout 只放对方那段回复正文**（--json 时是 {"ok":true,"reply":…}），
 *   所有诊断信息一律走 stderr。成功退出码 0。
 *
 * 退出码：
 *   0 成功
 *   2 用法/参数错误（含缺 --text、多 live 会话没指定 --session、帧超 8 MiB）
 *   3 endpoint.json 读不到/不合法
 *   4 连接失败 / 握手失败 / 中途断线
 *   5 协议错误（JSON-RPC error）/ 能力不足
 *   6 发送被拒绝（accepted !== true 或 ok:false）
 *   7 等待超时
 *   8 回合结束但拿不到回复正文
 *   9 其他内部错误
 *
 * 用法：node peer.js <status|list|state|read|send|wait|watch> [选项]
 *   --session <id|externalId>  目标会话（省略时取唯一的 live 会话）
 *   --text <s> / --text-file <path>  正文（长中文/换行/emoji 请用 --text-file）
 *   --tail <N>                 read 取最近 N 条（默认 20）
 *   --wait                     发送后等这一轮结束并打印回复
 *   --timeout-ms <N>           等待总超时（默认 600000）
 *   --interval-ms <N>          轮询间隔（默认 1000）
 *   --endpoint <path>          覆盖 endpoint.json 路径
 *   --json                     机器可读输出
 *   --full                     read 里连工具的 output 一起打印
 */
'use strict';

const fs = require('fs');
const util = require('util');
const crypto = require('crypto');
const path = require('path');
const { Bridge, BridgeError, sleep, DEFAULT_ENDPOINT_PATH } = require('./lib/bridge');

const EXIT = {
  OK: 0,
  USAGE: 2,
  ENDPOINT: 3,
  CONNECT: 4,
  PROTOCOL: 5,
  SEND: 6,
  TIMEOUT: 7,
  NOREPLY: 8,
  INTERNAL: 9
};

const KIND_TO_EXIT = {
  endpoint: EXIT.ENDPOINT,
  connect: EXIT.CONNECT,
  handshake: EXIT.CONNECT,
  frame: EXIT.USAGE,
  timeout: EXIT.TIMEOUT,
  protocol: EXIT.PROTOCOL,
  send: EXIT.SEND,
  noreply: EXIT.NOREPLY,
  usage: EXIT.USAGE,
  internal: EXIT.INTERNAL
};

const DEFAULT_WAIT_TIMEOUT_MS = 600000; // SPEC 4.2：默认总超时 10 分钟
const DEFAULT_POLL_INTERVAL_MS = 1000; // SPEC 4.2：轮询间隔 1s
const SNAPSHOT_TAIL = 40; // 每次轮询取的时间线尾巴条数
const NOREPLY_RETRY_MS = 300; // 已 idle 但正文还没投影出来时的补取间隔
const NOREPLY_RETRIES = 6;
// 我们的用户消息已落地、但既没见到 running 也没见到正文时的宽限期（防"瞬间跑完"被漏掉）
const SETTLE_GRACE_MS = 2000;
const CLI_VERSION = '1.0.0';

// ---------------------------------------------------------------- 输出通道
// stdout：命令结果（send --wait 时只有正文）。stderr：一切诊断。
function log(fmt, ...args) {
  try {
    process.stderr.write((args.length ? util.format(fmt, ...args) : fmt) + '\n');
  } catch (err) {
    /* 管道断了就算了 */
  }
}

function out(text) {
  try {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  } catch (err) {
    /* 管道断了就算了 */
  }
}

function outJson(obj) {
  out(JSON.stringify(obj, null, 2));
}

function usageError(message) {
  return new BridgeError(message, { kind: 'usage' });
}

// ---------------------------------------------------------------- 参数解析
const VALUE_OPTS = new Set([
  '--endpoint',
  '--session',
  '--text',
  '--text-file',
  '--tail',
  '--timeout-ms',
  '--interval-ms'
]);
const BOOL_OPTS = new Set(['--json', '--wait', '--full', '--help', '-h']);

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('-')) {
      let name = arg;
      let value = null;
      const eq = arg.indexOf('=');
      if (eq > 1) {
        name = arg.slice(0, eq);
        value = arg.slice(eq + 1);
      }
      if (VALUE_OPTS.has(name)) {
        if (value === null) {
          value = argv[++i];
          if (value === undefined) throw usageError(`选项 ${name} 需要一个值`);
        }
        opts[name] = value;
      } else if (BOOL_OPTS.has(name)) {
        opts[name] = value === null ? true : value !== 'false';
      } else {
        throw usageError(`未知选项：${name}（用 --help 看用法）`);
      }
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function intOption(opts, name, fallback) {
  if (opts[name] === undefined) return fallback;
  const n = Number(opts[name]);
  if (!Number.isFinite(n) || n <= 0) {
    throw usageError(`${name} 需要正整数，收到 ${JSON.stringify(opts[name])}`);
  }
  return Math.floor(n);
}

// ---------------------------------------------------------------- 时间线工具
const seqOf = (item) => Number(item && item.orderSeq) || 0;

function sortBySeq(items) {
  return items.slice().sort((a, b) => seqOf(a) - seqOf(b));
}

function contentText(content) {
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (typeof content.text === 'string') return content.text;
  if (typeof content.markdown === 'string') return content.markdown;
  if (Array.isArray(content.parts)) {
    const joined = content.parts
      .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
      .join('');
    return joined || null;
  }
  return null;
}

/**
 * 只有 type === "message" 的才是对话正文。
 * 真机实测必须排除的坑：reasoning（type=system, kind=reasoning）**也**带 content.text，
 * 那是模型的思考过程，不是回复正文。
 */
function messageText(item) {
  if (!item || item.type !== 'message') return null;
  const text = contentText(item.content);
  return typeof text === 'string' && text.length ? text : null;
}

function lastAssistantMessage(items, afterSeq) {
  const candidates = items.filter(
    (it) => it.type === 'message' && it.role === 'assistant' && seqOf(it) > (afterSeq || 0)
  );
  if (!candidates.length) return null;
  const sorted = sortBySeq(candidates);
  const item = sorted[sorted.length - 1];
  return { text: messageText(item) || '', item, orderSeq: seqOf(item) };
}

function lastUserMessage(items, afterSeq, exactText) {
  const candidates = items.filter(
    (it) => it.type === 'message' && it.role === 'user' && seqOf(it) > (afterSeq || 0)
  );
  const sorted = sortBySeq(candidates);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const text = messageText(sorted[i]);
    if (text === null) continue;
    if (exactText === undefined || exactText === null || text === exactText) return sorted[i];
  }
  return null;
}

function describeSessions(sessions) {
  return sessions
    .map((s) => {
      const live = s.metadata && s.metadata.live ? 'live' : '    ';
      const cwd = s.cwd || (s.metadata && s.metadata.cwd) || '?';
      return `  - [${live}] ${s.externalSessionId || s.sessionId}  ${s.title || '(无标题)'}  cwd=${cwd}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------- 会话选择
async function resolveSession(bridge, requested) {
  const list = await bridge.request('session.list', {});
  const sessions = list && Array.isArray(list.sessions) ? list.sessions : [];
  if (!sessions.length) {
    throw new BridgeError('session.list 返回 0 个会话——DSH Desktop 里当前没有会话。', { kind: 'usage' });
  }

  if (requested) {
    const hit = sessions.find(
      (s) => s.sessionId === requested || s.externalSessionId === requested
    );
    if (!hit) {
      throw usageError(
        `找不到会话：${requested}\n可用会话：\n${describeSessions(sessions)}\n` +
          `提示：内部 sessionId（sess_dsh_…）每次连接都会重新生成，跨命令请一律用 ` +
          `externalSessionId（session-…）。`
      );
    }
    return hit;
  }

  const live = sessions.filter((s) => s.metadata && s.metadata.live === true);
  if (live.length === 1) return live[0];
  if (live.length === 0) {
    throw usageError(
      `没有 live 会话（共 ${sessions.length} 个），必须用 --session 指定：\n${describeSessions(sessions)}`
    );
  }
  throw usageError(
    `有 ${live.length} 个 live 会话，必须用 --session 明确指定（不替你猜）：\n${describeSessions(live)}`
  );
}

async function fetchSnapshot(bridge, sessionId, limit, deadline) {
  const snap = await resilientRequest(bridge, 'session.getSnapshot', { sessionId, limit }, { deadline });
  return {
    raw: snap,
    items: snap && Array.isArray(snap.items) ? sortBySeq(snap.items) : []
  };
}

/**
 * 断线/对端重启期间自愈的请求。
 *
 * 为什么不能只重试一次：对方改插件后必须重启 App，那一瞬间**连接被掐断、
 * endpoint.json 还会短暂消失（ENOENT）**。实测我第二次 send --wait 就是死在这里。
 * 所以这里一直重试到 deadline（= 等待总超时）为止：
 *   - 每次重连都会**重新读 endpoint.json**，所以对端换了 port/token 也能接上；
 *   - 端点文件还没写回来就等下一轮，不再把整个等待判死。
 */
async function resilientRequest(bridge, method, params, opts) {
  const o = opts || {};
  const deadline = o.deadline || Date.now() + 120000;
  const retryDelayMs = o.retryDelayMs || 2000;
  const attempted = new Set();
  for (let attempt = 1; ; attempt++) {
    try {
      return await bridge.request(method, params);
    } catch (err) {
      const kind = err && err.kind;
      if (kind !== 'connect' && kind !== 'endpoint' && kind !== 'timeout') throw err;
      if (Date.now() >= deadline) throw err;
      if (attempt === 1) {
        log(
          `[warn] ${method} 失败（${kind}${kind === 'endpoint' ? '：对端端点文件不在，多半正在重启' : ''}），` +
            `每 ${retryDelayMs}ms 重连重试，直到超时…`
        );
      }
      attempted.add(kind);
      await sleep(retryDelayMs);
      try {
        await bridge.connect(); // 重新读 endpoint.json
      } catch (e) {
        /* 对端还没起来，下一轮再试 */
      }
      if (attempt === 1) log('[info] 重连成功，继续等');
    }
  }
}

// ---------------------------------------------------------------- 等待回合结束
/**
 * 等目标会话这一轮跑完。
 *
 * 判据（SPEC 4.2 第 4 条）：先看到 running 再看到 idle，**或**时间线里出现
 * orderSeq > 基线的助手正文且随后 idle —— 两者满足其一，避免"太快没抓到 running"。
 *
 * 另外做了一件规格没写但更稳的事：如果能在时间线里认出我们刚发的那条用户消息，
 * 就用它的 orderSeq 作为真正的基线，这样即使目标会话当时正在跑别的回合，
 * 也不会把上一轮的正文当成回复。
 */
async function waitForTurnEnd(bridge, opts) {
  const {
    sessionId,
    baselineSeq,
    sentText = null,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    requireProgress = true,
    statusBefore = null
  } = opts;

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let sawRunning = false;
  let polls = 0;
  let sentSeq = null;
  let sentSeqSeenAt = 0;
  let found = null;
  let warnedOwnership = false;

  if (sentText !== null && statusBefore === 'running') {
    log(
      '[warn] 目标会话在发送前就是 running——如果它当时正在跑别的回合，' +
        '下面取到的可能是那一轮的正文（我会尽量用刚发出去的那条用户消息定位）。'
    );
  }

  while (true) {
    polls++;
    const state = await resilientRequest(bridge, 'session.getState', { sessionId }, { deadline });
    const status = state && state.status;
    if (status === 'running') sawRunning = true;

    const { items } = await fetchSnapshot(bridge, sessionId, SNAPSHOT_TAIL, deadline);

    if (sentText !== null && sentSeq === null) {
      const mine = lastUserMessage(items, baselineSeq, sentText);
      if (mine) {
        sentSeq = seqOf(mine);
        sentSeqSeenAt = Date.now();
        log(`[info] 在时间线里定位到刚发出的用户消息：orderSeq=${sentSeq}`);
      }
    }
    const cutoff = sentSeq === null ? baselineSeq : sentSeq;
    const hit = lastAssistantMessage(items, cutoff);
    if (hit) found = hit;

    if (sentText !== null && sentSeq === null && !warnedOwnership) {
      warnedOwnership = true;
      log(
        '[warn] 时间线里还没看到我们刚发的那条用户消息，暂时按基线 orderSeq 判断回复归属。'
      );
    }

    // 收尾判据。
    // 有 sentText（send --wait）时额外要求：**必须先看到我们那条用户消息落地**，
    // 否则目标会话原本就在跑的那个回合结束时，会把上一轮的正文误当成这次的回复。
    // （消息落地了但一直没 running、也没正文时，给一个 2s 宽限期，避免"瞬间跑完"被漏掉。）
    let settled;
    if (sentText !== null) {
      settled =
        status === 'idle' &&
        sentSeq !== null &&
        (sawRunning || found !== null || Date.now() - sentSeqSeenAt >= SETTLE_GRACE_MS);
    } else {
      settled = status === 'idle' && (!requireProgress || sawRunning || found !== null);
    }
    if (settled) {
      // send --wait 必须交出"这一轮的正文"；wait 只是等状态归 idle，本来 idle 时就可能没有新正文。
      if (requireProgress) {
        // 已确认结束，但正文可能还没投影出来：补几次
        for (let attempt = 0; attempt < NOREPLY_RETRIES && (found === null || !found.text); attempt++) {
          await sleep(NOREPLY_RETRY_MS);
          const again = await fetchSnapshot(bridge, sessionId, SNAPSHOT_TAIL, deadline);
          const retryHit = lastAssistantMessage(again.items, cutoff);
          if (retryHit && retryHit.text) found = retryHit;
        }
        if (!found || !found.text) {
          throw new BridgeError(
            `这一轮已经结束（status=idle），但时间线里没有找到 orderSeq > ${cutoff} 的助手正文。` +
              `\n  会话：${sessionId}  轮询 ${polls} 次  用时 ${Date.now() - startedAt}ms` +
              `\n  可能原因：这一轮没有产出文字回复（只调了工具），或者投影还没同步过来。`,
            { kind: 'noreply' }
          );
        }
      }
      return {
        reply: found && found.text ? found.text : null,
        replySeq: found ? found.orderSeq : null,
        status,
        polls,
        sawRunning,
        usedSentSeq: sentSeq !== null,
        elapsedMs: Date.now() - startedAt
      };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      const why =
        sentText !== null && sentSeq === null
          ? `\n  注意：我们发出去的那条用户消息始终没有出现在时间线里——` +
            `这一轮可能还没被调度，或者消息被对端拒了却没报错。`
          : '';
      throw new BridgeError(
        `等待超时（${timeoutMs}ms）：status=${status} 见到过 running=${sawRunning} ` +
          `新正文=${found ? '有' : '无'} 轮询=${polls} 次` +
          `\n  会话：${sessionId}（可用 --timeout-ms 调大）${why}`,
        { kind: 'timeout' }
      );
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------- 各命令
async function cmdStatus(bridge, opts) {
  await bridge.connect();
  const caps = await bridge.request('runtime.getCapabilities', {});
  const sendAllowed = Bridge.capabilityAllowed(caps, 'session.send_message');
  const identity = bridge.identity || {};
  const protocolVersion = identity.protocolVersion || null;
  const ep = bridge.endpoint;

  if (opts['--json']) {
    outJson({
      ok: true,
      endpoint: { path: ep.path, host: ep.host, port: ep.port, pid: ep.pid },
      identity,
      protocolVersion,
      capabilities: (caps && caps.capabilities) || [],
      sendMessageAllowed: sendAllowed,
      features: null
    });
  } else {
    out(`endpoint.file            ${ep.path}`);
    out(`endpoint.target          ${ep.host}:${ep.port}  (pid ${ep.pid == null ? '?' : ep.pid})`);
    out(`identity.runtime         ${identity.runtime}`);
    out(`identity.displayName     ${identity.displayName}`);
    out(`identity.runtimeVersion  ${identity.runtimeVersion}`);
    out(`identity.bridgeVersion   ${identity.bridgeVersion}`);
    out(`protocol.version         ${protocolVersion}`);
    out(`session.send_message.allowed ${sendAllowed}`);
    const capsArr = (caps && caps.capabilities) || [];
    out(`capabilities             ${capsArr.length} 项`);
    for (const c of capsArr) {
      out(`  ${c.capabilityId}  allowed=${c.allowed === true}`);
    }
  }

  if (!sendAllowed) {
    throw new BridgeError('本端能力表里 session.send_message 不是 allowed，无法用这个通道发消息。', {
      kind: 'protocol'
    });
  }
  return EXIT.OK;
}

async function cmdList(bridge, opts) {
  await bridge.connect();
  const list = await bridge.request('session.list', {});
  const sessions = list && Array.isArray(list.sessions) ? list.sessions : [];

  if (opts['--json']) {
    outJson({
      ok: true,
      count: sessions.length,
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        externalSessionId: s.externalSessionId,
        title: s.title,
        cwd: s.cwd || (s.metadata && s.metadata.cwd) || null,
        orderingTime: s.orderingTime == null ? null : s.orderingTime,
        metadata: s.metadata || null
      }))
    });
  } else {
    out(`${sessions.length} 个会话：`);
    for (const s of sessions) {
      const live = s.metadata && s.metadata.live ? 'live' : '    ';
      out(
        `  [${live}] ${s.externalSessionId}  ${s.title || '(无标题)'}  ` +
          `cwd=${s.cwd || (s.metadata && s.metadata.cwd) || '?'}`
      );
    }
  }
  return EXIT.OK;
}

async function cmdState(bridge, opts) {
  await bridge.connect();
  const session = await resolveSession(bridge, opts['--session']);
  const state = await bridge.request('session.getState', { sessionId: session.sessionId });
  const meta = (state && state.metadata) || {};
  const model = meta.modelSelection || {};

  if (opts['--json']) {
    outJson({
      ok: true,
      sessionId: state.sessionId,
      externalSessionId: state.externalSessionId,
      status: state.status,
      cwd: meta.cwd || null,
      model: model.model || null,
      provider: model.provider || null,
      reasoningEffort: model.reasoningEffort || null,
      permission: (meta.permissionPreset && meta.permissionPreset.id) || null,
      readOnly: meta.readOnly === true,
      attached: meta.attached === true,
      observedAt: (state.sourceState && state.sourceState.observedAt) || null,
      state
    });
  } else {
    out(`sessionId          ${state.sessionId}`);
    out(`externalSessionId  ${state.externalSessionId}`);
    out(`status             ${state.status}`);
    out(`cwd                ${meta.cwd || '?'}`);
    out(`model              ${model.provider || '?'}:${model.model || '?'} (${model.reasoningEffort || '?'})`);
    out(`permission         ${(meta.permissionPreset && meta.permissionPreset.id) || '?'}`);
    out(`title              ${session.title || '(无标题)'}`);
  }
  return EXIT.OK;
}

async function cmdRead(bridge, opts) {
  await bridge.connect();
  const session = await resolveSession(bridge, opts['--session']);
  const tail = intOption(opts, '--tail', 20);
  const { raw, items } = await fetchSnapshot(bridge, session.sessionId, tail);
  const withFull = opts['--full'] === true;

  const projection = items.map((it) => {
    const content = it.content || {};
    const text = messageText(it);
    const row = {
      orderSeq: seqOf(it),
      id: it.id,
      turnId: it.turnId || null,
      type: it.type || null,
      role: it.role || null,
      status: it.status || null,
      kind: content.kind || null,
      toolName: content.toolName || null,
      isError: content.isError === true
    };
    if (text !== null) {
      row.text = text;
      row.chars = text.length;
    }
    if (it.type === 'tool') {
      const output = typeof content.output === 'string' ? content.output : '';
      row.outputChars = output.length;
      if (withFull) row.output = output;
    }
    return row;
  });

  if (opts['--json']) {
    outJson({
      ok: true,
      sessionId: raw && raw.sessionId,
      externalSessionId: raw && raw.externalSessionId,
      count: projection.length,
      returned: projection.length,
      nextCursor: (raw && raw.nextCursor) || null,
      complete: raw ? raw.complete !== false : null,
      items: projection
    });
  } else {
    out(`${session.title || '(无标题)'}  ${session.externalSessionId}  最近 ${projection.length} 条：`);
    for (const row of projection) {
      const preview =
        row.text !== undefined
          ? row.text.replace(/\s+/g, ' ').slice(0, 100)
          : row.type === 'tool'
            ? `${row.toolName || ''} (output ${row.outputChars} 字符)`
            : '';
      out(
        `  [${String(row.orderSeq).padStart(5)}] ${(row.role || '-').padEnd(9)} ` +
          `${(row.type || '-').padEnd(8)} ${(row.kind || '-').padEnd(11)} ${preview}`
      );
    }
  }
  return EXIT.OK;
}

function resolveText(opts) {
  const file = opts['--text-file'];
  if (file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8'); // 逐字符原样发送（含换行/BOM），保证字节一致
    } catch (err) {
      throw usageError(`读不到 --text-file：${file}\n  原因：${err.code || err.message}`);
    }
    if (!text.length) throw usageError(`--text-file 是空文件：${file}`);
    return { text, source: file };
  }
  if (typeof opts['--text'] === 'string') {
    if (!opts['--text'].length) throw usageError('--text 是空字符串');
    return { text: opts['--text'], source: '--text' };
  }
  throw usageError(
    '需要 --text <正文> 或 --text-file <路径>。\n' +
      '  长中文/换行/引号/emoji 请务必用 --text-file，命令行传参容易被引号和编码搞坏。'
  );
}

async function cmdSend(bridge, opts) {
  const { text } = resolveText(opts);
  const timeoutMs = intOption(opts, '--timeout-ms', DEFAULT_WAIT_TIMEOUT_MS);
  const intervalMs = intOption(opts, '--interval-ms', DEFAULT_POLL_INTERVAL_MS);
  const wantWait = opts['--wait'] === true;

  await bridge.connect();
  const session = await resolveSession(bridge, opts['--session']);
  log(`[info] 目标会话 ${session.externalSessionId}  ${session.title || '(无标题)'}`);

  let baselineSeq = 0;
  let statusBefore = null;
  if (wantWait) {
    const state = await bridge.request('session.getState', { sessionId: session.sessionId });
    statusBefore = state && state.status;
    const { items } = await fetchSnapshot(bridge, session.sessionId, 1);
    baselineSeq = items.length ? seqOf(items[items.length - 1]) : 0;
    log(`[info] 基线：status=${statusBefore} 最后 orderSeq=${baselineSeq}`);
  }

  const clientMessageId = crypto.randomUUID();
  const result = await bridge.request('session.startTurn', {
    sessionId: session.sessionId,
    content: text,
    clientMessageId
  });

  // SPEC 3.3：失败不抛异常，而是 {ok:false, code, message}
  if (result && result.ok === false) {
    throw new BridgeError(
      `发送被拒绝：${result.code || 'unknown'} ${result.message || ''}`.trim(),
      { kind: 'send', code: result.code, detail: result.result }
    );
  }
  if (!result || result.accepted !== true) {
    throw new BridgeError(`发送被拒绝（accepted !== true）：${JSON.stringify(result)}`, {
      kind: 'send'
    });
  }
  log(
    `[info] 已投递 ${text.length} 字符，clientMessageId=${clientMessageId} ` +
      `session=${result.sessionId || session.sessionId}`
  );

  if (!wantWait) {
    if (opts['--json']) {
      outJson({
        ok: true,
        accepted: true,
        sessionId: result.sessionId || session.sessionId,
        externalSessionId: result.externalSessionId || session.externalSessionId,
        clientMessageId,
        chars: text.length
      });
    } else {
      out(
        `accepted  session=${result.externalSessionId || session.externalSessionId}  ` +
          `chars=${text.length}  (未等待回复；加 --wait 会等这一轮跑完并打印回复)`
      );
    }
    return EXIT.OK;
  }

  log(`[info] 等这一轮结束（超时 ${timeoutMs}ms，轮询 ${intervalMs}ms）…`);
  const done = await waitForTurnEnd(bridge, {
    sessionId: session.sessionId,
    baselineSeq,
    sentText: text,
    timeoutMs,
    intervalMs,
    statusBefore
  });
  log(
    `[info] 回合结束：用时 ${done.elapsedMs}ms 轮询 ${done.polls} 次 ` +
      `回复 orderSeq=${done.replySeq} 归属定位=${done.usedSentSeq ? '按发出的用户消息' : '按基线'}`
  );

  // ↓↓↓ stdout 只放正文 / 结果 JSON，别的什么都不许加 ↓↓↓
  if (opts['--json']) {
    outJson({
      ok: true,
      reply: done.reply,
      sessionId: session.sessionId,
      externalSessionId: session.externalSessionId,
      orderSeq: done.replySeq,
      chars: done.reply.length,
      elapsedMs: done.elapsedMs,
      polls: done.polls
    });
  } else {
    out(done.reply);
  }
  return EXIT.OK;
}

async function cmdWait(bridge, opts) {
  const timeoutMs = intOption(opts, '--timeout-ms', DEFAULT_WAIT_TIMEOUT_MS);
  const intervalMs = intOption(opts, '--interval-ms', DEFAULT_POLL_INTERVAL_MS);
  await bridge.connect();
  const session = await resolveSession(bridge, opts['--session']);
  const { items } = await fetchSnapshot(bridge, session.sessionId, 1);
  const baselineSeq = items.length ? seqOf(items[items.length - 1]) : 0;
  log(`[info] 等 ${session.externalSessionId} 变成 idle（基线 orderSeq=${baselineSeq}）…`);

  // wait 的语义：现在在跑就等它跑完，本来就 idle 就立刻返回
  const done = await waitForTurnEnd(bridge, {
    sessionId: session.sessionId,
    baselineSeq,
    sentText: null,
    timeoutMs,
    intervalMs,
    requireProgress: false
  });

  const latest = lastAssistantMessage(
    (await fetchSnapshot(bridge, session.sessionId, SNAPSHOT_TAIL)).items,
    0
  );
  if (opts['--json']) {
    outJson({
      ok: true,
      status: done.status,
      sessionId: session.sessionId,
      externalSessionId: session.externalSessionId,
      elapsedMs: done.elapsedMs,
      polls: done.polls,
      reply: latest ? latest.text : null,
      replyOrderSeq: latest ? latest.orderSeq : null,
      replyIsFromThisWait: done.replySeq != null
    });
  } else {
    out(`status=${done.status} 用时 ${done.elapsedMs}ms 轮询 ${done.polls} 次`);
    if (latest) out(`最近一条助手正文（orderSeq ${latest.orderSeq}）：\n${latest.text}`);
  }
  return EXIT.OK;
}

async function cmdWatch(bridge, opts) {
  const intervalMs = intOption(opts, '--interval-ms', 2000);
  await bridge.connect();
  const session = await resolveSession(bridge, opts['--session']);
  const { items } = await fetchSnapshot(bridge, session.sessionId, 1);
  let lastSeq = items.length ? seqOf(items[items.length - 1]) : 0;
  log(`[info] 轮询监听 ${session.externalSessionId}（每 ${intervalMs}ms，从 orderSeq ${lastSeq} 之后开始；Ctrl-C 退出）`);

  if (!opts['--json']) {
    out(`watching ${session.externalSessionId} from orderSeq ${lastSeq}`);
  }
  let stopping = false;
  const onSigint = () => {
    stopping = true;
    log('[info] 收到 SIGINT，正在关闭…');
    bridge.close();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  while (!stopping) {
    await sleep(intervalMs);
    const snap = await fetchSnapshot(bridge, session.sessionId, SNAPSHOT_TAIL);
    for (const item of snap.items) {
      if (seqOf(item) <= lastSeq) continue;
      lastSeq = seqOf(item);
      const text = messageText(item);
      const content = item.content || {};
      if (opts['--json']) {
        out(
          JSON.stringify({
            orderSeq: seqOf(item),
            type: item.type || null,
            role: item.role || null,
            kind: content.kind || null,
            toolName: content.toolName || null,
            text: text === null ? null : text
          })
        );
      } else if (text !== null) {
        out(`[${seqOf(item)}] ${item.role}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
      } else {
        out(`[${seqOf(item)}] ${item.role}/${item.type} ${content.kind || ''} ${content.toolName || ''}`);
      }
    }
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------- 入口
function usageText() {
  return `dsh-peer ${CLI_VERSION} —— 通过 agents-anywhere bridge 跟另一个 DSH 实例收发消息

用法：
  node peer.js status                              # 握手 + 打印 identity / 能力表
  node peer.js list                                # 列出会话
  node peer.js state  [--session <id|extId>]       # 会话状态（status 是 idle|running）
  node peer.js read   [--session <id>] [--tail N]  # 最近 N 条时间线（默认 20）
  node peer.js send   [--session <id>] (--text <s> | --text-file <path>) [--wait]
  node peer.js wait   [--session <id>] [--timeout-ms N]
  node peer.js watch  [--session <id>] [--interval-ms N]

通用选项：
  --endpoint <path>   覆盖 endpoint.json（默认 ${DEFAULT_ENDPOINT_PATH}）
  --json              机器可读输出（send --wait 时 stdout 是 {"ok":true,"reply":…}）
  --full              read 时连工具 output 一起输出
  --timeout-ms <N>    等待超时，默认 600000（10 分钟）
  --interval-ms <N>   轮询间隔，默认 1000

send --wait 的 stdout 只有对方回复正文（--json 时是那段 JSON），诊断信息全在 stderr。
退出码：0 成功 / 2 用法 / 3 endpoint / 4 连接 / 5 协议 / 6 发送被拒 / 7 超时 / 8 拿不到正文 / 9 内部`;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log(`错误：${err.message}`);
    return EXIT.USAGE;
  }

  const command = opts._[0];
  if (!command || opts['--help'] || command === 'help') {
    out(usageText());
    return EXIT.OK;
  }

  const known = ['status', 'list', 'state', 'read', 'send', 'wait', 'watch'];
  if (!known.includes(command)) {
    log(`未知命令：${command}\n\n${usageText()}`);
    return EXIT.USAGE;
  }

  const bridge = new Bridge({
    endpointPath: opts['--endpoint'],
    diagnostics: log,
    requestTimeoutMs: 20000
  });

  const onSigint = () => {
    log('[info] 收到 SIGINT，关闭连接…');
    bridge.close();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  try {
    switch (command) {
      case 'status':
        return await cmdStatus(bridge, opts);
      case 'list':
        return await cmdList(bridge, opts);
      case 'state':
        return await cmdState(bridge, opts);
      case 'read':
        return await cmdRead(bridge, opts);
      case 'send':
        return await cmdSend(bridge, opts);
      case 'wait':
        return await cmdWait(bridge, opts);
      case 'watch':
        return await cmdWatch(bridge, opts);
      default:
        return EXIT.USAGE;
    }
  } finally {
    bridge.close();
    process.removeListener('SIGINT', onSigint);
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      // 让 stdout 冲干净再退：socket/定时器都已 unref 或清掉，事件循环会自己结束
    })
    .catch((err) => {
      const kind = err instanceof BridgeError ? err.kind : 'internal';
      const code = KIND_TO_EXIT[kind] || EXIT.INTERNAL;
      log(`错误：${err && err.message ? err.message : err}`);
      if (!(err instanceof BridgeError)) {
        log(err && err.stack ? err.stack : '');
      }
      process.exitCode = code;
    });
}

module.exports = { main, EXIT, KIND_TO_EXIT, parseArgs, waitForTurnEnd, messageText, lastAssistantMessage };
