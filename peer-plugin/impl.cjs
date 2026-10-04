'use strict'
/**
 * dsh-peer-bridge · 实现（CommonJS，可热改）
 *
 * 为什么是 .cjs 而不是直接写进 index.js：
 *   宿主会缓存 ESM 模块，改了 index.js 必须重启整个 App 才生效（已踩坑）。
 *   所以 index.js 只做一个稳定的引导器，真正的实现放在这里，
 *   由引导器用 createRequire + 清 require.cache 的方式每次重新加载 —— 
 *   以后改这个文件，只要让插件重新 apply 一次就能生效，不用重启 App。
 */

const { createServer } = require('node:net')
const { randomBytes, randomUUID } = require('node:crypto')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const PROTOCOL_VERSION = '1.0'
const MAX_FRAME = 8 * 1024 * 1024
const DSH_HOME = process.env.DSH_HOME || join(homedir, '.dsh')
// 独立的端点文件：**不跟 DSH 自带的官方桥抢 endpoint.json**。
// 官方桥不支持新建会话/会话元数据，一旦它抢赢了端点，客户端就点不动"新建"。
// 所以本插件的端点评到 endpoint.peer.json，客户端读这个文件。
// （实测：Desktop那侧新建会话 502，根因就是官方桥占着 endpoint.json）
const ENDPOINT_PATH = join(DSH_HOME, 'agents-anywhere', 'bridge', 'endpoint.peer.json')
// 兼容：老客户端还在读 endpoint.json，所以两个都写（peer 是权威，json 是兼容）
const ENDPOINT_COMPAT_PATH = join(DSH_HOME, 'agents-anywhere', 'bridge', 'endpoint.json')

const say = (m) => { try { console.log('[dsh-peer-bridge] ' + m) } catch { /* ignore */ } }

function rpcErr(code, message, bridgeCode, retryable) {
  const e = new Error(message)
  e.rpcCode = code
  e.bridgeCode = bridgeCode
  e.retryable = Boolean(retryable)
  return e
}

// 解析权限预设：既接受裸名字，也接受官方编码形式 dsh:permission:<base64>
function decodePreset(value) {
  if (typeof value !== 'string' || !value) return null
  const prefix = 'dsh:permission:'
  if (value.startsWith(prefix)) {
    try { return Buffer.from(value.slice(prefix.length), 'base64').toString('utf8') } catch { return null }
  }
  return value
}

function apply(ctx) {
  const svc = (n) => { try { return ctx.get(n) } catch { return undefined } }

  const textOf = (content) =>
    Array.isArray(content)
      ? content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
      : typeof content === 'string' ? content : ''

  function eventsToItems(events) {
    const items = []
    for (const e of events || []) {
      const seq = typeof e.seq === 'number' ? e.seq : items.length
      const data = e.data || {}
      if (e.type === 'user/message') {
        // 只保留用户真正发出的消息。runtime-context / skill-catalog 这类是
        // DSH 内部注入的 user-role 消息（环境快照、技能清单），不该进时间线
        // —— 官方桥也是这么过滤的。
        if (data.source && data.source.kind && data.source.kind !== 'user') continue
        const text = textOf(data.content)
        if (text) items.push({ orderSeq: seq, type: 'message', role: 'user', status: 'done', content: { kind: 'text', text } })
      } else if (e.type === 'assistant/message') {
        const text = textOf(data.message && data.message.content)
        if (text) items.push({ orderSeq: seq, type: 'message', role: 'assistant', status: 'done', content: { kind: 'markdown', text } })
      } else if (e.type === 'tool/call') {
        items.push({ orderSeq: seq, type: 'tool', role: 'assistant', status: 'done', content: { kind: 'tool_call', toolName: data.name || '?', input: data.arguments } })
      }
    }
    return items
  }

  async function readEvents(id) {
    const sessions = svc('sessions')
    const live = sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined
    if (live && typeof live.snapshotEvents === 'function') return live.snapshotEvents
    const query = svc('sessionQuery')
    if (!query) throw rpcErr(-32001, 'sessionQuery 服务不可用', 'UNSUPPORTED_OPERATION')
    const log = await query.readSession(id)
    return (log && log.events) || []
  }

  async function listSessions {
    const query = svc('sessionQuery')
    if (!query) throw rpcErr(-32001, 'sessionQuery 服务不可用', 'UNSUPPORTED_OPERATION')
    const entries = await query.listSessions
    const sessions = svc('sessions')
    const registry = svc('workspaceRegistry')
    const archived = (registry && registry.archivedSessionIds) || null
    const out = []
    for (const entry of entries || []) {
      const header = entry.header || {}
      if (!header.id) continue
      // 排除子代理会话与归档会话（官方侧栏也是这么过滤的）
      if (header.origin === 'subagent') continue
      if (archived && typeof archived.has === 'function' && archived.has(header.id)) continue
      const live = sessions && typeof sessions.get === 'function' ? sessions.get(header.id) : undefined

      // ---- 过滤：客户端下拉只显示"真正在用的会话" ----
      // ① 子代理会话不上下拉
      if (Number(header.delegationDepth || 0) > 0) continue
      // ② 空壳会话（建了从没用过）不上下拉。
      //    实测空壳约 15KB（只有系统提示词），真正聊过的至少几百 KB。
      //    但正在跑的一律保留 —— 用户可能刚开一个新会话正在用。
      const bytes = sessionBytes(header.id)
      _sizeCache[header.id] = bytes
      // 空壳过滤，但**刚动过的会话一律保留**：
      // 用户点"新建"建出来的会话也是空的，一旦被过滤掉，界面就会报"找不到"。
      const w = sessionLastWrite(header.id)
      const justTouched = w && (Date.now - w) < 10 * 60 * 1000
      if (bytes < EMPTY_SESSION_BYTES && !justTouched) continue

      out.push({
        runtime: 'dsh',
        sessionId: header.id,
        externalSessionId: header.id,
        title: header.title || null,
        cwd: header.cwd || null,
        // 客户端要靠它选"最近活跃"的会话。
        // ⚠️ 这里必须用「最后活跃时间」，不能用 createdAt ——
        // 用创建时间的话，刚建的空会话会排在最前面，客户端会默认选中它，
        // 于是用户发的消息全投进一个没人看的空会话。
        orderingTime: (function  {
          // 优先级：会话文件真实写入时间 > header 里的更新字段 > createdAt
          const w = sessionLastWrite(header.id)
          if (w) return new Date(w).toISOString
          const t = header.updatedAt || header.lastActiveAt || header.lastMessageAt
            || header.modifiedAt || header.lastUsedAt || header.updated_at
            || header.createdAt
          return t ? new Date(t).toISOString : null
        }),
        // aa_ 前缀 = 经 Agents Anywhere 桥（手机端）创建的会话。它们是真实历史
        // （有的几千条记录），不隐藏，只给客户端一个标记好分组/标注。
        kind: header.id.startsWith('aa_') ? 'agents-anywhere' : 'native',
        metadata: { live: Boolean(live), readOnly: false, sizeBytes: _sizeCache[header.id] || 0 }
      })
    }
    // 只留最近活跃的若干个：需求下拉只显示在用的会话，历史的不显示。
    // 排序依据是会话文件的真实写入时间（createdAt 会让刚建的空壳排到最前）。
    out.sort(function (a, b) {
      return String(b.orderingTime || '').localeCompare(String(a.orderingTime || ''))
    })
    return out.slice(0, 12)
  }



  // 会话的总体积（该会话目录下所有文件之和）。
  // 用途：区分"真正聊过的会话"和"建了就扔的空壳" ——
  // 空壳只有 ~15KB（基本只有系统提示词），聊过的至少几百 KB。
  const _sizeCache = Object.create(null)

  function sessionBytes(sessionId) {
    try {
      const fs = require('node:fs')
      const path = require('node:path')
      const home = process.env.DSH_HOME || ''
      if (!home) return 0
      const root = path.join(home, 'sessions')
      if (!fs.existsSync(root)) return 0
      let total = 0
      for (const ws of fs.readdirSync(root)) {
        const dir = path.join(root, ws, sessionId)
        let files
        try { files = fs.readdirSync(dir) } catch { continue }
        for (const f of files) {
          try { total += fs.statSync(path.join(dir, f)).size } catch { /* 忽略 */ }
        }
      }
      return total
    } catch { return 0 }
  }

  // 空会话阈值：低于这个字节数视为"从没用过"，不在客户端下拉里显示
  const EMPTY_SESSION_BYTES = 32 * 1024
  // 会话的「最后活跃时间」= 会话目录里最新那个文件的 mtime。
  // header 里没有可靠的更新时间字段（实测 updatedAt 等都不存在，只能退回 createdAt），
  // 而 createdAt 会让"刚建的空会话"排在真正在用的会话前面 —— 客户端就会选错。
  function sessionLastWrite(sessionId) {
    try {
      const fs = require('node:fs')
      const path = require('node:path')
      const home = process.env.DSH_HOME || process.env.HOME || ''
      if (!home) return null
      const root = path.join(home, 'sessions')
      if (!fs.existsSync(root)) return null
      let best = 0
      for (const ws of fs.readdirSync(root)) {
        const dir = path.join(root, ws, sessionId)
        let files
        try { files = fs.readdirSync(dir) } catch { continue }
        for (const f of files) {
          try {
            const m = fs.statSync(path.join(dir, f)).mtimeMs
            if (m > best) best = m
          } catch { /* 忽略 */ }
        }
      }
      return best > 0 ? best : null
    } catch { return null }
  }
  function sessionStatus(id) {
    const agents = svc('agents')
    const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined
    if (agent && typeof agent.status === 'string') return agent.status
    return 'idle'
  }

  async function getSnapshot(id, limit) {
    const events = await readEvents(id)
    const items = eventsToItems(events)
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 50
    return {
      runtime: 'dsh',
      sessionId: id,
      externalSessionId: id,
      items: items.slice(-n),
      complete: true,
      snapshotComplete: true,
      metadata: { total: items.length }
    }
  }

  async function startTurn(params, create) {
    let sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim : ''
    const content = typeof params.content === 'string' ? params.content : ''
    const clientMessageId = typeof params.clientMessageId === 'string' && params.clientMessageId
      ? params.clientMessageId
      : randomUUID

    if (!content.trim) throw rpcErr(-32602, '需要 content', 'INVALID_PARAMS')

    // 新建会话：createAndStart 与 startTurn 的唯一差别 —— 先建一个空会话再往下走。
    // 用的是 DSH 内部的 sessionController.create({ cwd })，真机验证返回
    //   { sessionId: 'session-xxx', agentPreset: 'standard' }
    // （曾经这里是个 throw 空壳，客户端点了新建直接报错 ）
    if (create && !sessionId) {
      const creator = svc('sessionController')
      if (!creator || typeof creator.create !== 'function') {
        throw rpcErr(-32001, 'sessionController.create 不可用（无法新建会话）', 'UNSUPPORTED_OPERATION')
      }
      const opts = {}
      const wantCwd = typeof params.cwd === 'string' && params.cwd.trim ? params.cwd.trim : ''
      if (wantCwd) opts.cwd = wantCwd
      let created
      try {
        created = await creator.create(opts)
      } catch (e) {
        throw rpcErr(-32003, '新建会话失败：' + String(e && e.message || e), 'INTERNAL_ERROR')
      }
      sessionId = created && created.sessionId ? String(created.sessionId) : ''
      if (!sessionId) throw rpcErr(-32003, '新建会话失败：DSH 没有返回 sessionId', 'INTERNAL_ERROR')
    }

    if (!sessionId) throw rpcErr(-32602, '需要 sessionId', 'INVALID_PARAMS')

    const controller = svc('sessionController')
    if (!controller) throw rpcErr(-32001, 'sessionController 服务不可用（无法发消息）', 'UNSUPPORTED_OPERATION')

    const found = await controller.resolveAgent(sessionId)
    if (found && found.error) throw rpcErr(-32002, 'DSH 无法激活该会话', 'SESSION_NOT_FOUND')
    const agent = found && found.agent
    if (!agent) throw rpcErr(-32002, '会话不可用', 'SESSION_NOT_FOUND')

    // 权限预设：不设置的话，新会话用 DSH 默认的 approval/policy=ask，
    // 而桥上没有任何审批应答者，回合会立刻以 turn/end reason=blocked 结束
    // （消息进了 inbox，但 agent 一步都走不动）。官方桥在创建会话时强制要求
    // 指定预设，就是为了避开这个。
    let appliedPreset = null
    const presets = svc('permissionPresets')
    if (presets) {
      const names = Array.isArray(presets.names) ? presets.names : []
      let want = decodePreset(params.selections && params.selections.permission)
      if (!want) {
        let isNew = true
        try {
          const evs = await readEvents(sessionId)
          isNew = !evs.some((e) => e && e.type === 'turn/start')
        } catch { /* 读不到就当作新会话 */ }
        if (isNew) want = names.includes('danger-full-access') ? 'danger-full-access' : names[0]
      }
      if (want && names.includes(want)) {
        try { presets.set(agent.session, want); appliedPreset = want }
        catch (e) { throw rpcErr(-32001, '设置权限预设失败: ' + e.message, 'DSH_SERVICE_UNAVAILABLE', true) }
      }
    }

    // 官方 prompt 内部会调 signal.throwIfAborted，必须传一个 AbortSignal，
    // 否则报 "Cannot read properties of undefined (reading 'throwIfAborted')"。
    const signal = new AbortController.signal

    await controller.prompt({
      sessionId,
      requestId: clientMessageId,
      mode: 'queue',
      content: [{ type: 'text', text: content }]
    }, signal)

    try {
      const sessions = svc('sessions')
      if (sessions && typeof sessions.flush === 'function' && agent.session) await sessions.flush(agent.session)
    } catch { /* flush 失败不影响消息已入队 */ }

    return { accepted: true, sessionId, externalSessionId: sessionId, clientMessageId, permission: appliedPreset }
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'ping': return { ok: true }
      case 'session.list': return { sessions: await listSessions }
      case 'session.meta': {
        // 批量取会话的"真实体积 + 最后写入时间"。
        // 因为两个实例共用同一份会话库（junction），所以**跨侧也能算** ——
        // 客户端可以拿它统一过滤两侧的会话列表（官方桥不提供这两个字段）。
        const ids = Array.isArray(params && params.ids) ? params.ids : []
        const meta = Object.create(null)
        for (const id of ids.slice(0, 500)) {
          if (typeof id !== 'string' || !id) continue
          const w = sessionLastWrite(id)
          meta[id] = { bytes: sessionBytes(id), lastWrite: w ? new Date(w).toISOString : null }
        }
        return { meta }
      }
      case 'session.getState': {
        const id = params.sessionId || params.externalSessionId
        if (!id) throw rpcErr(-32602, '需要 sessionId', 'INVALID_PARAMS')
        const agents = svc('agents')
        const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined
        const meta = agent && agent.session && agent.session.header ? agent.session.header : {}
        return {
          runtime: 'dsh', sessionId: id, externalSessionId: id,
          status: sessionStatus(id),
          sourceState: { availability: 'available', reason: null },
          metadata: { cwd: meta.cwd || null, readOnly: false, attached: Boolean(agent) }
        }
      }
      case 'session.getSnapshot': {
        const id = params.sessionId || params.externalSessionId
        if (!id) throw rpcErr(-32602, '需要 sessionId', 'INVALID_PARAMS')
        return await getSnapshot(id, params.limit)
      }
      case 'session.startTurn': return await startTurn(params, false)
      case 'session.createAndStart': return await startTurn(params, true)
      case 'session.interrupt': {
        const id = params.sessionId || params.externalSessionId
        const agents = svc('agents')
        const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined
        if (!agent) throw rpcErr(-32002, '会话不可用', 'SESSION_NOT_FOUND')
        if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
        return { accepted: true, sessionId: id, externalSessionId: id }
      }
      case 'catalog.listPermissions': {
        const service = svc('permissionPresets')
        if (!service) throw rpcErr(-32001, 'permissionPresets 服务不可用', 'UNSUPPORTED_OPERATION')
        return {
          runtime: 'dsh', revision: 1,
          permissions: (service.names || []).map((preset) => {
            const option = service.optionOf(preset) || {}
            return { id: 'dsh:permission:' + Buffer.from(preset, 'utf8').toString('base64'), title: option.name || preset, selectionId: preset, description: option.description || '', enabled: true, metadata: { preset } }
          })
        }
      }
      case 'runtime.getCapabilities':
        return {
          runtime: 'dsh', revision: 1,
          capabilities: [
            { capabilityId: 'session.send_message', runtime: 'dsh', scope: 'runtime', supported: true, available: Boolean(svc('sessionController')), allowed: Boolean(svc('sessionController')) },
            { capabilityId: 'session.interrupt', runtime: 'dsh', scope: 'runtime', supported: true, available: Boolean(svc('agents')), allowed: Boolean(svc('agents')) }
          ]
        }
      default:
        throw rpcErr(-32601, '未知方法: ' + method, 'METHOD_NOT_FOUND')
    }
  }

  let token = null
  let server = null
  const connections = new Set

  function handleConnection(socket) {
    connections.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let authed = false

    const write = (obj) => {
      try {
        const line = JSON.stringify(obj) + '\n'
        if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) return
        socket.write(line)
      } catch { /* ignore */ }
    }
    const fail = (id, err) => write({
      jsonrpc: '2.0', id,
      error: { code: err.rpcCode || -32603, message: err.message, data: { code: err.bridgeCode || 'INTERNAL_ERROR', retryable: Boolean(err.retryable) } }
    })

    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > MAX_FRAME) { socket.destroy; return }
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.trim) continue
        let msg
        try { msg = JSON.parse(line) } catch {
          write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'PARSE_ERROR', data: { code: 'PARSE_ERROR', retryable: false } } })
          continue
        }
        if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') continue
        const id = msg.id === undefined ? null : msg.id
        const params = msg.params && typeof msg.params === 'object' ? msg.params : {}

        if (msg.method === 'initialize') {
          if (params.authToken !== token) { fail(id, rpcErr(-32000, '认证失败', 'UNAUTHORIZED')); continue }
          authed = true
          write({
            jsonrpc: '2.0', id,
            result: {
              identity: { runtime: 'dsh', runtimeVersion: '0.1.2-rc.1', bridgeVersion: 'dsh-peer-bridge-1.0.0', protocolVersion: PROTOCOL_VERSION, displayName: 'DeepSeek Harness (peer bridge)' },
              storage: { mode: 'dsh-native', sameSessionWriterLimit: 1, crossProcessWriterExclusion: false },
              features: { attachments: false, sessionDiscovery: true, timelineSuffixRead: false, approval: false, userQuestions: false, readOnly: false, snapshotPagination: false, syncMode: 'poll', projectionVersion: 1 }
            }
          })
          continue
        }

        if (!authed) { fail(id, rpcErr(-32000, '请先 initialize', 'UNAUTHORIZED')); continue }
        if (id === null) continue

        dispatch(msg.method, params).then(
          (result) => write({ jsonrpc: '2.0', id, result }),
          (err) => fail(id, err)
        )
      }
    })
    socket.on('error',  => { /* client disconnect is normal */ })
    socket.on('close',  => connections.delete(socket))
  }

  function start {
    token = randomBytes(32).toString('base64url')
    server = createServer(handleConnection)
    server.on('error', (e) => say('TCP error: ' + e.message))
    server.listen(0, '127.0.0.1',  => {
      const port = server.address.port
      try {
        mkdirSync(join(DSH_HOME, 'agents-anywhere', 'bridge'), { recursive: true })
        const payload = JSON.stringify({ version: 1, host: '127.0.0.1', port, token, pid: process.pid })
        writeFileSync(ENDPOINT_PATH, payload)
        try { writeFileSync(ENDPOINT_COMPAT_PATH, payload) } catch { /* 兼容文件写不了不影响主流程 */ }
        say('listening 127.0.0.1:' + port + ' -> ' + ENDPOINT_PATH)
      } catch (e) {
        say('write endpoint failed: ' + e.message)
      }
    })
  }

  function stop {
    try { for (const s of connections) s.destroy } catch { /* ignore */ }
    connections.clear
    try { if (server) server.close } catch { /* ignore */ }
    server = null
    try { rmSync(ENDPOINT_PATH, { force: true }) } catch { /* ignore */ }
  }

  ctx.effect( => {
    try { start } catch (e) { say('start failed: ' + e.message) }
    return  => stop
  }, 'dsh-peer-bridge: loopback JSON-RPC endpoint')
}

module.exports = { apply }
