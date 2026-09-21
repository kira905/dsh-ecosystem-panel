#!/usr/bin/env node
// scripts/verify-state.mjs —— 只读状态验证器（不依赖 GUI，也不需要面板打开）
//
// 它做的事：按配置层解析出数据根 / 工具目录 → 跑一遍六类体检 → 把结果与**配置来源自证**
// 一起打印出来。适合装在服务器上排查、或改完配置后确认"读到的是不是我想的那个数据根"。
//
// 用法：
//   node scripts/verify-state.mjs [选项]
//     --home <路径>           数据根（覆盖环境变量与默认值）
//     --profile <名字>        profile 名（默认 web）
//     --tools <路径>          外部工具目录
//     --config <路径>         配置文件 JSON
//     --patch-manifest <路径> 补丁清单 JSON
//     --web-url <url>         本实例基址（抓 boot 清单用；默认 http://127.0.0.1:3080）
//     --json <路径>           把完整状态写成本地 JSON 文件
//
// 说明：**只读**。唯一的写操作是 --json 指定的文件（以及升级体检自己的缓存文件，
//       位置 = 配置层 cacheFile）。退出码：0 = 跑通（**不代表全绿** —— 有红黄项会照实打印）；1 = 整体失败。

import fs from 'node:fs';
import { buildState } from '../lib/state.js';
import { describeResolution, getConfig } from '../lib/config.js';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const cli = {};
if (argOf('--home')) cli.home = argOf('--home');
if (argOf('--profile')) cli.profile = argOf('--profile');
if (argOf('--tools')) cli.toolsDir = argOf('--tools');
if (argOf('--config')) cli.configFile = argOf('--config');
if (argOf('--patch-manifest')) cli.patchManifestFile = argOf('--patch-manifest');
if (argOf('--web-url')) cli.webUrl = argOf('--web-url');

const jsonOut = argOf('--json');
const state = await buildState({ config: cli });
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(state, null, 2), 'utf8');

const cfg = getConfig(cli);
const line = (s = '') => console.log(s);
const mark = (s) => (s === 'green' ? '🟢' : s === 'yellow' ? '🟡' : s === 'red' ? '🔴' : '⬜');
const row = (item) => {
  const name = item.name ?? item.id ?? item.title ?? '(未命名)';
  const probs = (item.problems ?? []).length ? '  | ' + item.problems.join(' ; ') : '';
  return `  ${mark(item.status)} [${item.kind}] ${name}${probs}`;
};

line('============================================================');
line('dsh-ecosystem-panel 只读状态');
line(`  数据根    : ${state.meta.profileDir.replace(/[\\/]profiles[\\/].*$/, '')}`);
line(`  profile   : ${state.meta.profileDir}`);
line(`  技能目录  : ${state.meta.skillsDir}（ok=${state.meta.skillsDirOk}）`);
line(`  工具目录  : ${state.meta.toolsDir ?? '（未配置 ⇒ 依赖它的类目会显式降级）'}`);
line(`  面板版本  : ${state.meta.panelVersion}`);
line(`  boot 清单 : ${state.meta.bootEntries ?? '抓取失败'}${state.meta.bootError ? '  [' + state.meta.bootError + ']' : ''}`);
line(`  YAML 解析 : ${state.meta.yamlAvailable ? '可用' : '不可用（cordis.patch.yml 与技能 frontmatter 会判不可解析）'}`);
line(`  停用类目  : ${state.meta.disabledGroups.length ? state.meta.disabledGroups.join(', ') : '（无）'}`);
if (state.meta.configErrors?.length) line(`  ⚠ 配置错误: ${state.meta.configErrors.join(' | ')}`);
line(`  汇总      : 总 ${state.summary.total} = 🟢${state.summary.green} 🟡${state.summary.yellow} 🔴${state.summary.red}`);
line('============================================================');

line(`\n--- ① bundles（${state.groups.bundles.length}）---`);
for (const b of state.groups.bundles) {
  const ver = b.entityVersion ? ` v${b.entityVersion}` : (b.isCore ? ' (core)' : ' (无实体)');
  const boot = b.bootLoaded === null ? ' [boot 未知]' : (b.bootLoaded ? ' [boot ✓]' : ' [boot ✗]');
  line(row(b) + ver + boot);
}
line(`\n--- ② patch inserts（${state.groups.inserts.length}）---`);
for (const i of state.groups.inserts) line(row(i));
line(`整个被禁用的 id: [${(state.groups.disabledPatchIds ?? []).join(', ')}]   patch.yml 解析: ${state.meta.patchYamlError ?? '无错误'}`);
line(`\n--- ③ 补丁健康（${state.groups.patches.length}）---`);
for (const p of state.groups.patches) {
  line(row(p));
  for (const c of p.checks ?? []) {
    if (!c.fileExists) line(`      目标文件不存在/不可读: ${c.file}`);
    for (const s of c.missing ?? []) line(`      缺特征 "${s}"`);
    for (const s of c.forbiddenHit ?? []) line(`      残留应无特征 "${s}"`);
  }
  if (p.special && !p.special.ok) line(`      ${p.special.detail}`);
}
line(`\n--- ④ 技能（${state.groups.skills.length}）---`);
for (const s of state.groups.skills) line(row(s) + (s.fmName ? `  name="${s.fmName}"` : ''));
line(`\n--- ⑤ 升级体检（${state.groups.upgrades.length}）---`);
const tier = state.upgradesMeta?.tier ?? {};
line(`  档位来源: ${tier.ok === true ? `${tier.tierSource}（CLI ${tier.cliVersion ?? '?'}）` : `不可用：${tier.reason ?? '未提供'}`}`);
for (const u of state.groups.upgrades) {
  const ver = u.latest ? `${u.local ?? '?'} → ${u.latest}` : (u.local ?? '?');
  line(`  ${mark(u.status)} [upgrade] ${u.name}  ${ver}  ${u.verdictLabel ?? ''}${(u.problems ?? []).length ? '  | ' + u.problems.join(' ; ') : ''}`);
}
line(`\n--- ⑥ 解耦健康（${state.groups.decoupling.length}）---`);
line(`  脚本: ${state.decouplingMeta?.script ?? '（未配置）'}  ${state.decouplingMeta?.scriptVersion ? 'v' + state.decouplingMeta.scriptVersion : ''}  范围: ${state.decouplingMeta?.scope ?? '-'}`);
for (const d of state.groups.decoupling) line(row(d));
line(`\n--- ⑦ 跨表准入（可选类目）---`);
line(`  状态: ${state.registryMeta?.status ?? 'n/a'}${state.registryMeta?.reason ? '  ' + state.registryMeta.reason : ''}`);
line(`  校验器: ${state.registryMeta?.lib ?? '（未配置）'}${state.registryMeta?.libVersion ? ' v' + state.registryMeta.libVersion : ''}`);

line('\n--- 配置来源自证（每个键到底是从哪读到的）---');
for (const [k, v] of Object.entries(describeResolution(cfg))) {
  line(`  ${k.padEnd(24)} = ${String(v.value ?? '').padEnd(10)} ← ${v.from}`);
}
line('\nverify-state done.');
