/*
 * test/stop-test.js —— stop.js 的隔离测试（安全关键路径，单独跑）
 * ---------------------------------------------------------------
 * 为什么单独一个文件：stop.js 会"停掉本目录的实例"，如果塞进主测试套件里，
 * 它会把套件自己起的那些服务一起停掉，互相打架。所以这里在**副本目录**里测，
 * 用 DSH_PAIR_STOP_DIR 把作用域限定在副本上。
 *
 * 覆盖两种真实形态（都踩过）：
 *   1. 有 pid 文件 → 按 pid + /api/health 交叉校验后停；
 *   2. pid 文件丢了、而且是启动器用**相对路径**起的（`node server.js --port N`）
 *      → 旧的"按绝对路径匹配"兜底会漏掉，现在改成"命令行捞候选 + health 证明归属"。
 *   另外必须验证：不动别的目录的实例、不动无关的 node 进程。
 *
 * 跑法：node test/stop-test.js
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(APP_DIR, '..');
const COPY_DIR = path.join(REPO_DIR, '_stop-test-copy');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function health(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch (err) {
      /* 还没起来 */
    }
    await sleep(150);
  }
  return null;
}

function isListening(port) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) -ne $null`], { encoding: 'utf8' });
  return /True/i.test(r.stdout || '');
}

function runStop(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'bin', 'stop.js')], {
      env: Object.assign({}, process.env, { DSH_PAIR_STOP_DIR: dir })
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function main() {
  console.log('stop.js 隔离测试');

  // 副本目录（必须在仓库内，因为它要 require ../../peer/lib/bridge.js）
  fs.rmSync(COPY_DIR, { recursive: true, force: true });
  fs.mkdirSync(COPY_DIR, { recursive: true });
  for (const item of ['server.js', 'lib', 'public', 'bin']) {
    fs.cpSync(path.join(APP_DIR, item), path.join(COPY_DIR, item), { recursive: true });
  }

  // 一个"别人的" node 进程：绝不能被 stop.js 碰到
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 600000)'], { stdio: 'ignore' });

  // 另一个目录里的**同类实例**（也是 dsh-pair，但属于别的目录）：同样绝不能碰。
  // 这一条就是为"隔离测试反而误杀了真实实例"那个事故加上的回归。
  const OTHER_DIR = path.join(REPO_DIR, '_stop-test-other');
  fs.rmSync(OTHER_DIR, { recursive: true, force: true });
  fs.mkdirSync(OTHER_DIR, { recursive: true });
  for (const item of ['server.js', 'lib', 'public', 'bin']) {
    fs.cpSync(path.join(APP_DIR, item), path.join(OTHER_DIR, item), { recursive: true });
  }
  const otherPort = await freePort();
  const otherServer = spawn(process.execPath, ['server.js', '--port', String(otherPort)], { cwd: OTHER_DIR, stdio: 'ignore' });
  const otherHealth = await health(otherPort);
  ok('另一目录的同类实例也起来了（用于验证作用域）', !!(otherHealth && otherHealth.ok));

  // 按**相对路径**启动副本的服务（复刻启动器的做法），随后删掉它的 pid 文件
  const port1 = await freePort();
  const server1 = spawn(process.execPath, ['server.js', '--port', String(port1)], { cwd: COPY_DIR, stdio: 'ignore' });
  const h1 = await health(port1);
  ok('副本服务起来了（相对路径启动）', !!(h1 && h1.ok), JSON.stringify(h1));
  const pidFiles = fs.readdirSync(COPY_DIR).filter((n) => /^server.*\.pid$/.test(n));
  ok('它写了 pid 文件', pidFiles.length >= 2, pidFiles.join(','));
  for (const f of pidFiles) fs.unlinkSync(path.join(COPY_DIR, f));
  ok('已把 pid 文件全删掉（模拟用户那台机器上的状态）', fs.readdirSync(COPY_DIR).filter((n) => /^server.*\.pid$/.test(n)).length === 0);

  // 场景 1（先测）：pid 文件丢失 + 相对路径命令行 → 只能靠 health 证明归属。
  // 注意顺序：这个实例一旦被兜底扫到就会停掉，所以必须在"按 pid 停"的场景之前测。
  {
    const r = await runStop(COPY_DIR);
    ok('pid 文件丢失时：兜底靠 /api/health 证明归属并停掉相对路径启动的实例',
      /no pid file - verified via \/api\/health/.test(r.out), r.out);
  }
  await sleep(800);
  ok('第一个实例（相对路径、无 pid 文件）确实停了', !isListening(port1));

  // 场景 2：有 pid 文件时按 pid 停（绝对路径启动的第二个实例）
  const port2 = await freePort();
  const server2 = spawn(process.execPath, [path.join(COPY_DIR, 'server.js'), '--port', String(port2)], { stdio: 'ignore' });
  const h2 = await health(port2);
  ok('第二个实例（绝对路径启动）起来了', !!(h2 && h2.ok));
  {
    const r = await runStop(COPY_DIR);
    ok('有 pid 文件时：按 pid + health 交叉校验后停掉', /stopped pid \d+ \(port /.test(r.out), r.out);
  }
  await sleep(800);
  ok('第二个实例确实没了', !isListening(port2));

  // 场景 3：看门狗必须能把被杀的 server 拉回来，而且 stop 之后不能再自己起来
  {
    const wdPort = await freePort();
    const wd = spawn(process.execPath, [path.join(COPY_DIR, 'bin', 'watchdog.js'), '--port', String(wdPort)], { cwd: COPY_DIR, stdio: 'ignore' });
    const h = await health(wdPort);
    ok('看门狗把 server 拉起来了', !!(h && h.ok), JSON.stringify(h));

    // 硬杀 server（模拟这个环境里反复发生的"后端干净地没了"）
    const victimPid = h && h.pid;
    try {
      process.kill(victimPid, 'SIGKILL');
    } catch (err) {
      /* 忽略 */
    }
    let back = null;
    for (let i = 0; i < 30 && !back; i++) {
      await sleep(500);
      const h2 = await health(wdPort);
      if (h2 && h2.ok && h2.pid !== victimPid) back = h2;
    }
    ok('server 被硬杀后看门狗自动重启了它（新 pid）', !!back, back ? '' : '30 次探测都没等到新实例');

    // 现在用 stop.js 停：看门狗和 server 都要停，而且**不能再自己起来**
    const r = await runStop(COPY_DIR);
    ok('stop.js 会先请求看门狗停止', /asked watchdog pid \d+ to stop/.test(r.out), r.out);
    await sleep(600);
    ok('停完之后 server 也没了', !isListening(wdPort));
    await sleep(4000); // 等够一个重启周期，确认不是"停了又起来"
    ok('4 秒后也没被重新拉起（看门狗真的停了）', !isListening(wdPort), '又被拉起来了');
    ok('看门狗的 pid 文件被清掉', !fs.existsSync(path.join(COPY_DIR, `watchdog-${wdPort}.pid`)));
    try {
      wd.kill();
    } catch (err) {
      /* 忽略 */
    }
  }

  // 场景 4（B6）：另一个目录的实例占着某个端口时，本目录里存在一个"指向死 pid、
  // 但 port 写成那个端口"的陈旧 pid 文件 —— 绝不能因此把别人的实例杀掉。
  {
    const stalePort = otherPort;
    const stalePid = 999999; // 不可能存在的 pid
    fs.writeFileSync(
      path.join(COPY_DIR, `server-${stalePort}.pid`),
      JSON.stringify({ pid: stalePid, port: stalePort, appDir: COPY_DIR }),
      'utf8'
    );
    const r = await runStop(COPY_DIR);
    ok('陈旧 pid 文件不会导致误杀别人的实例（port 相同也不杀）',
      /answers with pid|is already gone/.test(r.out) && isListening(otherPort),
      r.out);
    ok('陈旧的 pid 文件被清掉', !fs.existsSync(path.join(COPY_DIR, `server-${stalePort}.pid`)));
  }

  // 场景 5（B6）：同目录多端口 —— 两个实例各写各的 pid 文件，互不干扰
  {
    const p1 = await freePort();
    const p2 = await freePort();
    const s1 = spawn(process.execPath, ['server.js', '--port', String(p1)], { cwd: COPY_DIR, stdio: 'ignore' });
    const s2 = spawn(process.execPath, ['server.js', '--port', String(p2)], { cwd: COPY_DIR, stdio: 'ignore' });
    const h1 = await health(p1);
    const h2 = await health(p2);
    ok('同目录两个端口能同时起（互不抢）', !!(h1 && h1.ok && h2 && h2.ok), JSON.stringify({ h1: !!h1, h2: !!h2 }));
    ok('两个实例各自写了 pid 文件',
      fs.existsSync(path.join(COPY_DIR, `server-${p1}.pid`)) && fs.existsSync(path.join(COPY_DIR, `server-${p2}.pid`)));
    const f1 = JSON.parse(fs.readFileSync(path.join(COPY_DIR, `server-${p1}.pid`), 'utf8'));
    const f2 = JSON.parse(fs.readFileSync(path.join(COPY_DIR, `server-${p2}.pid`), 'utf8'));
    ok('pid 文件记的是各自的端口与 pid',
      f1.port === p1 && f1.pid === h1.pid && f2.port === p2 && f2.pid === h2.pid,
      JSON.stringify({ f1, f2 }));
    // 停掉 p1：只会通过它自己那条 pid 记录命中它
    const r = await runStop(COPY_DIR);
    ok('stop.js 把本目录两个端口都停了（语义：停本目录的所有实例）',
      (r.out.match(/stopped pid /g) || []).length >= 2, r.out);
    await sleep(800);
    ok('两个端口都释放了', !isListening(p1) && !isListening(p2));
    try {
      s1.kill();
      s2.kill();
    } catch (err) {
      /* 忽略 */
    }
  }

  // 无辜进程与另一个目录都得活着
  ok('无关的 node 进程没被碰', decoy.exitCode === null, `exitCode=${decoy.exitCode}`);
  ok('**另一个目录的 dsh-pair 实例没被碰**（作用域靠 health 里的 appDir 界定）', isListening(otherPort), `port ${otherPort} 已不在监听`);
  ok('副本目录的 pid 文件被清干净', fs.readdirSync(COPY_DIR).filter((n) => /^server.*\.pid$/.test(n)).length === 0);

  // 空目录时不该乱杀
  {
    const r = await runStop(COPY_DIR);
    ok('没有实例时：明确说没有，且退出码 0', r.code === 0 && /nothing of ours is running/.test(r.out), `${r.code} ${r.out}`);
  }

  for (const s of [server1, server2, otherServer]) {
    try {
      s.kill();
    } catch (err) {
      /* 忽略 */
    }
  }
  try {
    decoy.kill();
  } catch (err) {
    /* 忽略 */
  }
  await sleep(300);
  fs.rmSync(COPY_DIR, { recursive: true, force: true });
  fs.rmSync(OTHER_DIR, { recursive: true, force: true });

  console.log(failures.length ? `\n${pass} 通过, ${failures.length} 失败：${failures.join('; ')}` : `\n全部通过：${pass} 项`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('测试自身崩了：', err);
  process.exit(1);
});
