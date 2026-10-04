/*
 * lib/bridge.js —— agents-anywhere bridge 客户端协议层
 * ---------------------------------------------------------------
 * 零依赖，只用 Node 内置模块（net / fs / path / os / crypto）。
 *
 * 负责：读 endpoint.json → TCP 连接 → initialize 握手 → request/超时/通知/关帧保护。
 * 不负责：会话选择策略、等待回合结束、CLI 输出（那些在 peer.js）。
 *
 * 真机事实（见 SPEC.md 第 3 节，以及实测）：
 *   - 换行分隔 JSON-RPC 2.0，单帧上限 8 MiB
 *   - initialize 必须带 authToken；identity.runtime 必须是 "dsh"；protocolVersion 主版本必须是 1
 *   - 服务端会主动推通知（无 id、有 method），客户端必须忽略而不崩
 *   - endpoint.json 每次运行都要重新读：DSH Desktop 重启后 port/token 会变
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const MAX_FRAME_BYTES = 8 * 1024 * 1024; // SPEC 2 节：8 MiB
const DEFAULT_REQUEST_TIMEOUT_MS = 20000; // SPEC 4.3：请求超时默认 20s
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const PROTOCOL_VERSION = '1.0';
const CLIENT_NAME = 'dsh-peer';
const CLIENT_VERSION = '1.0.0';

// 默认 endpoint.json：%USERPROFILE%\.dsh\agents-anywhere\bridge\endpoint.json
const DEFAULT_ENDPOINT_PATH = path.join(
  process.env.USERPROFILE || os.homedir,
  '.dsh',
  'agents-anywhere',
  'bridge',
  'endpoint.json'
);

class BridgeError extends Error {
  constructor(message, opts) {
    super(message);
    this.name = 'BridgeError';
    const o = opts || {};
    this.kind = o.kind || 'internal'; // endpoint|connect|handshake|timeout|frame|protocol|send|noreply|usage|internal
    this.code = o.code; // JSON-RPC 错误码或系统错误码（可能为空）
    this.detail = o.detail;
  }
}

/** 读 endpoint.json。每次都重新读，绝不缓存。 */
function readEndpoint(endpointPath) {
  const file = endpointPath || DEFAULT_ENDPOINT_PATH;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new BridgeError(
      `读不到 endpoint.json：${file}\n  原因：${err.code || err.message}\n` +
        `  这个文件由 DSH Desktop 的 agents-anywhere 插件写入；确认 DSH Desktop 正在运行，` +
        `或用 --endpoint <path> 指定别的位置。`,
      { kind: 'endpoint', code: err.code }
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BridgeError(`endpoint.json 不是合法 JSON：${file}\n  原因：${err.message}`, {
      kind: 'endpoint'
    });
  }

  const host = typeof parsed.host === 'string' && parsed.host ? parsed.host : '127.0.0.1';
  const port = Number(parsed.port);
  const token = parsed.token;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new BridgeError(
      `endpoint.json 里的 port 不合法：${JSON.stringify(parsed.port)}（文件：${file}）` +
        `\n  DSH Desktop 可能正在重启，稍后重试。`,
      { kind: 'endpoint' }
    );
  }
  if (typeof token !== 'string' || !token) {
    throw new BridgeError(`endpoint.json 里没有 token：${file}`, { kind: 'endpoint' });
  }

  return {
    path: file,
    host,
    port,
    token,
    pid: parsed.pid == null ? null : parsed.pid,
    version: parsed.version == null ? null : parsed.version
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Bridge {
  /**
   * @param {object} [opts]
   * @param {string} [opts.endpointPath] endpoint.json 路径
   * @param {number} [opts.requestTimeoutMs] 单次请求超时（默认 20000）
   * @param {number} [opts.connectTimeoutMs] 连接超时
   * @param {(msg:object)=>void} [opts.onNotification] 收到服务端通知时回调（可选）
   * @param {(...a:any[])=>void} [opts.diagnostics] 诊断输出（peer.js 传 stderr 写入器）
   */
  constructor(opts) {
    const o = opts || {};
    this.endpointPath = o.endpointPath || DEFAULT_ENDPOINT_PATH;
    this.requestTimeoutMs = o.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = o.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    this.onNotification = o.onNotification || null;
    this.diagnostics = o.diagnostics || function  {};

    this.endpoint = null;
    this.identity = null;
    this.socket = null;
    this.buffer = '';
    this.seq = 0;
    this.pending = new Map;
    this.closed = false;
    this.notificationCount = 0;
    this.notificationMethods = new Map;
  }

  get target {
    const e = this.endpoint;
    return e ? `${e.host}:${e.port}` : '(unknown)';
  }

  /** 重新读 endpoint.json + 建连 + 握手。每次连接都会重读文件。 */
  async connect {
    this.endpoint = readEndpoint(this.endpointPath); // ← 每次 connect 都重读，不缓存
    await this._openSocket;
    const init = await this.request('initialize', {
      authToken: this.endpoint.token,
      protocolVersion: PROTOCOL_VERSION,
      runtime: 'dsh',
      connectorId: `${CLIENT_NAME}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
      sessionNamespace: `${CLIENT_NAME}-${process.pid}`,
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION }
    });

    const identity = init && init.identity;
    if (!identity || identity.runtime !== 'dsh') {
      throw new BridgeError(
        `握手失败：identity.runtime = ${identity ? JSON.stringify(identity.runtime) : '(缺失)'}，期望 "dsh"` +
          `\n  endpoint：${this.endpoint.path}（${this.target}）`,
        { kind: 'handshake' }
      );
    }
    const pv = String(identity.protocolVersion || init.protocolVersion || '');
    if (pv.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) {
      throw new BridgeError(
        `握手失败：protocolVersion = ${JSON.stringify(pv)}，主版本不是 ${PROTOCOL_VERSION.split('.')[0]}`,
        { kind: 'handshake' }
      );
    }

    this.identity = identity;
    return init;
  }

  async _openSocket {
    const { host, port } = this.endpoint;
    // 断线后重连时必须把 closed 清掉，否则 request 会一直以为连接不可用
    // （实测：对方中途重启 → send --wait 的轮询直接死在"连接不可用"上）
    this.closed = false;
    this.buffer = '';
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      this.socket = socket;
      let settled = false;
      const timer = setTimeout( => {
        if (settled) return;
        settled = true;
        socket.destroy;
        reject(
          new BridgeError(
            `连接 ${host}:${port} 超时（${this.connectTimeoutMs}ms）——端口不通或 DSH Desktop 卡住了。` +
              `\n  endpoint：${this.endpoint.path}`,
            { kind: 'connect', code: 'ETIMEDOUT' }
          )
        );
      }, this.connectTimeoutMs);

      socket.once('connect',  => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve;
      });
      socket.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new BridgeError(
            `连不上 ${host}:${port}（${err.code || err.message}）——DSH Desktop 可能没运行，` +
              `或 endpoint.json 是旧的（重启后 port/token 会变）。` +
              `\n  endpoint：${this.endpoint.path}`,
            { kind: 'connect', code: err.code }
          )
        );
      });
    });

    const socket = this.socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      this._failAll(
        new BridgeError(`连接中断：${err.code || err.message}（${this.target}）`, {
          kind: 'connect',
          code: err.code
        })
      );
      if (!this.closed) this.diagnostics(`[bridge] socket error: ${err.code || err.message}`);
    });
    socket.on('close',  => {
      this.closed = true;
      this._failAll(new BridgeError(`连接已被对端关闭（${this.target}）`, { kind: 'connect' }));
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        this.diagnostics(`[bridge] 忽略无法解析的帧（${line.length} 字符）`);
        continue;
      }
      this._onFrame(frame);
    }
  }

  _onFrame(frame) {
    if (frame && frame.id != null && this.pending.has(frame.id)) {
      const entry = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.error) {
        const e = frame.error;
        entry.reject(
          new BridgeError(`${e.message || 'JSON-RPC error'}${e.code != null ? ` (code ${e.code})` : ''}`, {
            kind: 'protocol',
            code: e.code,
            detail: e.data
          })
        );
      } else {
        entry.resolve(frame.result);
      }
      return;
    }

    if (frame && frame.method) {
      // 服务端主动通知（timeline.itemUpsert / session.turnEnded / notice.upsert …）
      // 未知 method 一律忽略，但记个数方便排查。
      this.notificationCount++;
      this.notificationMethods.set(frame.method, (this.notificationMethods.get(frame.method) || 0) + 1);
      if (this.onNotification) {
        try {
          this.onNotification(frame);
        } catch (err) {
          this.diagnostics(`[bridge] 通知回调抛错（已忽略）：${err.message}`);
        }
      }
      return;
    }
    // 既不是我们要的响应也不是通知：忽略
  }

  _failAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear;
  }

  /** 发一个请求，等它的 result。超时/错误都 reject(BridgeError)。 */
  request(method, params, opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || this.requestTimeoutMs;
    if (!this.socket || this.closed) {
      return Promise.reject(new BridgeError(`连接不可用，无法发送 ${method}`, { kind: 'connect' }));
    }

    const id = `peer-${process.pid}-${++this.seq}-${crypto.randomBytes(3).toString('hex')}`;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const bytes = Buffer.byteLength(frame, 'utf8');
    if (bytes > MAX_FRAME_BYTES) {
      return Promise.reject(
        new BridgeError(
          `拒绝发送：${method} 的帧有 ${bytes} 字节，超过 8 MiB 上限（${MAX_FRAME_BYTES}）`,
          { kind: 'frame' }
        )
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout( => {
        if (this.pending.delete(id)) {
          reject(new BridgeError(`请求超时（${timeoutMs}ms）：${method}`, { kind: 'timeout' }));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(frame + '\n', (err) => {
          if (!err) return;
          if (this.pending.delete(id)) {
            clearTimeout(timer);
            reject(new BridgeError(`写入失败：${err.code || err.message}`, { kind: 'connect', code: err.code }));
          }
        });
      } catch (err) {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new BridgeError(`写入失败：${err.message}`, { kind: 'connect' }));
        }
      }
    });
  }

  /** 发通知（无 id，不等回复） */
  notify(method, params) {
    if (!this.socket || this.closed) {
      throw new BridgeError(`连接不可用，无法发送 ${method}`, { kind: 'connect' });
    }
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} });
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) {
      throw new BridgeError(`拒绝发送：${method} 超过 8 MiB`, { kind: 'frame' });
    }
    this.socket.write(frame + '\n');
  }

  /** 干净关闭：给 socket 一个 flush 的机会，然后销毁；未决请求全部失败。 */
  close {
    if (this.closed && !this.socket) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    this._failAll(new BridgeError('连接已关闭', { kind: 'connect' }));
    if (!socket) return;
    try {
      socket.end;
    } catch (err) {
      /* 忽略 */
    }
    // 兜底：对端不理 end 就强拆
    const t = setTimeout( => {
      try {
        socket.destroy;
      } catch (err) {
        /* 忽略 */
      }
    }, 300);
    if (t.unref) t.unref;
  }

  /** 从 runtime.getCapabilities 里取某个能力的 allowed 值 */
  static capabilityAllowed(caps, capabilityId) {
    const arr = (caps && caps.capabilities) || [];
    const hit = arr.find((c) => c && c.capabilityId === capabilityId);
    return hit ? hit.allowed === true : false;
  }
}

module.exports = {
  Bridge,
  BridgeError,
  readEndpoint,
  sleep,
  DEFAULT_ENDPOINT_PATH,
  MAX_FRAME_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION
};
