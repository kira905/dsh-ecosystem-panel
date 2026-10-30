#!/usr/bin/env node
// scripts/test-degrade.mjs —— 夹具④：分片 + 超时预算 + 局部降级
//
// 一键跑：node scripts/test-degrade.mjs
// 退出码：0 = 全通过；1 = 有失败项。
//
// 三段：
//   [A] 车道：快源 / 慢源（超时）/ 抛错源 / 未配置源 同时读 ⇒ 只有坏的降级，总耗时不被慢源拖爆
//   [B] 总预算：整页预算比单源超时更小时 ⇒ 报「总预算耗尽」，而不是无限等
//   [C] 面板整屏：坏源只坏那一格（那一组多一行「不可探测 + 原因」），其余组照常出、state.ok 仍为 true
//
// ⚠️ 夹具隔离三件套：USERPROFILE + HOME + DSH_HOME（另加本插件自己的 HOME 覆盖）。

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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-degrade-'));
const home = path.join(sandbox, 'home');
fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
for (const name of ['skill-a', 'skill-b']) {
  fs.mkdirSync(path.join(home, 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', name, 'SKILL.md'), `---\n{"name":"${name}","description":"夹具技能"}\n---\n`, 'utf8');
}
fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'fixture-profile', dsh: { profile: { bundles: [] } } }), 'utf8');

process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.DSH_HOME = home;
process.env.DSH_ECOSYSTEM_PANEL_HOME = home;

const { createLane, REASON } = await import(pathToFileURL(path.join(ROOT, 'lib', 'fetch-lane.js')).href);
const stateMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'state.js')).href);

console.log('=== [A] 车道：一个快、一个慢、一个抛错、一个未配置 ===');
const lane = createLane({
  totalBudgetMs: 600,
  sources: [
    { id: 'fast', label: '快源', run: async () => ({ ok: 1 }) },
    { id: 'slow', label: '慢源', timeoutMs: 60, run: async () => { await sleep(400); return { ok: 'late' }; } },
    { id: 'boom', label: '抛错源', run: async () => { throw new Error('上游 503'); } },
    { id: 'gate', label: '未配置源', requires: () => '夹具：这个源没配置（示范第三种原因）', run: async () => ({ ok: 'nope' }) }
  ]
});
const t0 = Date.now();
const readAll = await lane.readAll(['fast', 'slow', 'boom', 'gate'], {});
const wall = Date.now() - t0;
const r = readAll.byId;
ok('快源照常出', r.fast.status === 'cold' && r.fast.value?.ok === 1, `${r.fast.status}`);
ok('慢源超时 ⇒ 降级，原因写「超时」', r.slow.status === 'degraded' && r.slow.reason === REASON.TIMEOUT,
  `${r.slow.status}/${r.slow.reason}（${r.slow.detail}）`);
ok('抛错源 ⇒ 降级，原因写「报错」+ 上游原话', r.boom.status === 'degraded' && r.boom.reason === REASON.ERROR
  && /上游 503/.test(String(r.boom.detail)), `${r.boom.reason}（${r.boom.detail}）`);
ok('未配置源 ⇒ 降级，原因写「未配置」，且根本没发生取数',
  r.gate.status === 'degraded' && r.gate.reason === REASON.NOT_CONFIGURED
  && lane.sli().sources.gate.fetches === 0, `${r.gate.reason}（${r.gate.detail}）`);
ok('整页总耗时没被慢源拖爆（慢源要 400 ms，实际 < 150 ms）', wall < 150, `${wall} ms`);
ok('降级计数按源分开记', lane.sli().sources.slow.degraded === 1 && lane.sli().sources.fast.degraded === 0,
  JSON.stringify({ slow: lane.sli().sources.slow.degraded, fast: lane.sli().sources.fast.degraded }));
ok('降级不影响下一次读（快源仍是真值）', (await lane.read('fast')).status === 'fresh');

console.log('\n=== [B] 总预算：预算比单源超时还紧时，报「总预算耗尽」而不是无限等 ===');
const tight = createLane({
  totalBudgetMs: 40,
  sources: [{ id: 'slowpoke', label: '超慢源', timeoutMs: 5000, run: async () => { await sleep(300); return { ok: 1 }; } }]
});
const t1 = Date.now();
const tiny = await tight.readAll(['slowpoke'], {});
const tightWall = Date.now() - t1;
ok('预算耗尽 ⇒ 降级，原因写「总预算耗尽」', tiny.byId.slowpoke.status === 'degraded'
  && tiny.byId.slowpoke.reason === REASON.BUDGET, `${tiny.byId.slowpoke.reason}`);
ok('确实按预算掐断（< 120 ms 就返回）', tightWall < 120, `${tightWall} ms`);

console.log('\n=== [C] 面板整屏：坏的只坏那一格，其余照出 ===');
// 现场注册两个坏源：一个抛错、一个超时（都落在「补丁健康」这一组里）
stateMod.registerSource({
  id: 'probe-boom',
  label: '夹具抛错源',
  group: 'patches',
  run: async () => { throw new Error('夹具：读不到上游'); },
  describe: () => ({ rows: [] })
});
stateMod.registerSource({
  id: 'probe-slow',
  label: '夹具超时源',
  group: 'patches',
  timeoutMs: 60,
  run: async () => { await sleep(500); return { ok: 1 }; },
  describe: () => ({ rows: [] })
});
stateMod.resetLanes();
const st = await stateMod.buildState({ config: { home, profile: 'web', webUrl: 'http://127.0.0.1:1' } });
const patchRows = st.groups.patches;
const boomRow = patchRows.find((x) => x.name === '夹具抛错源');
const slowRow = patchRows.find((x) => x.name === '夹具超时源');
ok('整页仍然成功返回（state.ok=true）', st.ok === true);
ok('坏源只在自己的组里多一行「不可探测」', patchRows.length >= 3 && !!boomRow && !!slowRow,
  `${patchRows.length} 行`);
ok('抛错那一格：不可探测 + 报错原因', /不可探测：报错/.test(boomRow.problems.join(' ')), boomRow.problems.join(' '));
ok('超时那一格：不可探测 + 超时原因', /不可探测：超时/.test(slowRow.problems.join(' ')), slowRow.problems.join(' '));
ok('其它组照常出（技能两条照出、跨表准入那格仍在）',
  st.groups.skills.length === 2 && st.groups.registry.length === 1,
  `skills=${st.groups.skills.length} registry=${st.groups.registry.length}`);
ok('正常源没被连坐（技能两条都是真值不是降级行）',
  st.groups.skills.every((s) => s.kind === 'skill' && !/不可探测/.test((s.problems ?? []).join(' '))));
ok('页脚 SLI 里降级事件逐条可点（id + 原因）',
  st.sli.degradeEvents.length === 2 && st.sli.degradeEvents.every((e) => e.id && e.reason),
  JSON.stringify(st.sli.degradeEvents));
ok('坏源没有让整页多等：超时那格按 60 ms 掐断（不是等满 500 ms）',
  (st.sli.request.sources.find((s) => s.id === 'probe-slow')?.elapsedMs ?? 9999) < 200,
  `probe-slow elapsed=${st.sli.request.sources.find((s) => s.id === 'probe-slow')?.elapsedMs} ms`);
ok('每一步都留了单源耗时（降级那格也有）',
  st.sli.request.sources.filter((s) => s.status === 'degraded').every((s) => typeof s.elapsedMs === 'number'));

stateMod.resetSources();
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
console.log(fail === 0 ? 'DEGRADE FIXTURE PASSED' : 'DEGRADE FIXTURE FAILED');
process.exitCode = fail === 0 ? 0 : 1;
