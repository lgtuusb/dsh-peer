#!/usr/bin/env node
/*
 * bin/stop.js —— 只停"我们这个目录起的" dsh-pair 服务
 * ---------------------------------------------------------------
 * 为什么不用 cmd/PowerShell 写这段逻辑（血的教训）：
 *   1. .cmd 里写中文会被中文代码页读歪，cmd 会把乱码当命令去执行；
 *   2. 在 cmd 里嵌套 PowerShell 的双引号/括号转义极脆，一旦解析歪了，
 *      "命令行里含本目录 server.js"这种判断会退化成空串，Contains('') 恒真 →
 *      把机器上所有 node 都杀了（实测就这么误杀了另一个目录的实例）。
 *   3. 所以：逻辑放 JS（UTF-8 安全），Node 用 execFileSync 把 PowerShell 脚本当**单个参数**传，
 *      完全绕开 cmd 的引号解析。
 *
 * 输出一律用 ASCII：Windows 控制台默认代码页不是 UTF-8，中文会显示成乱码。
 * （注释保持中文没问题 —— Node 按 UTF-8 读源码。）
 *
 * 两步走：
 *   A. 读 server*.pid → 对每个 {pid, port} 请求 /api/health → 返回的 pid 与记录一致才 kill（SIGTERM）
 *      —— 自带校验：pid 被复用、端口被别人占了，都不会误杀。
 *   B. pid 文件丢了的话兜底：让 PowerShell 列出"命令行里含 <本目录>server.js"的 node 进程，只杀这些。
 *
 * 绝不使用 taskkill /IM node.exe。
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

// 允许用 DSH_PAIR_STOP_DIR 覆盖"要停哪个目录的实例"（便于隔离测试；默认本目录）
const APP_DIR = process.env.DSH_PAIR_STOP_DIR || path.join(__dirname, '..');

/** 问 /api/health：返回健康信息（含 appDir），问不到就 null */
function healthInfo(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
      });
      res.on('end',  => {
        try {
          const json = JSON.parse(body);
          resolve(json && json.ok ? json : null);
        } catch (err) {
          resolve(null);
        }
      });
    });
    req.on('timeout',  => {
      req.destroy;
      resolve(null);
    });
    req.on('error',  => resolve(null));
  });
}

const sameDir = (a, b) =>
  String(a || '').replace(/[\\/]+$/, '').toLowerCase === String(b || '').replace(/[\\/]+$/, '').toLowerCase;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function processAlive(pid) {
  try {
    process.kill(pid, 0); // 只探测，不发信号
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 兜底候选：node 进程且命令行里含 server.js。
 *
 * 为什么不能只按"绝对路径 <app>\server.js"匹配：启动器是 `cd /d <app>` 之后用
 * `node server.js --port 8787` 起的（相对路径），这种命令行里**没有**绝对路径，
 * 按路径匹配会漏掉 —— 实测用户正跑着的那个实例就是这样，pid 文件又丢了，结果停不掉。
 *
 * 所以这里放宽到"含 server.js"，但**不靠路径猜归属**：真正的所有权由我自己的
 * /api/health 证明（返回的 pid 必须等于这个进程的 pid），验不过就绝不动手。
 */
function listCandidatesByCommandLine {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" -ErrorAction SilentlyContinue |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine -match 'server\\.js' } |",
    '  ForEach-Object { $m = [regex]::Match($_.CommandLine, "--port\\s+(\\d+)"); $port = if ($m.Success) { $m.Groups[1].Value } else { "" }; "$($_.ProcessId)|$port" }'
  ].join(' ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000
    });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim)
      .filter(Boolean)
      .map((line) => {
        const [pidStr, portStr] = line.split('|');
        return { pid: Number(pidStr), port: Number(portStr) || null };
      })
      .filter((c) => Number.isInteger(c.pid) && c.pid > 0);
  } catch (err) {
    console.log('[dsh-pair] fallback scan failed: ' + String(err.message).split('\n')[0]);
    return [];
  }
}

(async  => {
  const pidFileNames = fs.readdirSync(APP_DIR).filter((n) => /\.pid$/.test(n));
  const watchdogFiles = pidFileNames.filter((n) => /^watchdog.*\.pid$/.test(n));
  const pidFiles = pidFileNames.filter((n) => /^server.*\.pid$/.test(n));
  const handled = new Set;
  let stopped = 0;

  // ---- 第一遍：看门狗。必须**先**停它，否则它会把 server 又拉起来。 ----
  // 停止协议：先删它的 pid 文件（它自己每秒检查一次，看到没了就干净退出并带走子进程），
  // 等一会儿再按 pid 兜底杀。这样 server 是被 SIGTERM 正常收掉的，日志里留得下痕迹。
  for (const name of watchdogFiles) {
    const file = path.join(APP_DIR, name);
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.log('[dsh-pair] unreadable watchdog pid file, removing: ' + name);
      fs.unlinkSync(file);
      continue;
    }
    const pid = Number(info && info.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      fs.unlinkSync(file);
      continue;
    }
    if (info.appDir && !sameDir(info.appDir, APP_DIR)) {
      console.log('[dsh-pair] watchdog pid ' + pid + ' belongs to ' + info.appDir + ', not this folder - leaving it alone');
      fs.unlinkSync(file);
      continue;
    }
    if (!processAlive(pid)) {
      console.log('[dsh-pair] watchdog pid ' + pid + ' is already gone (' + name + ')');
      fs.unlinkSync(file);
      continue;
    }
    try {
      fs.unlinkSync(file); // ← 停止信号：它看到这个文件消失就会自己退
      console.log('[dsh-pair] asked watchdog pid ' + pid + ' to stop (removed ' + name + ')');
      await sleep(1500);
      if (processAlive(pid)) {
        process.kill(pid, 'SIGTERM');
        await sleep(700);
        if (processAlive(pid)) process.kill(pid, 'SIGKILL');
        console.log('[dsh-pair] watchdog pid ' + pid + ' stopped (forced)');
      } else {
        console.log('[dsh-pair] watchdog pid ' + pid + ' stopped (clean)');
      }
      stopped++;
      handled.add(pid);
    } catch (err) {
      console.log('[dsh-pair] failed to stop watchdog pid ' + pid + ': ' + err.message);
    }
  }

  for (const name of pidFiles) {
    const file = path.join(APP_DIR, name);
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.log('[dsh-pair] unreadable pid file, removing: ' + name);
      fs.unlinkSync(file);
      continue;
    }
    const pid = Number(info && info.pid);
    const port = Number(info && info.port);

    if (!Number.isInteger(pid) || pid <= 0) {
      console.log('[dsh-pair] bad pid in ' + name + ', removing file');
      fs.unlinkSync(file);
      continue;
    }
    if (handled.has(pid)) {
      console.log('[dsh-pair] pid ' + pid + ' already handled (from ' + name + ')');
      fs.unlinkSync(file);
      continue;
    }

    const health = await healthInfo(port);
    if (health === null) {
      console.log('[dsh-pair] pid ' + pid + ' (' + name + ') is gone or port ' + port + ' is not answering - removing file only');
      fs.unlinkSync(file);
      continue;
    }
    if (health.pid !== pid) {
      console.log('[dsh-pair] port ' + port + ' answers with pid ' + health.pid + ', not the ' + pid + ' in ' + name + ' - leaving it alone');
      fs.unlinkSync(file);
      continue;
    }
    if (health.appDir && !sameDir(health.appDir, APP_DIR)) {
      console.log('[dsh-pair] pid ' + pid + ' belongs to ' + health.appDir + ', not ' + APP_DIR + ' - leaving it alone');
      fs.unlinkSync(file);
      continue;
    }

    try {
      process.kill(pid, 'SIGTERM'); // 只杀这一个 pid
      console.log('[dsh-pair] stopped pid ' + pid + ' (port ' + port + ')');
      stopped++;
      handled.add(pid);
    } catch (err) {
      console.log('[dsh-pair] failed to stop pid ' + pid + ': ' + err.message);
    }
    fs.unlinkSync(file);
  }

  // 兜底：pid 文件丢了也要能停。候选按命令行捞，**归属由 /api/health 证明**
  // （返回的 pid 必须等于候选进程的 pid），验不过绝不杀。
  const candidates = listCandidatesByCommandLine.filter((c) => !handled.has(c.pid) && c.pid !== process.pid);
  for (const cand of candidates) {
    if (!cand.port) {
      console.log('[dsh-pair] pid ' + cand.pid + ' looks like ours but has no --port, cannot verify - leaving it alone');
      continue;
    }
    const health = await healthInfo(cand.port);
    if (!health || health.pid !== cand.pid) {
      console.log('[dsh-pair] pid ' + cand.pid + ' (port ' + cand.port + ') did not answer as our server - leaving it alone');
      continue;
    }
    // 关键：按服务器自报的 appDir 判断归属。只靠"命令行含 server.js"会扫到别的目录的实例
    // （我的隔离测试就这么误杀过一个正在用的实例）。
    if (!sameDir(health.appDir, APP_DIR)) {
      console.log(
        '[dsh-pair] pid ' + cand.pid + ' (port ' + cand.port + ') belongs to ' + health.appDir + ', not this folder - leaving it alone'
      );
      continue;
    }
    try {
      process.kill(cand.pid, 'SIGTERM');
      console.log('[dsh-pair] stopped pid ' + cand.pid + ' (port ' + cand.port + ', no pid file - verified via /api/health)');
      stopped++;
      handled.add(cand.pid);
      // 顺手把"指向这个 pid"的陈旧 pid 文件删掉，免得下次又被当成待处理项
      for (const n of fs.readdirSync(APP_DIR).filter((x) => /\.pid$/.test(x))) {
        try {
          const info2 = JSON.parse(fs.readFileSync(path.join(APP_DIR, n), 'utf8'));
          if (Number(info2 && info2.pid) === cand.pid) fs.unlinkSync(path.join(APP_DIR, n));
        } catch (err) {
          /* 忽略 */
        }
      }
    } catch (err) {
      console.log('[dsh-pair] failed to stop pid ' + cand.pid + ': ' + err.message);
    }
  }

  // 什么都没停就说清楚（上面若打印过 "belongs to ... not this folder"，那是在解释为什么没动手）
  if (!stopped) {
    console.log('[dsh-pair] nothing of ours is running in this folder');
  }
  process.exit(0);
}).catch((err) => {
  console.log('[dsh-pair] stop failed: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
