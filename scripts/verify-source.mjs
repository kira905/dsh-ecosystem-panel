#!/usr/bin/env node
// scripts/verify-source.mjs —— 发布前静态验证（**必跑**）
//
// 三件事：
//   ① 语法：对包内全部 `.mjs` / `.js` 跑 `node --check`
//   ② 配置层行为：路径解析优先级、清单加载与坏输入降级、停用类目、占位符展开（全部在系统临时目录里做，绝不写仓库）
//   ③ 脱敏扫描：本机路径 / 用户名 / 设备名 / 个人称呼 / 内部专有名 / 卡与会话 id 形态 / 凭证形态
//
// ⚠️ 本文件**不写任何真实机器名、用户名、本机路径、个人称呼或内部专有名**（否则等于把要藏的东西
//    写进要发布的仓）。规则表 = 「通用形态规则（永久生效）」+「环境标识规则（**由发布环境注入**）」。
//    · 通用形态：用户目录形态、盘符绝对路径、卡 id 形态、会话 id 形态、凭证形态 —— 与具体机器无关，永远生效。
//    · 环境标识：机器名 / 用户名 / 本机目录名 / 同步产品名 / 内部专有名 / 个人称呼 —— **只能靠注入**。
//      其中「内部专有名」「个人称呼」形态上无法枚举，**不注入就没有这条规则**，
//      所以发布前务必把环境变量带全（下面会打印本次到底加载了几条）。
//    注入方式（逗号或分号或竖线分隔，大小写不敏感）：
//      BUILD_MACHINE_NAMES   例：<主机名1>,<主机名2>
//      BUILD_USER_NAMES      例：<用户名1>,<用户名2>
//      BUILD_LAYOUT_ROOTS    例：<工作区目录名>,<测试根目录名>
//      BUILD_SYNC_PRODUCTS   例：<同步产品目录名>
//      BUILD_INTERNAL_TERMS  例：<内部项目代号>,<内部体系名>   ← 形态上无法枚举，必须注入
//      BUILD_PERSONAL_TERMS  例：<私人称呼1>,<私人称呼2>      ← **本文件里一个字都不写**
//    另外：③ 段末尾会对**本文件自身**再跑一遍「注入规则」，所以「扫描器自己没有夹带私人称呼与
//    内部专有名」是一条**可复跑的断言**，而不是一句人工声明。
//
// 用法：
//   node scripts/verify-source.mjs [包根]      # 包根默认 = 本文件的上一级
// 退出码：0 = 全部通过；1 = 有失败项。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] ?? path.join(HERE, '..'));
const SELF_REL = 'scripts/verify-source.mjs';

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!ok) fail += 1;
};

// ---------------------------------------------------------------- ① 语法

const codeFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.backups') continue;
    const full = path.join(dir, entry);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full);
    else if (['.mjs', '.js', '.cjs'].includes(path.extname(entry))) codeFiles.push(full);
  }
};
walk(ROOT);
for (const file of codeFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  check('syntax ' + rel, res.status === 0, (res.stderr || '').split('\n')[0] ?? '');
}

// ---------------------------------------------------------------- ② 配置层行为

const cfg = await import(pathToFileURL(path.join(ROOT, 'lib', 'config.js')).href);
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-panel-verify-'));
const fakeHome = path.join(sandbox, 'home');
fs.mkdirSync(path.join(fakeHome, 'profiles', 'web'), { recursive: true });
const cleanEnv = {};   // 与环境无关的空环境（配置层接受 env 入参，无需动 process.env）

// 默认值
const d0 = cfg.resolveConfig({}, cleanEnv);
check('默认数据根 = <home>/.dsh', d0.home === path.join(os.homedir(), '.dsh'), d0.home);
check('默认 profile = web 且拼出 profile 目录',
  d0.profileDir === path.join(os.homedir(), '.dsh', 'profiles', 'web'), d0.profileDir);
check('DSH_HOME 覆盖生效', cfg.resolveConfig({}, { DSH_HOME: fakeHome }).home === path.resolve(fakeHome));
check('DSH_ECOSYSTEM_PANEL_HOME 优先于 DSH_HOME',
  cfg.resolveConfig({}, { DSH_HOME: sandbox, DSH_ECOSYSTEM_PANEL_HOME: fakeHome }).home === path.resolve(fakeHome));
check('显式 cli.home 优先级最高',
  cfg.resolveConfig({ home: path.join(sandbox, 'x') }, { DSH_ECOSYSTEM_PANEL_HOME: fakeHome }).home === path.join(sandbox, 'x'));
check('cli.profile 覆盖 profile 名',
  cfg.resolveConfig({ home: fakeHome, profile: 'alt' }, cleanEnv).profileDir === path.join(fakeHome, 'profiles', 'alt'));

// 外部工具：**不自动猜**
check('未配置时 toolsDir = null（不猜路径）', d0.toolsDir === null, String(d0.toolsDir));
check('未配置时档位 CLI = null 且来源写明不可用',
  d0.scripts.triageCli.path === null && /unavailable/.test(String(d0.scripts.triageCli.from)),
  String(d0.scripts.triageCli.from));
const withTools = cfg.resolveConfig({ home: fakeHome, toolsDir: path.join(sandbox, 'tools') }, cleanEnv);
check('给了 toolsDir 后按默认相对名派生脚本路径',
  withTools.scripts.triageCli.path === path.join(sandbox, 'tools', 'upgrade-triage-cli.mjs'), withTools.scripts.triageCli.path);
check('env 显式指定脚本路径优先于 toolsDir 派生',
  cfg.resolveConfig({ home: fakeHome, toolsDir: sandbox }, { DSH_ECOSYSTEM_PANEL_TRIAGE_CLI: path.join(sandbox, 'my-cli.mjs') })
    .scripts.triageCli.path === path.join(sandbox, 'my-cli.mjs'));
check('显式 cli 参数优先级最高',
  cfg.resolveConfig({ toolsDir: sandbox, scripts: { triageCli: path.join(sandbox, 'cli2.mjs') } }, cleanEnv)
    .scripts.triageCli.path === path.join(sandbox, 'cli2.mjs'));

// 主包 node_modules：探测或显式
const withMain = cfg.resolveConfig({ home: fakeHome, mainNm: path.join(sandbox, 'pkgroot', 'node_modules') }, cleanEnv);
check('显式 mainNm 生效且 mainPkgDir = 其上一级',
  withMain.mainNm === path.join(sandbox, 'pkgroot', 'node_modules') && withMain.mainPkgDir === path.join(sandbox, 'pkgroot'),
  String(withMain.mainPkgDir));
check('未探测到主包布局时 mainNm = null（不编造）', cfg.resolveConfig({ home: fakeHome }, {}).mainNm === null);
// 自动探测：按「全局 npm 布局」探测；目录不存在则判不可用（并写明原因）
const roaming = path.join(sandbox, 'roaming');
const probedNm = path.join(roaming, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules');
fs.mkdirSync(probedNm, { recursive: true });
check('全局 npm 布局存在时自动探测命中（含 for 说明）',
  cfg.resolveConfig({ home: fakeHome }, { APPDATA: roaming }).mainNm === probedNm,
  String(cfg.resolveConfig({ home: fakeHome }, { APPDATA: roaming }).sources.mainNm.from));
check('APPDATA 在但布局不在 ⇒ 判不可用且写明原因',
  cfg.resolveConfig({ home: fakeHome }, { APPDATA: path.join(sandbox, 'nope') }).mainNm === null
  && /unavailable/.test(String(cfg.resolveConfig({ home: fakeHome }, { APPDATA: path.join(sandbox, 'nope') }).sources.mainNm.from)));

// 清单文件：正常 / 坏 JSON / 内联优先 / 占位符展开
const manifestFile = path.join(sandbox, 'patches.json');
fs.writeFileSync(manifestFile, JSON.stringify([{ id: 'p1', checks: [{ pkg: 'example-plugin', rel: 'lib/client.js' }] }]), 'utf8');
const withManifest = cfg.resolveConfig({ home: fakeHome, patchManifestFile: manifestFile }, cleanEnv);
check('清单文件被读入（数量正确）', Array.isArray(withManifest.patchManifest) && withManifest.patchManifest.length === 1);
const badFile = path.join(sandbox, 'bad.json');
fs.writeFileSync(badFile, '{ not json', 'utf8');
const withBad = cfg.resolveConfig({ home: fakeHome, patchManifestFile: badFile }, cleanEnv);
check('坏 JSON 不抛错、回落空表且记入 errors',
  withBad.patchManifest.length === 0 && withBad.errors.length === 1, JSON.stringify(withBad.errors).slice(0, 120));
check('内联 patchManifest 优先于文件',
  cfg.resolveConfig({ home: fakeHome, patchManifest: [{ id: 'inline' }], patchManifestFile: manifestFile }, cleanEnv)
    .patchManifest[0].id === 'inline');
const expanded = cfg.resolveConfig({
  home: fakeHome,
  patchManifest: [{ id: 'p2', special: { kind: 'no-sidecar-files', dir: '${HOME}/data' } }]
}, cleanEnv);
check('清单里的 ${HOME} 占位符被展开',
  path.normalize(expanded.patchManifest[0].special.dir) === path.join(path.resolve(fakeHome), 'data'),
  expanded.patchManifest[0].special.dir);

// 混合资产：core 白名单 / 停用类目 / 文案 / 来源自证
check('core 白名单默认 3 条官方内置包', d0.coreBundles.length === 3, d0.coreBundles.join(','));
check('core 白名单可追加且去重',
  cfg.resolveConfig({ coreBundles: ['x', '@deepseek-ai/dsh-base'] }, cleanEnv).coreBundles.length === 4);
const disabled = cfg.resolveConfig({}, { DSH_ECOSYSTEM_PANEL_DISABLED_GROUPS: 'patches,registry' });
check('停用类目按逗号解析且可查询', disabled.isGroupDisabled('patches') && disabled.isGroupDisabled('registry') && !disabled.isGroupDisabled('skills'));
const withText = cfg.resolveConfig({ text: { title: 'X' } }, cleanEnv);
check('文案覆盖被接受', withText.text.title === 'X', JSON.stringify(withText.text));
check('来源自证：覆盖了脚本四项与主要路径',
  Object.values(cfg.describeResolution(withTools)).every((v) => typeof v.from === 'string' && v.from.length > 0)
  && ['scripts.decoupling', 'scripts.triageCli', 'scripts.registryAudit', 'home', 'toolsDir'].every((k) => k in cfg.describeResolution(withTools)));
check('describeResolution 不泄露仓库自身的绝对路径',
  !JSON.stringify(cfg.describeResolution(withTools)).includes(ROOT));

// getConfig 单例与重置
cfg.resetConfig();
cfg.getConfig({ home: fakeHome });
cfg.setConfigOverride({ profile: 'web2' });
check('setConfigOverride 后 getConfig 反映新值（且不污染未覆盖键）',
  cfg.getConfig().profile === 'web2'
  && cfg.getConfig().home === cfg.resolveConfig({ profile: 'web2' }).home);
cfg.resetConfig();
check('resetConfig 后回到默认口径（与 resolveConfig({}) 一致）', cfg.getConfig().home === cfg.resolveConfig({}).home);
try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
check('配置层验证沙箱已清理', !fs.existsSync(sandbox));

// ---------------------------------------------------------------- ③ 脱敏扫描

// 注入值分隔符：逗号 / 分号 / 竖线都认。
// ⚠️ 竖线也必须认 —— 注入值最终是「多值拼成一条正则」（join('|')），所以「A|B」与「A,B」语义**完全相同**；
//    若不认竖线，用户按正则习惯写「A|B」会被 esc() 转义成一个字面量 ⇒ 规则静默哑火、扫描假装通过。
const envList = (name) => (process.env[name] ?? '')
  .split(/[,;|]/).map((s) => s.trim()).filter((s) => s.length >= 2)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
{
  process.env.__BUILD_SPLIT_PROBE = 'aa,bb;cc|dd'
  const sp = envList('__BUILD_SPLIT_PROBE')
  delete process.env.__BUILD_SPLIT_PROBE
  check('注入值分隔符：逗号 / 分号 / 竖线都认', sp.join(',') === 'aa,bb,cc,dd', sp.join(','))
}
const EXTRA_MACHINES = envList('BUILD_MACHINE_NAMES')
const EXTRA_USERS = envList('BUILD_USER_NAMES')
const EXTRA_ROOTS = envList('BUILD_LAYOUT_ROOTS')
const EXTRA_SYNC = envList('BUILD_SYNC_PRODUCTS')
// 内部专有名 / 项目代号：形态上无法枚举（既不是 id、也不是路径），**只能由发布环境注入**。
const EXTRA_TERMS = envList('BUILD_INTERNAL_TERMS')
// 个人称呼（机主 / 助手自称那一类）：**绝不写在本文件里** —— 本文件会进公开仓，
// 把私人称谓明文写进扫描器，等于换个地方把它公开。一律由发布环境注入：
//   BUILD_PERSONAL_TERMS=<称呼1>,<称呼2>,…
const EXTRA_PERSONAL = envList('BUILD_PERSONAL_TERMS')

// 通用形态规则：与具体机器无关，永远生效
const PATTERNS = [
  [/[\\/]Users[\\/](?!<|\$\{|%|<user>)[A-Za-z0-9._-]{2,}/, 'user profile dir'],
  [/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/](?!<|\$\{|%|<path>)[^\s'"`<>|?*]{2,}/, 'absolute windows path'],
  [/\b[0-9a-f]{8}\b/, 'card id shape (8-hex)'],
  [/\bsession-[0-9a-f]{8}\b/, 'session id shape'],
  [/\bsk-[A-Za-z0-9]{8,}/, 'api key'],
]
const GENERIC_COUNT = PATTERNS.length
// 环境标识规则：全部由 BUILD_* 注入（未注入 = 没有这条规则，通用形态规则兜底）；
// 单独存一份 INJECTED_PATTERNS，③ 段末尾要用它给**本文件自身**做自检。
const INJECTED_PATTERNS = []
if (EXTRA_SYNC.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_SYNC.map(esc).join('|'), 'i'), 'sync product (injected)'])
if (EXTRA_TERMS.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_TERMS.map(esc).join('|'), 'i'), 'internal proper name (injected)'])
if (EXTRA_PERSONAL.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_PERSONAL.map(esc).join('|'), 'i'), 'personal address (injected)'])
if (EXTRA_MACHINES.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_MACHINES.map(esc).join('|'), 'i'), 'machine name (injected)'])
if (EXTRA_USERS.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_USERS.map(esc).join('|'), 'i'), 'user name (injected)'])
if (EXTRA_ROOTS.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_ROOTS.map(esc).join('|'), 'i'), 'local layout root (injected)'])
PATTERNS.unshift(...INJECTED_PATTERNS)
const injected = EXTRA_MACHINES.length + EXTRA_USERS.length + EXTRA_ROOTS.length + EXTRA_SYNC.length
  + EXTRA_TERMS.length + EXTRA_PERSONAL.length
console.log('[i] 脱敏规则：通用 ' + GENERIC_COUNT + ' 条 + 注入 ' + injected + ' 条'
  + '（machine=' + EXTRA_MACHINES.length + ' user=' + EXTRA_USERS.length
  + ' layout=' + EXTRA_ROOTS.length + ' sync=' + EXTRA_SYNC.length
  + ' terms=' + EXTRA_TERMS.length + ' personal=' + EXTRA_PERSONAL.length + '）'
  + (injected
    ? ''
    : '  ← 未注入 BUILD_* 变量（MACHINE_NAMES / USER_NAMES / LAYOUT_ROOTS / SYNC_PRODUCTS / INTERNAL_TERMS'
      + ' / PERSONAL_TERMS），仅通用形态规则生效'))

const scanTargets = [...codeFiles]
for (const rel of ['README.md', 'CHANGELOG.md', 'LICENSE', 'docs/RELEASING.md', '.gitignore', 'package.json']) {
  const full = path.join(ROOT, rel)
  if (fs.existsSync(full) && !scanTargets.includes(full)) scanTargets.push(full)
}
for (const dir of ['examples', 'docs']) {
  const full = path.join(ROOT, dir)
  if (!fs.existsSync(full)) continue
  const stack = [full]
  while (stack.length) {
    const d = stack.pop()
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) stack.push(f)
      else if (!scanTargets.includes(f)) scanTargets.push(f)
    }
  }
}
let scannedLines = 0
let scanHits = 0
for (const file of scanTargets) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  // 本文件自身定义检测规则（规则文本里必然出现 "Users"、盘符这类**形态样例**），故不参与**通用**规则扫描；
  // 但它必须过**注入**规则 —— 见循环之后的自检段。
  if (rel === SELF_REL) continue
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    scannedLines += 1
    for (const [re, label] of PATTERNS) {
      if (!re.test(lines[i])) continue
      // 占位符形态（<...> / %VAR% / ${...}）不算命中
      const line = lines[i].replace(/<[^>]{1,60}>/g, '').replace(/%[A-Za-z_]+%/g, '').replace(/\$\{[^}]{1,60}\}/g, '')
      if (!re.test(line)) continue
      scanHits += 1
      check(`脱敏 ${rel}:${i + 1} [${label}]`, false, lines[i].trim().slice(0, 120))
    }
  }
}
check(`脱敏扫描完成（${scanTargets.length - 1} 文件 / ${scannedLines} 行 / 命中 ${scanHits}）`, scanHits === 0)

// 自检：**扫描器自己**不许夹带注入类标识（私人称呼 / 内部专有名 / 机器名 / 用户名 / 同步产品名）。
// 这些是「只有发布环境才知道的标识」，规则文本里本来就不该出现 —— 通用规则扫不了自身（规则文本
// 必然含形态样例），所以这里单独用注入规则再扫一遍，把「脚本自身已复核」变成可复跑断言。
// 注意：未注入时 INJECTED_PATTERNS 为空 ⇒ 本段是空判（会打印提示），发布前务必带全 BUILD_* 复跑。
const selfPath = path.join(ROOT, SELF_REL)
if (fs.existsSync(selfPath)) {
  const selfText = fs.readFileSync(selfPath, 'utf8')
  let selfHits = 0
  for (const [re, label] of INJECTED_PATTERNS) {
    if (!re.test(selfText)) continue
    selfHits += 1
    check(`自检 ${SELF_REL} [${label}]（扫描器自身不得夹带该标识）`, false, re.source)
  }
  check(`自检 ${SELF_REL}：${INJECTED_PATTERNS.length} 条注入规则 / 命中 ${selfHits}`
    + (INJECTED_PATTERNS.length ? '' : '（未注入 → 空判，请带全 BUILD_* 复跑）'), selfHits === 0)
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exitCode = fail === 0 ? 0 : 1
