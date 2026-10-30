#!/usr/bin/env node
// scripts/test-swr.mjs —— 夹具①：SWR（过期先给旧值 + 后台刷新；冷启动阻塞取真值并记 coldMiss）
//
// 一键跑：node scripts/test-swr.mjs
// 退出码：0 = 全通过；1 = 有失败项。
//
// 分两段：
//   [A] 车道本身（假时钟 + 可控延迟的探针源）：冷启 / 命中 / 过期先出旧值 / 后台换新 / 计数分开
//   [B] 面板整屏（真 buildState + 假时钟车道）：/state 的 freshness 与 sli 真的把"旧值 / 旧了多久"
//       吐出来，而不是只在单测里成立
//
// ⚠️ 夹具隔离三件套：USERPROFILE + HOME + DSH_HOME 全部指向沙箱（另加本插件自己的 HOME 覆盖），
//    少一个就可能"写沙箱、发生产"。

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

// ---------------------------------------------------------------- 沙箱 + 三件套隔离
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-swr-'));
const home = path.join(sandbox, 'home');
fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
fs.mkdirSync(path.join(home, 'skills', 'skill-a'), { recursive: true });
fs.writeFileSync(path.join(home, 'skills', 'skill-a', 'SKILL.md'), '---\n{"name":"skill-a","description":"夹具技能"}\n---\n', 'utf8');
fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'fixture-profile', dsh: { profile: { bundles: [] } } }), 'utf8');

process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.DSH_HOME = home;
process.env.DSH_ECOSYSTEM_PANEL_HOME = home;

const laneMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'fetch-lane.js')).href);
const stateMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'state.js')).href);
const { createLane, DEFAULT_TTL_MS } = laneMod;

console.log('=== [A] 车道：冷启动 / 命中 / 过期先给旧值 / 后台换新 ===');
console.log(`缺省 TTL = ${DEFAULT_TTL_MS} ms（300 s，与文档仓 06 篇 §3.2 的"五分钟节奏"同源）`);
ok('缺省 TTL 就是 300 s（没另定一个数）', DEFAULT_TTL_MS === 300000, String(DEFAULT_TTL_MS));

let clock = Date.now();
let calls = 0;
const lane = createLane({
  ttlMs: 300,
  totalBudgetMs: 2000,
  now: () => clock,
  sources: [{
    id: 'probe',
    label: '探针',
    async run() {
      calls += 1;
      const n = calls;
      await sleep(120);           // 故意的慢源：用来证明"过期那一下没在等它"
      return { n, at: clock };
    }
  }]
});

const t0 = Date.now();
const cold = await lane.read('probe');
const coldWall = Date.now() - t0;
ok('冷启动不是空壳：阻塞取到真值', cold.status === 'cold' && cold.value?.n === 1, `${cold.status} / n=${cold.value?.n}`);
ok('冷启动耗时 = 真取数（不是 0，也没超时）', coldWall >= 110, `${coldWall} ms`);
ok('数据块自带 fetchedAt', typeof cold.fetchedAt === 'number' && cold.fetchedAt === clock, String(cold.fetchedAt));
ok('冷启动单独记成 coldMiss（不算命中）', lane.sli().totals.coldMiss === 1 && lane.sli().totals.hit === 0,
  JSON.stringify(lane.sli().totals));

const warm = await lane.read('probe');
ok('TTL 内再读 = 命中，不重复取数', warm.status === 'fresh' && calls === 1 && lane.sli().totals.hit === 1,
  `${warm.status} / calls=${calls}`);

// 过期：旧值必须**立刻**出（不等 120 ms 的慢源），同时后台换新
clock += 340;                    // 超过 ttlMs=300
const t1 = Date.now();
const stale = await lane.read('probe');
const staleWall = Date.now() - t1;
ok('过期后先给旧值（stale），旧值内容没变', stale.status === 'stale' && stale.value?.n === 1,
  `${stale.status} / n=${stale.value?.n}`);
ok('旧值带"旧了多久"（ageMs ≥ TTL）', stale.ageMs >= 300, `${stale.ageMs} ms`);
ok('过期那一下没有阻塞等慢源（< 60 ms 返回）', staleWall < 60, `${staleWall} ms`);
ok('过期被记为未命中（miss），不是命中', lane.sli().totals.miss === 1 && lane.sli().totals.hit === 1,
  JSON.stringify(lane.sli().totals));

await lane.settle();             // 等后台那次刷新落定
const after = await lane.read('probe');
ok('后台刷回来就换新值', after.status === 'fresh' && after.value?.n === 2, `${after.status} / n=${after.value?.n}`);
ok('换新只多取了一次（单飞，不叠加）', calls === 2, String(calls));
const sliA = lane.sli();
ok('SLI 三桶分开：命中 / 未命中 / 冷启动', sliA.totals.hit === 2 && sliA.totals.miss === 1 && sliA.totals.coldMiss === 1,
  JSON.stringify(sliA.totals));
ok('SLI 有每源耗时', sliA.sources.probe.fetches === 2 && sliA.sources.probe.avgMs >= 100,
  `fetches=${sliA.sources.probe.fetches} avg=${sliA.sources.probe.avgMs} ms`);

console.log('\n=== [B] 面板整屏：freshness / sli 真的把"旧值 + 旧了多久"吐出来 ===');
stateMod.resetLanes();
let panelClock = Date.now();
const panelLane = createLane({
  sources: stateMod.listSources(),
  ttlMs: 120,
  totalBudgetMs: 4000,
  now: () => panelClock
});
const cfgBase = { home, profile: 'web', webUrl: 'http://127.0.0.1:1' };
const s1 = await stateMod.buildState({ config: cfgBase, lane: panelLane });
ok('第一次请求：有冷启动计数', s1.sli.totals.coldMiss >= 1, JSON.stringify(s1.sli.totals));
ok('第一次请求：新鲜度里没有任何过期源', s1.freshness.stale === false, JSON.stringify(s1.freshness.sources).slice(0, 120));
const s2 = await stateMod.buildState({ config: cfgBase, lane: panelLane });
ok('第二次请求：全部命中、取数几乎不花时间', s2.sli.request.totalMs <= 5 && s2.sli.totals.hit > s1.sli.totals.hit,
  `totalMs=${s2.sli.request.totalMs} hit=${s2.sli.totals.hit}`);

panelClock += 200;               // 全过期
const s3 = await stateMod.buildState({ config: cfgBase, lane: panelLane });
const staleIds = Object.entries(s3.freshness.sources).filter(([, v]) => v.stale).map(([k]) => k);
ok('过期后：整屏标 stale 且列清哪些源是旧值', s3.freshness.stale === true && staleIds.length > 0, staleIds.join(','));
ok('过期后：给出"最旧的那个"旧了多久', s3.freshness.oldestAgeMs >= 120, `${s3.freshness.oldestAgeMs} ms`);
ok('过期后：旧值仍然照常渲染（不是空壳）', s3.groups.skills.length === 1, String(s3.groups.skills.length));
ok('过期后：这次记成未命中', s3.sli.totals.miss >= 1, String(s3.sli.totals.miss));
ok('页脚三项数据齐（每源耗时 / 命中率三桶 / 降级次数）',
  Array.isArray(s3.sli.request.sources) && s3.sli.request.sources.length === stateMod.listSources().length
  && typeof s3.sli.totals.degraded === 'number', `sources=${s3.sli.request.sources.length}`);

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
console.log(fail === 0 ? 'SWR FIXTURE PASSED' : 'SWR FIXTURE FAILED');
process.exitCode = fail === 0 ? 0 : 1;
