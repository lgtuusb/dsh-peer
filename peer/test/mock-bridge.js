/*
 * test/mock-bridge.js —— 假 agents-anywhere bridge 服务端
 * ---------------------------------------------------------------
 * 按 SPEC.md 第 3 节的真机事实实现，用于离线跑完整验收路径：
 * 握手 / 能力表 / session.list / getState / getSnapshot / startTurn / 通知 / 错误。
 * 测试可以随时改 state.* 来模拟"运行中→空闲""ok:false""静默不答"等情况。
 */
'use strict';

const fs = require('fs');
const net = require('net');

const DEFAULT_SESSION = {
  sessionId: 'sess_<id>',
  externalSessionId: 'session-test-0001',
  title: '测试会话',
  cwd: '%WORKSPACE_B%',
  orderingTime: 1,
  metadata: { live: true, persisted: true, readOnly: false }
};

function createMockBridge(options) {
  const opts = options || {};
  const sessions = opts.sessions || [DEFAULT_SESSION];

  const state = {
    token: opts.token || 'test-token',
    sendAllowed: opts.sendAllowed !== false,
    sessions,
    status: opts.status || 'idle',
    items: (opts.items || []).slice,
    startTurnResult: opts.startTurnResult || null,
    // 新建会话（session.createAndStart）：成功结果可覆盖，失败可用 createAndStartError 注入
    createAndStartResult: opts.createAndStartResult || null,
    createAndStartError: null,
    created: [],
    // session.meta（会话体积/最后写入时间）：metaOf(id) -> {bytes,lastWrite} | null
    metaOf: opts.metaOf || null,
    metaError: null,
    metaCalls: [],
    onStartTurn: opts.onStartTurn || null,
    onSnapshot: opts.onSnapshot || null,
    notifications: opts.notifications || [],
    silence: new Set(opts.silence || []),
    calls: [],
    received: [],
    sockets: new Set,
    nextSeq: (opts.items || []).reduce((m, it) => Math.max(m, Number(it.orderSeq) || 0), 0) + 1
  };

  function appendItem(item) {
    const withSeq = Object.assign({ orderSeq: state.nextSeq++ }, item);
    state.items.push(withSeq);
    return withSeq;
  }

  function reply(socket, id, result) {
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
  function replyError(socket, id, code, message) {
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }

  function handle(socket, method, params, id) {
    state.calls.push({ method, params });
    if (state.silence.has(method)) return; // 永不回复 → 触发客户端超时

    switch (method) {
      case 'initialize':
        if (params && params.authToken !== state.token) {
          replyError(socket, id, -32001, 'invalid authToken');
          return;
        }
        reply(socket, id, {
          identity: {
            runtime: 'dsh',
            runtimeVersion: '0.1.2-rc.1',
            bridgeVersion: '0.1.0-dev.0',
            protocolVersion: '1.0',
            displayName: 'DeepSeek Harness (mock)'
          },
          storage: { mode: 'dsh-native', sameSessionWriterLimit: 1, crossProcessWriterExclusion: false },
          features: {
            attachments: true,
            sessionDiscovery: true,
            timelineSuffixRead: false,
            approval: false,
            userQuestions: true,
            readOnly: false,
            snapshotPagination: true,
            syncMode: 'events',
            projectionVersion: 2
          }
        });
        return;

      case 'ping':
        reply(socket, id, { ok: true });
        return;

      case 'runtime.getCapabilities':
        reply(socket, id, {
          capabilities: [
            { capabilityId: 'session.send_message', allowed: state.sendAllowed },
            { capabilityId: 'session.read', allowed: true },
            { capabilityId: 'session.interrupt', allowed: true }
          ]
        });
        return;

      case 'workspace.list':
        reply(socket, id, { workspaces: [{ id: 'ws-1', title: 'mock', path: '%WORKSPACE_B%', sessionIds: sessions.map((s) => s.sessionId) }] });
        return;

      case 'session.list':
        reply(socket, id, { sessions: state.sessions });
        return;

      case 'session.getState': {
        const wanted = (params && (params.sessionId || params.externalSessionId)) || null;
        const sess =
          state.sessions.find((s) => s.sessionId === wanted || s.externalSessionId === wanted) ||
          state.sessions[0];
        reply(socket, id, {
          runtime: 'dsh',
          sessionId: sess.sessionId,
          externalSessionId: sess.externalSessionId,
          sourceState: { availability: 'available', reason: null, observedAt: new Date.toISOString },
          status: state.status,
          selections: { model: 'dsh:model:mock', permission: 'dsh:permission:mock' },
          metadata: {
            cwd: sess.cwd || '%WORKSPACE_B%',
            modelSelection: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
            permissionPreset: { id: 'danger-full-access' },
            readOnly: false,
            attached: true
          }
        });
        return;
      }

      case 'session.getSnapshot': {
        // 测试钩子：在返回快照**之前**可以让测试往时间线里塞条目。
        // 用它来复现"两次轮询之间对方产出了一大堆东西"（B5 的空洞场景），
        // 比用 setTimeout 更确定（真机上是虚拟时钟，定时器对不齐）。
        if (state.onSnapshot) {
          try {
            state.onSnapshot(params, { state, appendItem });
          } catch (err) {
            /* 测试回调抛错不该影响 mock 进程 */
          }
        }
        const wanted = (params && params.sessionId) || null;
        const sess =
          state.sessions.find((s) => s.sessionId === wanted || s.externalSessionId === wanted) ||
          state.sessions[0];
        const limit = params && Number(params.limit) > 0 ? Number(params.limit) : 20;
        const sorted = state.items.slice.sort((a, b) => (a.orderSeq || 0) - (b.orderSeq || 0));
        reply(socket, id, {
          sessionId: sess.sessionId,
          externalSessionId: sess.externalSessionId,
          runtime: 'dsh',
          items: sorted.slice(Math.max(0, sorted.length - limit)),
          complete: true,
          snapshotComplete: true,
          nextCursor: null,
          watermark: state.items.length ? state.items[state.items.length - 1].orderSeq : 0,
          metadata: { cwd: sess.cwd || '%WORKSPACE_B%' }
        });
        return;
      }

      case 'session.startTurn': {
        state.received.push({
          content: params && params.content,
          clientMessageId: params && params.clientMessageId,
          sessionId: params && params.sessionId
        });
        if (state.startTurnResult) {
          reply(socket, id, state.startTurnResult);
          return;
        }
        const sess =
          state.sessions.find((s) => s.sessionId === (params && params.sessionId)) || state.sessions[0];
        reply(socket, id, {
          accepted: true,
          sessionId: sess.sessionId,
          externalSessionId: sess.externalSessionId
        });
        if (state.onStartTurn) {
          try {
            state.onStartTurn(params, { state, appendItem, send: (m) => reply(socket, m.id, m.result) });
          } catch (err) {
            /* 测试回调抛错不该影响 mock 进程 */
          }
        }
        return;
      }

      // 新建会话。与官方一致：**不带 sessionId**（还没有会话 id），但要带 cwd。
      case 'session.createAndStart': {
        state.received.push({
          content: params && params.content,
          clientMessageId: params && params.clientMessageId,
          sessionId: null,
          cwd: params && params.cwd,
          method: 'session.createAndStart'
        });
        if (state.createAndStartError) {
          replyError(socket, id, state.createAndStartError.code, state.createAndStartError.message);
          return;
        }
        if (state.createAndStartResult) {
          reply(socket, id, state.createAndStartResult);
          return;
        }
        const n = state.created.length + 1;
        const sess = {
          sessionId: `sess_<id>${n}`,
          externalSessionId: `session-created-${n}`,
          title: `新会话 ${n}`,
          cwd: (params && params.cwd) || opts.createdCwd || '%WORKSPACE_B%',
          orderingTime: Date.now,
          metadata: { live: true, persisted: true, readOnly: false }
        };
        state.sessions.unshift(sess);
        state.created.push(sess);
        reply(socket, id, { accepted: true, sessionId: sess.sessionId, externalSessionId: sess.externalSessionId });
        if (state.onStartTurn) {
          try {
            state.onStartTurn(params, { state, appendItem, send: (m) => reply(socket, m.id, m.result) });
          } catch (err) {
            /* 测试回调抛错不该影响 mock 进程 */
          }
        }
        return;
      }

      // 会话体积/最后写入时间。Harness那边真机上是从共享的会话库里 stat 出来的。
      case 'session.meta': {
        const want = (params && params.ids) || [];
        state.metaCalls.push(want.slice);
        if (state.metaError) {
          replyError(socket, id, state.metaError.code, state.metaError.message);
          return;
        }
        const meta = {};
        if (state.metaOf) {
          for (const one of want) {
            let m = null;
            try {
              m = state.metaOf(one);
            } catch (err) {
              m = null;
            }
            if (m) meta[one] = m;
          }
        }
        reply(socket, id, { meta });
        return;
      }

      default:
        replyError(socket, id, -32601, `method not found: ${method}`);
    }
  }

  const server = net.createServer((socket) => {
    state.sockets.add(socket);
    socket.setEncoding('utf8');
    for (const n of state.notifications) socket.write(JSON.stringify(n) + '\n');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch (err) {
          continue;
        }
        if (frame && frame.id != null) handle(socket, frame.method, frame.params, frame.id);
      }
    });
    socket.on('error',  => {});
    socket.on('close',  => state.sockets.delete(socket));
  });

  return {
    state,
    appendItem,
    listen {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1',  => {
          state.port = server.address.port;
          state.host = '127.0.0.1';
          resolve(state.port);
        });
      });
    },
    close {
      for (const s of state.sockets) {
        try { s.destroy; } catch (err) { /* 忽略 */ }
      }
      return new Promise((resolve) => server.close( => resolve));
    }
  };
}

/** 写一份 endpoint.json（模拟 DSH Desktop 重启后 port/token 变化） */
function writeEndpoint(file, mock, override) {
  const o = override || {};
  const payload = {
    version: 1,
    host: mock.state.host || '127.0.0.1',
    port: o.port != null ? o.port : mock.state.port,
    token: o.token != null ? o.token : mock.state.token,
    pid: o.pid != null ? o.pid : 4242
  };
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return payload;
}

/** 造一条时间线条目（字段照真机：type/role/content.kind/content.text） */
function item(overrides) {
  return Object.assign(
    {
      id: 'dsh_mock_' + Math.random.toString(16).slice(2),
      sessionId: DEFAULT_SESSION.sessionId,
      type: 'message',
      status: 'done',
      role: 'assistant',
      turnId: 'turn-mock',
      revision: 1,
      contentHash: 'sha256:mock',
      content: { kind: 'markdown', format: 'markdown', text: '' }
    },
    overrides
  );
}

module.exports = { createMockBridge, writeEndpoint, item, DEFAULT_SESSION };
