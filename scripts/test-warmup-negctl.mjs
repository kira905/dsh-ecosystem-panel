#!/usr/bin/env node
// scripts/test-warmup-negctl.mjs —— 夹具②：周期预热的**阴性对照**（不预热必须看得见冷窗）
//
// 一键跑：node scripts/test-warmup-negctl.mjs
// 退出码：0 = 全通过；1 = 有失败项（阴性对照没变红 = 本夹具失败）。
//
// 为什么这个夹具最重要的是"红"：
//   "预热生效"很容易自证 —— 随便跑跑都能说它快了。真正能证明它在工作的，是**把它关掉之后
//   冷窗回来了**（首屏 coldMiss 上升 + 有可测的取数延迟）。看不到冷窗 ⇒ 要么预热没关掉、
//   要么缓存键串了、要么两次跑的是同一条车道 —— 那这套"预热"就是装饰品。
//
// 两条场景共用同一个沙箱与同一份源清单，唯一差别是 warmup.enabled：
//   [开] 预热先填一遍 ⇒ 首屏零冷启动、耗时趋零
//   [关] 首屏自己冷取   ⇒ 冷启动计数 = 源数、耗时含慢源
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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-warmup-'));
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

const cfgMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'config.js')).href);
const stateMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'state.js')).href);
const warmMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'warmup.js')).href);
const { getConfig, resetConfig } = cfgMod;
const { buildState, getLane, registerSource, resetLanes, resetSources, setWarmupReporter } = stateMod;
const { startWarmup, DEFAULT_WARMUP_INTERVAL_MS, MIN_WARMUP_INTERVAL_MS } = warmMod;

// 一个"慢源"：让冷窗有可测的延迟（真实面板里这类源 = 外部 CLI / 网络查询）
const SLOW_MS = 150;
let slowCalls = 0;
registerSource({
  id: 'probe-slow',
  label: '慢探针（夹具）',
  group: 'probe',
  timeoutMs: 2000,
  async run() {
    slowCalls += 1;
    await sleep(SLOW_MS);
    return { calls: slowCalls };
  },
  describe: (v) => ({ rows: [], meta: { probeSlowCalls: v?.calls ?? null } })
});

const baseConfig = (extra = {}) => ({ home, profile: 'web', webUrl: 'http://127.0.0.1:1', ...extra });
// 预热"全部源"（*）：这样开/关的唯一差别就是"首屏要不要自己冷取"，读数最干净
const WARM_SOURCES = ['*'];

/** 跑一条"冷进程"场景：新配置 + 新车道 + 可选预热 */
async function scenario(enabled) {
  resetConfig();
  resetLanes();
  setWarmupReporter(null);
  const warmup = { enabled, intervalMs: 300000, sources: WARM_SOURCES };
  const cfg = getConfig(baseConfig({ warmup }));
  const lane = getLane(cfg);
  let warm = null;
  if (enabled) {
    warm = startWarmup({ lane, cfg });
    await warm.whenReady();
    setWarmupReporter(() => warm.status());
  }
  const before = lane.sli().totals;
  const t0 = Date.now();
  const state = await buildState({ config: baseConfig(), lane });
  const ms = Date.now() - t0;
  const after = lane.sli().totals;
  const result = {
    enabled,
    ms,
    // 计数是车道累计的 ⇒ 预热自己那次取数当然也算冷启动。这里取**增量** = 首屏这次花的
    coldMissDelta: after.coldMiss - before.coldMiss,
    coldMiss: after.coldMiss,
    srcStatuses: state.sli.request.sources.map((s) => s.status),
    totalMs: state.sli.request.totalMs,
    warmupSli: state.sli.warmup,
    skills: state.groups.skills.length,
    warmStatus: warm ? warm.status() : null
  };
  if (warm) {
    warm.stop();
    setWarmupReporter(null);
  }
  return result;
}

console.log('=== 预热缺省值（README 与配置层必须一致）===');
ok('预热缺省关闭（不许悄悄后台常驻）', warmMod.WARMUP_DEFAULTS.enabled === false);
ok('缺省周期 = 300 s（与 TTL 同源，不另定）', DEFAULT_WARMUP_INTERVAL_MS === 300000, String(DEFAULT_WARMUP_INTERVAL_MS));
ok('周期下限 5 s（再密就是白烧 CPU）', MIN_WARMUP_INTERVAL_MS === 5000, String(MIN_WARMUP_INTERVAL_MS));
const cfgDefault = getConfig(baseConfig());
ok('配置层缺省也是"关 + 300 s"', cfgDefault.warmup.enabled === false && cfgDefault.warmup.intervalMs === 300000,
  JSON.stringify(cfgDefault.warmup));
ok('三个环境变量口都在（开关 / 周期 / 预热哪些源）',
  ['warmupEnabled', 'warmupIntervalMs', 'warmupSources'].every((k) => k in cfgDefault.sources),
  JSON.stringify(Object.keys(cfgDefault.sources).filter((k) => k.startsWith('warmup'))));

console.log('\n=== 对拍照：预热开 vs 预热关（同一沙箱、同一源清单）===');
const ON = await scenario(true);
const OFF = await scenario(false);

const pad = (s, n) => String(s).padEnd(n);
console.log('\n  场景         首屏耗时   首屏冷启动  首屏未命中  首屏命中  源数  预热状态');
console.log('  ' + pad('预热开', 12) + pad(ON.totalMs + ' ms', 13) + pad(ON.coldMissDelta, 12) + pad(ON.srcStatuses.filter((x) => x === 'stale').length, 12) + pad(ON.srcStatuses.filter((x) => x === 'fresh').length, 10) + pad(ON.srcStatuses.length, 6) + '已跑 ' + (ON.warmStatus?.runs ?? 0) + ' 次');
console.log('  ' + pad('预热关', 12) + pad(OFF.totalMs + ' ms', 13) + pad(OFF.coldMissDelta, 12) + pad(OFF.srcStatuses.filter((x) => x === 'stale').length, 12) + pad(OFF.srcStatuses.filter((x) => x === 'fresh').length, 10) + pad(OFF.srcStatuses.length, 6) + '未开启');
console.log('');

ok('预热开：首屏零冷启动（全部命中缓存）', ON.coldMissDelta === 0 && ON.srcStatuses.every((x) => x === 'fresh'),
  `delta=${ON.coldMissDelta} / ${ON.srcStatuses.join(',')}`);
ok('预热开：预热器真的跑过一次，且把源都填好了',
  ON.warmStatus?.runs === 1 && Object.values(ON.warmStatus?.lastSources ?? {}).every((v) => v.status === 'cold' || v.status === 'fresh'),
  `runs=${ON.warmStatus?.runs} sources=${Object.keys(ON.warmStatus?.lastSources ?? {}).length}`);
ok('预热开：首屏耗时不含慢源（命中即回，几毫秒级）', ON.totalMs < 50, `${ON.totalMs} ms`);
// 源数：0.5.2 起多了一类「客户端装配」（client）⇒ 10 → 11。
// 这里钉的是"整屏照常出、不是靠少取数换来的快"，所以数字要与 listSources() 的条数一起改。
ok('预热开：整屏仍照常出（不是靠少取数换来的快）', ON.skills === 2 && ON.srcStatuses.length === 11,
  `skills=${ON.skills} sources=${ON.srcStatuses.length}`);

ok('🔴 预热关：冷窗确实出现（首屏 coldMiss = 源数）', OFF.coldMissDelta === OFF.srcStatuses.length,
  `delta=${OFF.coldMissDelta} / sources=${OFF.srcStatuses.length}`);
ok('🔴 预热关：首屏有可测的取数延迟（慢源那 ' + SLOW_MS + ' ms 跑不掉）', OFF.totalMs >= SLOW_MS,
  `${OFF.totalMs} ms`);
ok('🔴 阴性对照成立：开 vs 关的差距一眼可见',
  OFF.coldMissDelta > ON.coldMissDelta && OFF.totalMs >= ON.totalMs + 80,
  `首屏冷启动 ${ON.coldMissDelta} → ${OFF.coldMissDelta}；首屏 ${ON.totalMs} ms → ${OFF.totalMs} ms`);

console.log('\n  阴性对照读数：首屏冷启动 ' + ON.coldMissDelta + ' → ' + OFF.coldMissDelta
  + '；首屏耗时 ' + ON.totalMs + ' ms → ' + OFF.totalMs + ' ms（关掉预热就看得见冷窗 = 预热确实在工作）');

// 误开也挡住：周期被写成负数/0 时必须回到缺省，而不是变成"每毫秒一次"
const badCfg = getConfig(baseConfig({ warmup: { enabled: true, intervalMs: 0, sources: [] } }));
ok('周期给 0/负数时回落到缺省 300 s（不许变成空转）', badCfg.warmup.intervalMs === 300000, String(badCfg.warmup.intervalMs));

resetSources();
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
console.log(fail === 0 ? 'WARMUP NEGATIVE-CONTROL PASSED' : 'WARMUP NEGATIVE-CONTROL FAILED');
process.exitCode = fail === 0 ? 0 : 1;
