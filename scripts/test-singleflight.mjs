#!/usr/bin/env node
// scripts/test-singleflight.mjs —— 夹具③：单飞（同一源同一时刻只有一次在途取数）
//
// 一键跑：node scripts/test-singleflight.mjs
// 退出码：0 = 全通过；1 = 有失败项。
//
// 要证明的两件事：
//   [A] 冷启动时 N 个并发请求打同一个源 ⇒ 源侧只被调用 **1 次**，N 个请求共享同一次结果
//   [B] 过期（旧值在手）时 N 个并发请求 ⇒ 后台刷新也只发 **1 次**，不是每个请求各刷一遍
// 反例（如果不做单飞）：10 个页面同时打开 = 源被打 10 次 —— 这正是"面板把源打爆"的现场。
//
// ⚠️ 夹具隔离三件套：USERPROFILE + HOME + DSH_HOME。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('[OK]   ' + name + (detail ? ' :: ' + detail : '')); }
  else { fail += 1; console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-singleflight-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
process.env.DSH_HOME = sandbox;
process.env.DSH_ECOSYSTEM_PANEL_HOME = sandbox;

const { createLane } = await import(pathToFileURL(path.join(ROOT, 'lib', 'fetch-lane.js')).href);

let clock = Date.now();
let calls = 0;
const RTT = 80;
const lane = createLane({
  ttlMs: 500,
  totalBudgetMs: 3000,
  now: () => clock,
  sources: [{
    id: 'one-source',
    label: '单飞探针',
    async run() {
      calls += 1;
      const n = calls;
      await sleep(RTT);          // 模拟一次真实的慢取数
      return { n };
    }
  }]
});

console.log('=== [A] 冷启动：10 个并发请求打同一个源 ===');
const t0 = Date.now();
const burst = await Promise.all(Array.from({ length: 10 }, () => lane.read('one-source')));
const wall = Date.now() - t0;
ok('10 个请求全部拿到值', burst.every((r) => r.value?.n === 1), JSON.stringify(burst.map((r) => r.value?.n)));
ok('源侧只被调用 1 次（单飞生效）', calls === 1, `calls=${calls}`);
ok('10 个请求共享同一次取数（耗时 ≈ 一次 RTT，不是 10 次）', wall >= RTT && wall < RTT * 3, `${wall} ms / RTT=${RTT} ms`);
ok('SLI 里也只有 1 次外部取数', lane.sli().sources['one-source'].fetches === 1,
  String(lane.sli().sources['one-source'].fetches));
ok('计数口径如实：10 个冷启动请求各记一次 coldMiss，但外部只取 1 次（不拿"命中"骗读数）',
  lane.sli().totals.coldMiss === 10 && lane.sli().sources['one-source'].fetches === 1,
  JSON.stringify({ coldMiss: lane.sli().totals.coldMiss, fetches: lane.sli().sources['one-source'].fetches }));

console.log('\n=== [B] 过期：手持旧值时 8 个并发请求 ===');
clock += 520;                    // 让缓存过期（ttlMs=500）
const t1 = Date.now();
const staleBurst = await Promise.all(Array.from({ length: 8 }, () => lane.read('one-source')));
const staleWall = Date.now() - t1;
ok('8 个请求都先拿到旧值（stale，不阻塞）', staleBurst.every((r) => r.status === 'stale' && r.value?.n === 1),
  staleBurst.map((r) => r.status).join(','));
ok('过期那一屏几乎不花时间（没等后台刷新）', staleWall < 40, `${staleWall} ms`);
await sleep(RTT + 60);
await lane.settle();
ok('后台刷新只发了 1 次（8 个请求共享同一次刷新）', calls === 2, `calls=${calls}`);
ok('SLI：过期读记成 8 次未命中，但外部取数只多 1 次',
  lane.sli().totals.miss === 8 && lane.sli().sources['one-source'].fetches === 2,
  JSON.stringify({ miss: lane.sli().totals.miss, fetches: lane.sli().sources['one-source'].fetches }));
const after = await lane.read('one-source');
ok('刷完后新值就位', after.status === 'fresh' && after.value?.n === 2, `${after.status} / n=${after.value?.n}`);

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
console.log(fail === 0 ? 'SINGLE-FLIGHT FIXTURE PASSED' : 'SINGLE-FLIGHT FIXTURE FAILED');
process.exitCode = fail === 0 ? 0 : 1;
