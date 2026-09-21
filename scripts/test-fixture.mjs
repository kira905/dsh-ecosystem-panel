#!/usr/bin/env node
// scripts/test-fixture.mjs —— 干净临时路径上的端到端夹具（**不需要任何真实 DSH 安装**）
//
// 干什么：在系统临时目录里现场造一个最小 DSH 数据根 ——
//   · 假 profile（package.json 的 bundles/dependencies + cordis.patch.yml + node_modules 实体）
//   · 假技能目录（一个合法 frontmatter、一个缺 description）
//   · 假外部工具脚本 4 个（解耦检查 / 档位 CLI / 跨表校验器 / 适配层一致性校验器，都是用最简 stub）
//   · 假宿主主包目录（用于 target=global 的补丁检查）
// 然后**直接驱动 lib/state.js 的取数层**（buildState），断言：
//   ① 六类体检都能跑出结果、且各自的判定与预期一致；
//   ② **缺数据必显式降级**（不可探测 + 原因），绝不显示 0 或假绿；
//   ③ 配置层停用类目 / 来源自证 / 坏输入回落这些边界也对。
//
// 全程不读、不写任何真实安装；唯一的外部访问是 npm registry（升级体检的"远端最新版"，
// 拿不到只会变成 errors 里的记录，不影响任何断言）。
//
// 用法：node scripts/test-fixture.mjs
// 退出码：0 = 全通过；1 = 有失败项。

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

// ---------------------------------------------------------------- 沙箱搭建
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-panel-fixture-'));
const home = path.join(sandbox, 'home');
const profileDir = path.join(home, 'profiles', 'web');
const profileNm = path.join(profileDir, 'node_modules');
const toolsDir = path.join(sandbox, 'tools');
const mainNm = path.join(sandbox, 'hostnm');
const skillsDir = path.join(home, 'skills');

const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
};
const writeJson = (p, obj) => write(p, JSON.stringify(obj, null, 2));

// ① 假 profile
writeJson(path.join(profileDir, 'package.json'), {
  name: 'fixture-profile',
  version: '0.0.0',
  dependencies: {
    'example-plugin': '1.0.0',
    'patchable-plugin': '2.0.0',
    'local-only-plugin': 'link:./local-only-plugin'
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'example-plugin', 'patchable-plugin'] } }
});
// ② 实体：一个有 client 声明，一个带了补丁特征
writeJson(path.join(profileNm, 'example-plugin', 'package.json'), {
  name: 'example-plugin', version: '1.0.0', dsh: { client: { inject: [], platform: 'web' } }
});
writeJson(path.join(profileNm, 'patchable-plugin', 'package.json'), { name: 'patchable-plugin', version: '2.0.0' });
write(path.join(profileNm, 'patchable-plugin', 'lib', 'client.js'), 'export const marker = "__PATCH_MARKER__";\n');
// ③ cordis.patch.yml（YAML 是 JSON 的超集 ⇒ 夹具用 flow 写法，真实 js-yaml 与夹具 stub 都能解析）
write(path.join(profileDir, 'cordis.patch.yml'),
  '[{"insert":[{"id":"fixture-insert","name":"example-plugin"}]},{"id":"disabled-thing","insert":[{"id":"disabled-insert","name":"patchable-plugin"}],"disabled":true}]\n');
// ④ 假技能
write(path.join(skillsDir, 'good-skill', 'SKILL.md'), '---\n{"name":"good-skill","description":"夹具技能：frontmatter 完整"}\n---\n正文\n');
write(path.join(skillsDir, 'bad-skill', 'SKILL.md'), '---\n{"name":"bad-skill"}\n---\n正文\n');
// ⑤ js-yaml 占位实现（真实环境里它由宿主 profile 的依赖链提供；夹具只需要它解析上面那种 flow 写法）
writeJson(path.join(profileNm, 'js-yaml', 'package.json'), { name: 'js-yaml', version: '0.0.0-fixture', main: 'index.js' });
write(path.join(profileNm, 'js-yaml', 'index.js'), "module.exports = { load: (t) => JSON.parse(t) };\n");
// ⑥ 假宿主主包（target=global 的检查目标）
writeJson(path.join(mainNm, '@deepseek-ai', 'dsh', 'package.json'), { name: '@deepseek-ai/dsh', version: '1.2.3' });
write(path.join(mainNm, '@deepseek-ai', 'dsh-host-package', 'lib', 'index.js'), 'export const x = 1;\n');
// ⑦ 四个外部工具 stub（本插件只消费它们的输出，判定逻辑在它们自己那边）
write(path.join(toolsDir, 'check-decoupling.mjs'), `
export const VERSION = '9.9.9-fixture';
export function scanRoot(dir) {
  return { error: null, results: [{
    name: 'example-plugin', scope: 'tools', version: '1.0.0',
    hardViolations: [],
    softViolations: [{ module: '@deepseek-ai/dsh-some-package', file: 'lib/a.js', line: 3 }],
    dependencies: [], clientInject: []
  }] };
}
export function scanProfilePackages() { return { results: [] }; }
`);
write(path.join(toolsDir, 'sync-host-adapter.mjs'), `
export function verifySummary() { return { level: 'ok', note: 'fixture: 2/2 副本一致' }; }
`);
write(path.join(toolsDir, 'registry-audit.mjs'), `
export const REGISTRY_AUDIT_VERSION = '9.9.9-fixture';
export function auditRegistries({ now, startedAt }) {
  return {
    ok: true,
    asOf: new Date(now).toISOString(),
    counts: { actions: 1, modules: 1, jobs: 1, stateFiles: 1 },
    byDomain: {}, problems: [], unavailable: [],
    source: { libVersion: REGISTRY_AUDIT_VERSION, libMtime: null, startedAt, pendingRestart: false }
  };
}
`);
write(path.join(toolsDir, 'upgrade-triage-cli.mjs'), `
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* 保持空 */ }
  const items = (payload.packages ?? []).map((p) => ({
    name: p.name,
    tier: p.name === 'patchable-plugin' ? 'yellow' : 'green',
    tierLabel: p.name === 'patchable-plugin' ? '夹具：可升（有大版本差）' : '夹具：最新',
    available: true,
    reasons: ['夹具判定：版本比较结果'],
    local: p.localVersion, target: p.targetVersion, targetSource: 'fixture'
  }));
  process.stdout.write(JSON.stringify({
    ok: true, items, tierSource: 'fixture-triage', cliVersion: '9.9.9-fixture',
    triageVersion: '9.9.9-fixture', cacheOnly: false, inputGaps: [], elapsedMs: 1
  }));
});
`);

// ---------------------------------------------------------------- 载入被测模块
// ⚠️ 必须在 import 之前设好数据根：lib/state.js 的 YAML 依赖是在**模块加载期**经
//    createRequire(<数据根>/profiles/<profile>/package.json) 解析的。
process.env.DSH_ECOSYSTEM_PANEL_HOME = home;
const stateMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'state.js')).href);
ok('YAML 依赖在夹具数据根上解析成功（模块加载期）', stateMod.YAML_AVAILABLE === true, String(stateMod.YAML_ERROR ?? ''));

const baseCfg = {
  home,
  profile: 'web',
  toolsDir,
  mainNm,
  // 故意指向一个不可达端口：验证"抓不到 boot 清单"时是显式未知，而不是被当成"未加载"
  webUrl: 'http://127.0.0.1:1',
  patchManifest: [
    {
      id: 'fixture-healthy', title: '夹具：健康补丁', script: 'patch-fixture-healthy.mjs',
      checks: [{ pkg: 'patchable-plugin', rel: 'lib/client.js', contains: ['__PATCH_MARKER__'] }]
    },
    {
      id: 'fixture-missing-feature', title: '夹具：特征丢失', script: 'patch-fixture-lost.mjs',
      checks: [{ pkg: 'patchable-plugin', rel: 'lib/client.js', contains: ['__NEVER_THERE__'] }]
    },
    {
      id: 'fixture-global-target', title: '夹具：宿主主包内目标', script: 'patch-fixture-global.mjs',
      checks: [{ target: 'global', pkg: '@deepseek-ai/dsh-nowhere', rel: 'lib/index.js', contains: ['x'] }]
    }
  ],
  upgradeRules: { 'example-plugin': { verdict: 'upgradable', label: '夹具：可升', note: '夹具规则文案' } },
  labels: { 'example-plugin': '夹具插件（有 client 声明）' }
};

// ---------------------------------------------------------------- [1] 全配置态：六类齐活
console.log('\n=== [1] 全配置态：六类体检都能跑出结果 ===');
const s1 = await stateMod.buildState({ config: baseCfg });
ok('① bundles 三条（core 一条 + 有实体两条）', s1.groups.bundles.length === 3, JSON.stringify(s1.groups.bundles.map((b) => b.name)));
const coreRow = s1.groups.bundles.find((b) => b.isCore);
ok('① core 包判绿（随主包发行）', coreRow?.status === 'green', coreRow?.status);
const exRow = s1.groups.bundles.find((b) => b.name === 'example-plugin');
ok('① 抓不到 boot 清单时 bootLoaded = null（未知，不当作未加载）', exRow?.bootLoaded === null);
ok('① 未知加载状态 → 黄色并说明原因', exRow?.status === 'yellow' && /加载状态未知/.test(exRow.problems.join(' ')), exRow?.status);
ok('① boot 抓取失败被如实记录', s1.meta.bootEntries === null && typeof s1.meta.bootError === 'string' && s1.meta.bootError.length > 0, s1.meta.bootError);
ok('① 配置字典里的简介被用上', exRow?.description === '夹具插件（有 client 声明）', exRow?.description);

ok('② inserts 两条（含一条 disabled）', s1.groups.inserts.length === 2, JSON.stringify(s1.groups.inserts.map((i) => i.id)));
ok('② 实体存在的 insert 判绿', s1.groups.inserts.find((i) => i.id === 'fixture-insert')?.status === 'green');
ok('② 被 disabled 的 insert 判黄且说明', s1.groups.inserts.find((i) => i.id === 'disabled-insert')?.status === 'yellow');
ok('② 被整个禁用的 id patch 被列出', Array.isArray(s1.groups.disabledPatchIds) && s1.groups.disabledPatchIds.includes('disabled-thing'), JSON.stringify(s1.groups.disabledPatchIds));
ok('② patch.yml 解析无错', s1.meta.patchYamlError === null, String(s1.meta.patchYamlError));

ok('③ 补丁清单条目数正确', s1.groups.patches.length === 3, String(s1.groups.patches.length));
ok('③ 特征齐全 → 绿', s1.groups.patches.find((p) => p.id === 'fixture-healthy')?.status === 'green');
const lost = s1.groups.patches.find((p) => p.id === 'fixture-missing-feature');
ok('③ 特征丢失 → 黄 + 指出缺哪个特征', lost?.status === 'yellow' && /缺特征/.test(lost.problems.join(' ')), lost?.problems?.[0]);
ok('③ 目标文件缺失 → 红（整体可能已卸载/未装）',
  s1.groups.patches.find((p) => p.id === 'fixture-global-target')?.status === 'red',
  JSON.stringify(s1.groups.patches.find((p) => p.id === 'fixture-global-target')?.problems));

ok('④ 技能两条都读到', s1.groups.skills.length === 2, String(s1.groups.skills.length));
ok('④ frontmatter 完整 → 绿', s1.groups.skills.find((s) => s.name === 'good-skill')?.status === 'green');
const badSkill = s1.groups.skills.find((s) => s.name === 'bad-skill');
ok('④ 缺 description → 黄 + 指出缺什么', badSkill?.status === 'yellow' && /description/.test(badSkill.problems.join(' ')), badSkill?.problems?.[0]);

ok('⑤ 档位来自外部只读 CLI（不是面板自算）', s1.upgradesMeta?.tier?.ok === true && s1.upgradesMeta.tier.tierSource === 'fixture-triage',
  String(s1.upgradesMeta?.tier?.tierSource));
const upRow = s1.groups.upgrades.find((u) => u.name === 'example-plugin');
ok('⑤ 插件行状态 = CLI 给的档位', upRow?.status === 'green' && upRow?.tier === 'green', upRow?.status);
ok('⑤ 另一包拿到 CLI 的黄色档位', s1.groups.upgrades.find((u) => u.name === 'patchable-plugin')?.status === 'yellow');
ok('⑤ 规则表文案只作注解、不决定颜色',
  (upRow?.verdictLabel ?? '').includes('夹具') || (upRow?.problems ?? []).some((p) => p.includes('规则表')),
  JSON.stringify({ label: upRow?.verdictLabel, problems: upRow?.problems }));
ok('⑤ 补丁关联被反查出来', upRow?.patchCount === 0 && s1.groups.upgrades.find((u) => u.name === 'patchable-plugin')?.patchCount === 2,
  String(s1.groups.upgrades.find((u) => u.name === 'patchable-plugin')?.patchCount));

ok('⑥ 解耦脚本被复用（不是复制判定）', s1.decouplingMeta?.scriptVersion === '9.9.9-fixture' && s1.decouplingMeta.packages === 1,
  JSON.stringify({ v: s1.decouplingMeta?.scriptVersion, n: s1.decouplingMeta?.packages }));
ok('⑥ 解耦明细进面板行', s1.groups.decoupling[0]?.name === 'example-plugin' && s1.groups.decoupling[0]?.r1Soft === 1);
ok('⑥ 档位输入拿到了 R5 结论（可选项配置了就生效）', s1.meta.config['scripts.hostAdapterSync'].value !== null);

ok('⑦ 跨表准入校验器分组状态 = ok', s1.registryMeta?.status === 'ok' && typeof s1.registryMeta.asOf === 'string', String(s1.registryMeta?.asOf));
ok('⑦ 校验器版本与来源如实回传', s1.registryMeta?.libVersion === '9.9.9-fixture' && /registry-audit\.mjs$/.test(String(s1.registryMeta?.lib)),
  String(s1.registryMeta?.lib));

ok('汇总计数与明细自洽', s1.summary.total === s1.groups.bundles.length + s1.groups.inserts.length + s1.groups.patches.length + s1.groups.skills.length + s1.groups.decoupling.length,
  JSON.stringify(s1.summary));
ok('面板版本从自身 package.json 读（不写死）', /^\d+\.\d+\.\d+$/.test(String(s1.meta.panelVersion)), String(s1.meta.panelVersion));
ok('配置来源自证里 toolsDir 标为 cli 层', s1.meta.config.toolsDir.from === 'cli', String(s1.meta.config.toolsDir.from));
ok('配置期无错误', Array.isArray(s1.meta.configErrors) && s1.meta.configErrors.length === 0, JSON.stringify(s1.meta.configErrors));

// ---------------------------------------------------------------- [2] 缺数据态：必须显式降级
console.log('\n=== [2] 缺数据态：不可探测 + 原因（绝不 0 / 假绿）===');
const s2 = await stateMod.buildState({ config: { home, webUrl: 'http://127.0.0.1:1' } });
ok('② patches 组给出「未配置」提示项（不是 0 条）', s2.groups.patches.length === 1 && s2.groups.patches[0].status === 'yellow'
  && /未配置补丁清单/.test(s2.groups.patches[0].problems.join(' ')), JSON.stringify(s2.groups.patches[0].problems));
ok('③ 该项不计入"健康"（title 明写未配置）', s2.groups.patches[0].title === '补丁清单未配置');
ok('⑥ 解耦组给出"未配置脚本"降级（黄色 + 原因）',
  s2.groups.decoupling.length === 1 && s2.groups.decoupling[0].status === 'yellow'
  && /未配置解耦检查脚本/.test(s2.groups.decoupling[0].problems.join(' ')), JSON.stringify(s2.groups.decoupling[0].problems));
ok('⑦ 跨表准入 = unavailable（**不是** 0/0/0 绿）', s2.registryMeta.status === 'unavailable'
  && /未配置跨表准入校验器/.test(String(s2.registryMeta.reason)), String(s2.registryMeta.reason));
ok('⑦ 面板行也标黄且写清"判定不可用"', s2.groups.registry[0].status === 'yellow' && /判定不可用/.test(s2.groups.registry[0].problems.join(' ')));
ok('⑤ 档位 CLI 未配置 ⇒ 档位不可用（未渲染颜色）',
  s2.upgradesMeta.tier.ok === false && /未配置档位判定 CLI/.test(String(s2.upgradesMeta.tier.reason)), String(s2.upgradesMeta.tier.reason));
ok('⑤ 所有插件行 status = unknown（绝不假绿）',
  s2.groups.upgrades.filter((u) => u.name !== '@deepseek-ai/dsh').every((u) => u.status === 'unknown'),
  JSON.stringify(s2.groups.upgrades.map((u) => [u.name, u.status])));
ok('⑤ 每行都带"档位不可用"的原因', s2.groups.upgrades.filter((u) => u.name !== '@deepseek-ai/dsh')
  .every((u) => (u.problems ?? []).some((p) => /档位不可用/.test(p))));
ok('meta.toolsDir = null（不编造工具目录）', s2.meta.toolsDir === null, String(s2.meta.toolsDir));
ok('② insert 仍能判（只依赖数据根，不依赖工具目录）', s2.groups.inserts.length === 2);

// ---------------------------------------------------------------- [3] 停用类目
console.log('\n=== [3] 配置停用类目：显式呈现、不计入汇总 ===');
const s3 = await stateMod.buildState({ config: { ...baseCfg, disabledGroups: ['patches'] } });
ok('停用组显示为「已按配置停用」提示项', s3.groups.patches.length === 1 && /已按配置停用/.test(s3.groups.patches[0].name), s3.groups.patches[0]?.name);
ok('停用组不计入 summary.total', s3.summary.total === s1.summary.total - 3, `${s3.summary.total} vs ${s1.summary.total}`);
ok('停用组仍如实报出配置值', JSON.stringify(s3.meta.disabledGroups) === '["patches"]', JSON.stringify(s3.meta.disabledGroups));

// ---------------------------------------------------------------- [4] 沙箱清理
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
ok('夹具沙箱已清理', !fs.existsSync(sandbox));

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
console.log(fail === 0 ? 'FIXTURE PASSED' : 'FIXTURE FAILED');
process.exitCode = fail === 0 ? 0 : 1;
