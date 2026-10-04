/*
 * app.js —— dsh-pair 前端（原生 JS，无框架、无 CDN）
 * ---------------------------------------------------------------
 * 两个 pane，一个输入框：可以只发给某一边，也可以两边都发。
 * 数据全靠轮询后端 /api/timeline：一次请求同时拿到"新条目 + status(idle|running)"。
 *
 * 两条硬规矩：
 *   1. 绝不 innerHTML 插入正文 —— agent 的输出是不可信文本，一律 textContent。
 *   2. 连不上的一侧不能拖垮另一侧：每边独立轮询、独立报错、离线时降频。
 */
'use strict';

(function () {
  const TOKEN = window.__PAIR_TOKEN__;
  const POLL_ONLINE_MS = 1000;
  const POLL_OFFLINE_MS = 5000;
  const SIDES_REFRESH_MS = 6000;
  const IDENTITY_MS = 5000;
  const IDENTITY_LS_KEY = 'dsh-pair.identity.collapsed';
  const TAIL = 30;
  const BACKFILL_TAIL = 200; // 发现空洞时拉更大的窗口（服务端上限也是 200）
  const BACKFILL_TRIES = 3;
  const DOM_CAP = 300; // 单个会话最多保留多少条 DOM 节点，超了从最老开始丢

  const el = {
    panes: document.getElementById('panes'),
    targets: document.getElementById('targets'),
    input: document.getElementById('input'),
    send: document.getElementById('send-btn'),
    refresh: document.getElementById('refresh-btn'),
    topStatus: document.getElementById('top-status'),
    hint: document.getElementById('composer-hint'),
    identityBar: document.getElementById('identity-bar'),
    identityToggle: document.getElementById('identity-toggle'),
    identityCards: document.getElementById('identity-cards')
  };

  const state = {
    sides: [],
    panes: new Map(),
    target: 'both',
    sending: false,
    backend: { down: false, since: 0, lastError: null, info: null },
    identity: { sides: [], error: null, collapsed: readCollapsed() }
  };

  // 身份牌条收起状态：记在 localStorage（刷新后保持）
  function readCollapsed() {
    try {
      const v = localStorage.getItem(IDENTITY_LS_KEY);
      return v === null ? true : v === '1'; // 默认收起：需求它原来占一整行
    } catch (err) {
      return true; // localStorage 不可用（隐私模式等）不该炸
    }
  }

  function writeCollapsed(v) {
    try {
      localStorage.setItem(IDENTITY_LS_KEY, v ? '1' : '0');
    } catch (err) {
      /* 忽略 */
    }
  }

  // ---------------------------------------------------------------- 后端存活
  // 区分两种情况：
  //   - fetch 直接失败 → **后端没了**（进程挂了/被回收），这是全局故障；
  //   - 有 HTTP 响应但 ok:false → 后端活着，只是某一侧/某个参数有问题。
  // 后端挂了以后用户只看到连不上的界面，所以这里要给出"去哪儿看原因"。
  async function loadBackendInfo() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) state.backend.info = await res.json();
    } catch (err) {
      /* 后端还没起来，算了 */
    }
  }

  function markBackendDown(err) {
    if (!state.backend.down) {
      state.backend.down = true;
      state.backend.since = Date.now();
    }
    state.backend.lastError = err && err.message ? err.message : String(err);
    renderTopStatus();
  }

  function markBackendUp() {
    if (!state.backend.down) return;
    state.backend.down = false;
    state.backend.lastError = null;
    renderTopStatus();
  }

  // ---------------------------------------------------------------- 后端调用
  async function api(pathname, opts) {
    const options = Object.assign({}, opts || {});
    options.headers = Object.assign({ 'x-dsh-pair': TOKEN }, options.headers || {});
    let res;
    try {
      res = await fetch(pathname, options);
    } catch (err) {
      markBackendDown(err);
      throw new Error(`后端连不上：${err && err.message ? err.message : err}`);
    }
    markBackendUp();
    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(`后端返回了非 JSON（HTTP ${res.status}）`);
    }
    if (!res.ok || data.ok === false) {
      const error = new Error(data.message || `HTTP ${res.status}`);
      error.payload = data;
      throw error;
    }
    return data;
  }

  function hint(text, isError) {
    el.hint.textContent = text || '';
    el.hint.className = 'composer-hint' + (isError ? ' error' : '');
  }

  function timeLabel(ms) {
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
    } catch (err) {
      return '';
    }
  }

  // ---------------------------------------------------------------- 建 pane
  function ensurePane(side) {
    if (state.panes.has(side.id)) return state.panes.get(side.id);

    const root = document.createElement('section');
    root.className = 'pane';
    root.dataset.side = side.id;

    const head = document.createElement('header');
    head.className = 'pane-head';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.dataset.state = 'offline';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = side.label;

    const ws = document.createElement('span');
    ws.className = 'ws';
    ws.textContent = side.workspace || '';

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.dataset.state = 'offline';
    pill.textContent = '连接中';

    const select = document.createElement('select');
    select.className = 'session-select';
    select.title = '选择会话';

    const interrupt = document.createElement('button');
    interrupt.className = 'ghost';
    interrupt.type = 'button';
    interrupt.textContent = '打断';
    interrupt.title = '打断这一轮';
    interrupt.disabled = true;

    // 新建会话。桥那边是 createAndStart —— **建了就开始跑**，所以会花 token，
    // 提示里必须写清楚，别让用户以为只是"开个空白标签页"。
    const newBtn = document.createElement('button');
    newBtn.className = 'ghost';
    newBtn.type = 'button';
    newBtn.textContent = '＋新建';
    newBtn.title = '在这一侧新建一个会话；会立刻跑一轮（消耗 token）';

    // 两侧的 sessions 目录是同一份，过滤掉不属于本工作区的会话；点它切"全部"
    const scopeBtn = document.createElement('button');
    scopeBtn.className = 'ghost';
    scopeBtn.type = 'button';
    scopeBtn.dataset.role = 'scope';
    scopeBtn.textContent = '仅本工作区';
    scopeBtn.title = '点一下切换：只显示本工作区的会话 / 显示全部（含其他工作区）';

    head.append(dot, name, ws, spacer, scopeBtn, select, newBtn, pill, interrupt);

    const sub = document.createElement('div');
    sub.className = 'pane-sub';

    // 任务检测行：状态 + 跑到第几步 + 当前在干什么 + 跑了多久（用户要"看到对方在跑任务"）
    const activity = document.createElement('div');
    activity.className = 'act-line';
    activity.dataset.state = 'idle';

    const stream = document.createElement('div');
    stream.className = 'stream';

    const thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.textContent = '正在思考';
    thinking.hidden = true;
    stream.appendChild(thinking);

    root.append(head, sub, activity, stream);
    el.panes.appendChild(root);

    const pane = {
      side,
      root,
      dot,
      pill,
      name, // refreshSides 要用它更新标题
      ws, // refreshSides 要用它更新工作区
      scopeBtn,
      select,
      newBtn,
      interrupt,
      sub,
      activity,
      stream,
      thinking,
      items: new Set(),
      pending: [],
      lastSeq: 0,
      lastTool: null, // 最近一次工具调用的"在干什么"
      runningSince: null, // 进入 running 的时刻（本地计时）
      session: null,
      sessionsSig: '',
      includeAll: false, // false = 只显示本工作区的会话
      status: null,
      online: true,
      lastError: null,
      timer: null,
      pollInFlight: false
    };

    select.addEventListener('change', () => {
      pane.session = select.value || null;
      resetStream(pane, `已切到会话 ${pane.session}`);
      pollPane(pane);
    });

    scopeBtn.addEventListener('click', () => {
      pane.includeAll = !pane.includeAll;
      scopeBtn.textContent = pane.includeAll ? '全部会话' : '仅本工作区';
      pane.sessionsSig = '';
      resetStream(pane, pane.includeAll ? '已切到「全部会话」（含其他工作区）' : '只显示本工作区的会话');
      pollPane(pane);
    });

    newBtn.addEventListener('click', async () => {
      newBtn.disabled = true;
      hint(`正在让 ${pane.side.short} 新建会话…`, false);
      try {
        const res = await api('/api/sessions/new', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ side: pane.side.id })
        });
        // 立刻把这一栏切到新会话。**先切再轮询**：不然下一轮轮询会把选中项拉回旧会话。
        pane.session = res.externalSessionId;
        pane.sessionsSig = ''; // 强制重建下拉，让新会话立刻出现
        resetStream(pane, `已新建会话 ${res.externalSessionId}`);
        hint(`${pane.side.short} 新会话已建好（${res.externalSessionId}）`, false);
        pollPane(pane);
      } catch (err) {
        hint(`新建失败：${err.message.split('\n')[0]}`, true);
      } finally {
        newBtn.disabled = false;
      }
    });

    interrupt.addEventListener('click', async () => {
      interrupt.disabled = true;
      try {
        await api('/api/interrupt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ side: pane.side.id, session: pane.session || undefined })
        });
        hint(`已请求打断 ${pane.side.short}`);
      } catch (err) {
        hint(`打断失败：${err.message.split('\n')[0]}`, true);
      }
      pollPane(pane);
    });

    state.panes.set(side.id, pane);
    return pane;
  }

  function resetStream(pane, note) {
    pane.items = new Set();
    pane.pending = [];
    pane.lastSeq = 0;
    pane.lastTool = null;
    pane.runningSince = null;
    pane.stream.replaceChildren(pane.thinking);
    if (note) {
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = note;
      pane.stream.insertBefore(div, pane.thinking);
    }
  }

  function clearPlaceholder(pane) {
    const ph = pane.stream.querySelector('.empty');
    if (ph) ph.remove();
  }

  function insertNode(pane, node) {
    clearPlaceholder(pane);
    pane.stream.insertBefore(node, pane.thinking);
    enforceDomCap(pane);
  }

  /**
   * 单个会话的 DOM 上限：聊很久以后节点会越堆越多（滚动、重排都会变慢）。
   * 超了就从最老的开始摘掉，并在顶部留一行说明 —— 历史还在，切走再切回来能重新看到。
   * 只复用已有类名（.act），不新增 class（样式归Harness）。
   */
  function enforceDomCap(pane) {
    const nodes = Array.from(pane.stream.children).filter((n) => n !== pane.thinking && n !== pane.trimmedNote);
    if (nodes.length <= DOM_CAP) return;
    for (const n of nodes.slice(0, nodes.length - DOM_CAP)) n.remove();
    if (!pane.trimmedNote) {
      pane.trimmedNote = document.createElement('div');
      pane.trimmedNote.className = 'act';
      pane.trimmedNote.textContent = `⋯ 更早的消息已从界面上收起（历史上限 ${DOM_CAP} 条；切走再切回可重新加载）`;
    }
    if (pane.trimmedNote.parentNode !== pane.stream) {
      pane.stream.insertBefore(pane.trimmedNote, pane.stream.firstChild);
    }
  }

  function renderItem(pane, row) {
    if (row.type === 'turn.end') {
      // 异常结束的回合必须看得见：被权限挡下时回合会静默结束，界面上否则什么都没有
      const div = document.createElement('div');
      div.className = 'notice';
      const why = row.reasonKind || '未知原因';
      div.textContent = `⚠ 这一轮没有正常结束（${why}）——常见原因是会话权限预设需要审批，而桥上没有审批应答者；可在会话里改用 danger-full-access 预设。`;
      return div;
    }
    if (row.type === 'tool') {
      const div = document.createElement('div');
      div.className = 'act';
      div.dataset.error = row.isError ? 'true' : 'false';
      const label = row.toolName || row.kind || 'tool';
      const size = row.outputChars ? ` · ${row.outputChars} 字符` : '';
      const when = timeLabel(row.time);
      div.textContent = `⚙ ${label}${row.title && row.title !== label ? ' · ' + row.title : ''}${size}${when ? ' · ' + when : ''}`;
      return div;
    }
    if (row.type === 'message') {
      const div = document.createElement('div');
      div.className = 'msg ' + (row.role === 'user' ? 'user' : 'assistant');
      div.textContent = row.text; // ← 不可信文本，只走 textContent
      const meta = document.createElement('div');
      meta.className = 'meta';
      const who = row.role === 'user' ? '我' : pane.side.short;
      const when = timeLabel(row.time);
      meta.textContent = `${who}${when ? ' · ' + when : ''} · #${row.orderSeq}`;
      div.appendChild(meta);
      return div;
    }
    return null; // 回合边界之类不显示
  }

  function isNearBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }

  function scrollToBottom(node) {
    node.scrollTop = node.scrollHeight;
  }

  // ---------------------------------------------------------------- 状态显示
  const STATUS_TEXT = { idle: '空闲', running: '正在跑', offline: '离线' };

  function setStatus(pane, status) {
    const safe = status === 'running' ? 'running' : status === 'idle' ? 'idle' : 'offline';
    const was = pane.status;
    pane.status = safe;
    pane.dot.dataset.state = safe;
    pane.pill.dataset.state = safe;
    pane.pill.textContent = STATUS_TEXT[safe] || safe;
    pane.thinking.hidden = safe !== 'running';
    pane.interrupt.disabled = safe !== 'running';
    if (pane.newBtn) pane.newBtn.disabled = safe === 'offline';

    if (safe === 'running' && was !== 'running') pane.runningSince = Date.now();
    if (safe !== 'running') pane.runningSince = null;
    // 跑完提醒一次（只在 running → idle 的那一下，不会每轮都响）
    if (was === 'running' && safe === 'idle') notifyFinished(pane);

    renderActivity(pane);
    renderTopStatus();
  }

  // ---------------------------------------------------------------- 任务检测行
  function fmtDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
  }

  function renderActivity(pane) {
    const line = pane.activity;
    if (!line) return;
    const running = pane.status === 'running';
    line.dataset.state = running ? 'running' : 'idle';
    line.replaceChildren();

    const badge = document.createElement('span');
    badge.className = 'act-step';
    badge.textContent = running ? '▶' : '✓';

    const what = document.createElement('span');
    what.className = 'act-what';
    const parts = [running ? '跑着' : '空闲'];
    if (pane.lastSeq) parts.push(`第 ${pane.lastSeq} 步`);
    if (running) {
      if (pane.lastTool) parts.push(pane.lastTool);
      if (pane.runningSince) parts.push(fmtDuration(Date.now() - pane.runningSince));
    } else if (pane.lastTool) {
      parts.push(`上次：${pane.lastTool}`);
    }
    what.textContent = parts.join(' · ');
    if (pane.lastTool) what.title = pane.lastTool;

    line.append(badge, what);
  }

  const BASE_TITLE = document.title;
  let titleTimer = null;
  function flashTitle(text) {
    try {
      document.title = `${text} · ${BASE_TITLE}`;
      clearTimeout(titleTimer);
      titleTimer = setTimeout(() => {
        document.title = BASE_TITLE;
      }, 8000);
    } catch (err) {
      /* 忽略 */
    }
  }

  function notifyFinished(pane) {
    const what = `${pane.side.short} 跑完了`;
    hint(`${what}（第 ${pane.lastSeq} 步）`, false);
    flashTitle(`✓ ${what}`);
  }

  function showPaneError(pane, message) {
    const first = String(message).split('\n').slice(0, 2).join(' ');
    if (pane.lastError === first) return;
    pane.lastError = first;
    pane.sub.replaceChildren();
    const span = document.createElement('span');
    span.className = 'err';
    span.textContent = `⚠ ${first}`;
    pane.sub.appendChild(span);
  }

  function showPaneInfo(pane, data) {
    pane.lastError = null;
    pane.sub.replaceChildren();
    const info = document.createElement('span');
    const ep = pane.side.endpoint && pane.side.endpoint.ok
      ? `${pane.side.endpoint.host}:${pane.side.endpoint.port}`
      : pane.side.endpointPath;
    const ident = pane.side.identity ? pane.side.identity.bridgeVersion : '';
    info.textContent = `${ep}${ident ? ' · ' + ident : ''}`;
    pane.sub.appendChild(info);

    const d = data || {};
    if (d.workspaceFiltered && d.totalSessions) {
      const hidden = document.createElement('span');
      hidden.textContent = `已按工作区过滤：共 ${d.totalSessions} 个会话，只显示本区的 ${d.sessions.length} 个（点上面切换）`;
      pane.sub.appendChild(hidden);
    } else if (d.noWorkspaceMatch && d.totalSessions) {
      const none = document.createElement('span');
      none.textContent = `本工作区没有会话（${d.workspace || '?'}），暂显示全部 ${d.totalSessions} 个`;
      pane.sub.appendChild(none);
    }
    const phone = (d.sessions || []).filter((s) => s.kind === 'agents-anywhere').length;
    if (phone) {
      const tag = document.createElement('span');
      tag.textContent = `📱 手机端历史 ${phone} 个（不隐藏，只标记）`;
      pane.sub.appendChild(tag);
    }
    if (d.session && d.session.offWorkspace) {
      const off = document.createElement('span');
      off.textContent = '当前会话不在本工作区（你手动选的）';
      pane.sub.appendChild(off);
    }
  }

  function renderTopStatus() {
    el.topStatus.replaceChildren();

    // 后端整个挂了时候的横幅：这是全局故障，比单侧离线更要紧，所以放最前面
    if (state.backend.down) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const info = state.backend.info || {};
      const where = info.port ? `127.0.0.1:${info.port}` : '本机后端';
      const log = info.logPath ? ` 日志：${info.logPath}` : '';
      chip.textContent = `⚠ 后端已停止（${where}）—— 双击 app\\start-app.cmd 重新启动。${log}`;
      chip.title = `最后一次错误：${state.backend.lastError || 'fetch failed'}`;
      el.topStatus.appendChild(chip);
    }

    for (const pane of state.panes.values()) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.dataset.state = pane.status || 'offline';
      const text = document.createElement('span');
      text.textContent = `${pane.side.short}: ${STATUS_TEXT[pane.status] || '未知'}`;
      chip.append(dot, text);
      el.topStatus.appendChild(chip);
    }
  }

  // ---------------------------------------------------------------- 轮询
  function schedulePane(pane) {
    clearTimeout(pane.timer);
    pane.timer = setTimeout(() => pollPane(pane), pane.online ? POLL_ONLINE_MS : POLL_OFFLINE_MS);
  }

  async function pollPane(pane) {
    if (pane.pollInFlight) return;
    pane.pollInFlight = true;
    try {
      const params = new URLSearchParams({ side: pane.side.id, after: String(pane.lastSeq), tail: String(TAIL) });
      if (pane.session) params.set('session', pane.session);
      if (pane.includeAll) params.set('all', '1');
      let data = await api('/api/timeline?' + params.toString());

      // 有空洞（两轮之间对方产出超过 tail 条）就拉大窗口补回来，别让消息凭空消失
      if (data.gap) {
        for (let i = 0; i < BACKFILL_TRIES && data.gap; i++) {
          const p2 = new URLSearchParams({ side: pane.side.id, after: String(pane.lastSeq), tail: String(BACKFILL_TAIL) });
          if (pane.session) p2.set('session', pane.session);
          if (pane.includeAll) p2.set('all', '1');
          console.warn('dsh-pair: timeline gap detected, backfilling with tail=' + BACKFILL_TAIL);
          data = await api('/api/timeline?' + p2.toString());
        }
        if (data.gap) {
          // 极端情况（一秒内几百条）：如实告诉用户，不假装完整
          showPaneError(pane, '消息太密集，有一段没能在界面里完整显示；点右上角「刷新会话」可重新加载这一屏');
        }
      }

      pane.online = true;
      applySessions(pane, data);

      const stick = isNearBottom(pane.stream);
      for (const row of data.items) {
        if (pane.items.has(row.orderSeq)) continue;
        pane.items.add(row.orderSeq);
        if (row.orderSeq > pane.lastSeq) pane.lastSeq = row.orderSeq;
        // 记下"最近一次工具调用在干什么"，任务检测行要显示它
        if (row.type === 'tool') {
          const label = row.toolName || row.kind || 'tool';
          pane.lastTool = row.inputHint ? `${label} ${row.inputHint}` : label;
        }
        const node = renderItem(pane, row);
        if (node) insertNode(pane, node);
        if (row.type === 'message' && row.role === 'user') dropPending(pane, row.text);
      }
      if (data.lastSeq > pane.lastSeq) pane.lastSeq = data.lastSeq;
      if (stick) scrollToBottom(pane.stream);

      setStatus(pane, data.status);
      showPaneInfo(pane, data);
    } catch (err) {
      pane.online = false;
      setStatus(pane, 'offline');
      showPaneError(pane, err.message);
    } finally {
      pane.pollInFlight = false;
      schedulePane(pane);
    }
  }

  function applySessions(pane, data) {
    if (data.session && !pane.session) pane.session = data.session.externalSessionId;
    if (data.session && pane.session === data.session.externalSessionId) {
      pane.select.title = `${data.session.title}（${data.session.cwd || '?'}）`;
      if (data.session.ambiguous) {
        showPaneError(pane, `${data.session.liveCount} 个 live 会话，已默认选第一个，可在右上角切换`);
      }
    }
    const sessions = data.sessions || [];
    // 刚新建的会话可能还没进对端列表（Harness的 impl.cjs 会过滤空壳会话、只给最近 12 个）。
    // 如果就这么丢掉，选中项会被下一轮轮询拉回旧的 —— 用户点完"新建"像是没生效。
    // 所以把"当前选中的那个"钉在下拉顶部，等它自己出现在列表里再自然消失。
    const list = sessions.slice();
    if (pane.session && !list.some((s) => s.externalSessionId === pane.session)) {
      list.unshift({
        externalSessionId: pane.session,
        title: '（刚新建，还没进列表）',
        live: true,
        kind: null
      });
    }
    const sig = list.map((s) => `${s.externalSessionId}:${s.title}:${s.kind || ''}`).join('|');
    if (sig === pane.sessionsSig) return;
    pane.sessionsSig = sig;
    const keep = pane.session;
    pane.select.replaceChildren();
    for (const s of list) {
      const opt = document.createElement('option');
      opt.value = s.externalSessionId;
      // kind 是Harness这边给的：agents-anywhere = 手机端产生的会话（真实历史，标记但不禁用）
      const tag = s.kind === 'agents-anywhere' ? '📱 ' : '';
      opt.textContent = `${tag}${s.title}${s.live ? ' ●' : ''}`;
      if (s.kind) opt.title = `来源：${s.kind}`;
      pane.select.appendChild(opt);
    }
    if (keep && list.some((s) => s.externalSessionId === keep)) pane.select.value = keep;
    else if (list.length) {
      pane.session = pane.select.value || list[0].externalSessionId;
      pane.select.value = pane.session;
    }
  }

  // ---------------------------------------------------------------- 乐观显示
  function addPending(pane, text, clientMessageId) {
    clearPlaceholder(pane);
    const div = document.createElement('div');
    div.className = 'msg user pending';
    div.textContent = text;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = '我 · 发送中…';
    div.appendChild(meta);
    pane.stream.insertBefore(div, pane.thinking);
    scrollToBottom(pane.stream);
    pane.pending.push({ text, clientMessageId, node: div });
  }

  function dropPending(pane, text) {
    const idx = pane.pending.findIndex((p) => p.text === text);
    if (idx < 0) return;
    const [p] = pane.pending.splice(idx, 1);
    if (p.node && p.node.parentNode) p.node.remove();
  }

  // ---------------------------------------------------------------- 发送
  function targets() {
    if (state.target === 'both') return Array.from(state.panes.keys());
    return state.panes.has(state.target) ? [state.target] : [];
  }

  async function send() {
    if (state.sending) return;
    const text = el.input.value;
    if (!text.trim()) {
      hint('先写点什么再发', true);
      return;
    }
    const list = targets();
    if (!list.length) {
      hint('没有可发的目标', true);
      return;
    }

    state.sending = true;
    el.send.disabled = true;
    hint(`发送中…（${list.join(' + ')}）`, false);

    const errors = [];
    let okCount = 0;
    for (const id of list) {
      const pane = state.panes.get(id);
      try {
        const res = await api('/api/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ side: id, session: pane.session || undefined, text })
        });
        addPending(pane, text, res.clientMessageId);
        okCount++;
        pollPane(pane); // 立刻催一次，别等下一个轮询周期
      } catch (err) {
        errors.push(`${pane.side.short}: ${err.message.split('\n')[0]}`);
        showPaneError(pane, err.message);
      }
    }

    if (okCount > 0) el.input.value = '';
    state.sending = false;
    el.send.disabled = false;
    hint(errors.length ? `失败 ${errors.length} 边 → ${errors.join('；')}` : `已发给 ${okCount} 边`, errors.length > 0);
    el.input.focus();
  }

  // ---------------------------------------------------------------- 目标选择
  function renderTargets() {
    el.targets.replaceChildren();
    const options = [{ id: 'both', label: '两边都发' }].concat(
      Array.from(state.panes.values()).map((p) => ({ id: p.side.id, label: `只发 ${p.side.short}` }))
    );
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'target';
      btn.dataset.id = opt.id;
      btn.dataset.active = state.target === opt.id ? 'true' : 'false';
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        state.target = opt.id;
        renderTargets();
      });
      el.targets.appendChild(btn);
    }
  }

  // ---------------------------------------------------------------- 两侧状态
  async function refreshSides() {
    try {
      const data = await api('/api/sides');
      state.sides = data.sides || [];
      for (const side of state.sides) {
        const pane = ensurePane(side);
        pane.side = side;
        pane.ws.textContent = side.workspace || '';
        pane.name.textContent = side.label;
        if (!side.online) {
          // 时间线轮询会把在线的一侧标成 idle/running，这里只负责把离线写清楚
          if (pane.online === false) showPaneError(pane, (side.connectError && side.connectError.message) || '离线');
        }
      }
    } catch (err) {
      el.topStatus.replaceChildren();
      const span = document.createElement('span');
      span.className = 'chip';
      span.textContent = `后端连接失败：${err.message.split('\n')[0]}`;
      el.topStatus.appendChild(span);
    }
  }

  // ---------------------------------------------------------------- 身份牌
  // 新会话开局是空白的（认不出对方），所以：
  //   1. 常显两侧"我是谁 / 在哪 / 当前在哪个会话"
  //   2. 后端发现某一侧换了会话 → 那张牌高亮，一键把对方的牌递过去
  // 递牌会真的往对方会话里写一条消息（消耗对方 token），所以**只能点按钮触发**。
  /** session-<id>050e-4ba9-… → session-<id>（卡片上放不下全长） */
  function shortId(id) {
    const t = String(id || '');
    return t.length > 18 ? t.slice(0, 18) + '…' : t;
  }

  function renderIdentity() {
    const bar = el.identityBar;
    const sides = state.identity.sides || [];
    const collapsed = state.identity.collapsed === true;
    bar.dataset.collapsed = collapsed ? 'true' : 'false';
    el.identityCards.replaceChildren();

    if (!sides.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;

    // 收起时也得让人看见"谁在线"，否则收起来就等于把信息全丢了
    const summary = sides.map((s) => `${s.label || s.id} ${s.online ? '●' : '○'}`).join(' ｜ ');
    el.identityToggle.textContent = collapsed ? `身份牌 ▸ ${summary}` : '身份牌 ▾';
    el.identityToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    el.identityToggle.title = collapsed ? '展开身份牌' : '收起身份牌';

    for (const s of sides) {
      const card = document.createElement('div');
      card.className = 'dp-card';
      card.dataset.side = s.id;
      card.dataset.online = s.online ? 'true' : 'false';
      if (s.changed) card.dataset.changed = 'true';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.dataset.state = s.online ? (s.changed ? 'running' : 'idle') : 'offline';

      const name = document.createElement('span');
      name.className = 'dp-name';
      name.textContent = s.label || s.id;

      const bits = document.createElement('span');
      bits.className = 'dp-bits';
      const parts = [s.workspace || '?', s.endpointText || '端点不可用'];
      // 会话这一格要**诚实**：有标题给标题，只有 id 就给短 id，真的没有才说"无会话"。
      // 早先只看 sessionTitle —— 标题为 null 时就谎报"无会话"，而其实有会话（用户抓到的）。
      const sess = s.sessionTitle || (s.sessionId ? shortId(s.sessionId) : null);
      parts.push(sess ? `会话：${sess}` : '无会话');
      if (s.ambiguous && s.liveCount > 1) parts.push(`${s.liveCount} 个 live`);
      bits.textContent = parts.join(' ｜ ');

      card.title = [
        `${s.label || s.id}（${s.id}）`,
        `工作区 ${s.workspace || '?'}`,
        `DSH_HOME ${s.dshHome || '?'}`,
        `端点 ${s.endpointPath || '?'}`,
        `分工 ${s.role || '未注明'}`,
        s.sessionTitle ? `会话标题 ${s.sessionTitle}` : '',
        s.sessionId ? `会话 ${s.sessionId}` : '没有可用会话',
        s.changed ? '⚠ 刚换过会话' : ''
      ]
        .filter(Boolean)
        .join('；');

      card.append(dot, name, bits);

      if (s.changed) {
        const warn = document.createElement('span');
        warn.className = 'dp-warn';
        warn.textContent = `⚠ ${s.label || s.id} 开了新会话`;
        card.appendChild(warn);

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'ghost dp-give';
        dismiss.textContent = '知道了';
        dismiss.title = '不递牌，只把这条提示收起来';
        dismiss.addEventListener('click', () => ackIdentity(s.id));
        card.appendChild(dismiss);
      }

      const other = sides.find((x) => x.id !== s.id);
      if (other) {
        const give = document.createElement('button');
        give.type = 'button';
        give.className = 'ghost dp-give';
        give.textContent = `递 ${other.label || other.id} 的牌`;
        give.title = `把 ${other.label || other.id} 的身份牌塞进 ${s.label || s.id} 的当前会话（会消耗对方 token）`;
        give.addEventListener('click', () => giveIdentity(other.id, s.id, give));
        card.appendChild(give);
      }

      el.identityCards.appendChild(card);
    }
  }

  async function refreshIdentity() {
    try {
      const data = await api('/api/identity');
      state.identity.sides = data.sides || [];
      state.identity.error = null;
    } catch (err) {
      state.identity.error = err.message.split('\n')[0];
      state.identity.sides = []; // 拿不到就别拿旧数据硬撑，条自己会隐藏
    }
    renderIdentity();
  }

  async function giveIdentity(fromId, toId, btn) {
    if (btn) btn.disabled = true;
    try {
      // 用**界面上正在看的那个会话**，而不是让后端自己挑"最近活跃的"。
      // 真机核对时实测：同一侧有 3 个 live 会话，后端挑中的未必是用户在看的那一个 ——
      // 牌递错会话，对方就永远看不到。
      const pane = state.panes.get(toId);
      const res = await api('/api/identity/give', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: fromId, to: toId, session: (pane && pane.session) || undefined })
      });
      hint(`身份牌已递进 ${toId}（${res.chars}/${res.maxChars} 字）`, false);
      await refreshIdentity();
      if (pane) pollPane(pane); // 立刻催一次，让那条牌马上出现在对话里
    } catch (err) {
      hint(`递牌失败：${err.message.split('\n')[0]}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function ackIdentity(sideId) {
    try {
      await api('/api/identity/ack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ side: sideId })
      });
    } catch (err) {
      hint(`收起提示失败：${err.message.split('\n')[0]}`, true);
    }
    await refreshIdentity();
  }

  // ---------------------------------------------------------------- 启动
  function addInitPlaceholder() {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = '正在连接两侧…';
    el.panes.appendChild(div);
  }

  function boot() {
    addInitPlaceholder();
    renderTargets();
    loadBackendInfo(); // 记下 logPath/port，后端挂了以后告诉用户去哪儿看

    // 主题按钮接线（逻辑在 /theme.js，它已在 <head> 里应用过主题）
    if (window.DshPairTheme && typeof window.DshPairTheme.wire === 'function') {
      try {
        window.DshPairTheme.wire();
      } catch (err) {
        console.warn('theme wire failed', err);
      }
    }

    el.send.addEventListener('click', send);
    el.refresh.addEventListener('click', () => {
      hint('刷新中…', false);
      refreshSides().then(() => {
        for (const pane of state.panes.values()) pollPane(pane);
        hint('已刷新', false);
      });
      refreshIdentity();
    });

    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    refreshSides()
      .then(() => {
        const ph = el.panes.querySelector('.empty');
        if (ph) ph.remove();
        for (const pane of state.panes.values()) pollPane(pane);
      })
      .catch(() => {});

    setInterval(refreshSides, SIDES_REFRESH_MS);
    // 身份牌条的收起/展开（状态记在 localStorage，刷新后保持）
    if (el.identityToggle) {
      el.identityToggle.addEventListener('click', () => {
        state.identity.collapsed = state.identity.collapsed !== true;
        writeCollapsed(state.identity.collapsed);
        renderIdentity();
      });
    }
    refreshIdentity();
    setInterval(refreshIdentity, IDENTITY_MS);

    // 任务检测行里的"跑了多久"要每秒动一次（状态本身还是靠轮询）
    setInterval(() => {
      for (const pane of state.panes.values()) {
        if (pane.status === 'running') renderActivity(pane);
      }
    }, 1000);

    // 用户切回窗口就把标题上的提醒清掉（不打扰已经看到的人）
    window.addEventListener('focus', () => {
      clearTimeout(titleTimer);
      document.title = BASE_TITLE;
    });
  }

  boot();
})();
