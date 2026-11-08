// dsh-ecosystem-panel / lib/state.js
// 只读生态聚合逻辑（六类：bundles / patch inserts / 补丁健康 / 技能 / 升级体检 / 解耦健康）
// 供 lib/index.js（服务端 route）与 scripts/verify-state.mjs（standalone 验证）复用。
//
// ★ 通用化：路径与清单全部来自 lib/config.js（配置层）。本文件内**不写死任何绝对路径、
//   不内嵌任何个人环境的清单**。每个可选数据源缺失时走**显式降级**（status='yellow'/'unknown'
//   ＋ 原因），绝不显示 0、也不假装全绿。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildUpgradeState, getBreakingSymbols } from './upgrade.js';
import { getConfig, describeResolution } from './config.js';
import { createLane } from './fetch-lane.js';
import { API_PREFIX as PROTOCOL_API_PREFIX } from './host-protocol.js';

export const API_PREFIX = PROTOCOL_API_PREFIX;
export const PANEL_ID = 'dsh-ecosystem-panel';

// ---------------------------------------------------------------------------
// 路径推导（全部来自配置层；口径见 lib/config.js 头部）
//
// 历史坑（保留说明，避免回退）：DSH 数据根必须在**调用时**解析，不能在模块加载期固化成
// `<用户目录>/.dsh` —— 否则隔离实例（数据根指向别处）加载本插件时，读的仍是默认 home 的
// profiles / skills，缓存还写到默认 home。因此下面的 paths() 每次现读配置。
//
// 本文件另在加载期导出一份 HOME_DIR / PROFILE_DIR / … 常量（默认配置下的值），
// 仅供"打印现状"与旧调用点使用；**所有取数逻辑一律走 paths()**。
// ---------------------------------------------------------------------------
export function paths(cli) {
  return pathsFromConfig(getConfig(cli));
}
/** 由已解析的配置拼出路径表（车道要按同一份配置取数，所以这里单独暴露一半） */
export function pathsFromConfig(cfg) {
  return {
    cfg,
    HOME_DIR: cfg.home,
    PROFILE_DIR: cfg.profileDir,
    PROFILE_NM: cfg.profileNm,
    SHARED_NM: cfg.sharedNm,
    SKILLS_DIR: cfg.skillsDir,
    MAIN_NM: cfg.mainNm,
    MAIN_PKG_DIR: cfg.mainPkgDir,
    TOOLS_DIR: cfg.toolsDir,
    DSH_BOOT_URL: cfg.webUrl,
    CACHE_FILE: cfg.cacheFile
  };
}
const _bootPaths = paths();
export const HOME_DIR = _bootPaths.HOME_DIR;
export const PROFILE_DIR = _bootPaths.PROFILE_DIR;
export const PROFILE_NM = _bootPaths.PROFILE_NM;
// 共享模块 fallback 层（<HOME>/profiles/node_modules）：宿主在 profile 之外还有一层 fallback，
// 官方子包（及主包内嵌依赖）常由这一层提供。Node 的解析链是从 profile 目录逐级向上找
// node_modules，因此 insert 声明的 @deepseek-ai/* 官方子包命中的可能正是这一层 ——
// 只查 PROFILE_NM 会把生效中的 insert 误报成「实体缺失」。
export const SHARED_NM = _bootPaths.SHARED_NM;
export const SKILLS_DIR = _bootPaths.SKILLS_DIR;

// YAML 解析器（宿主 profile 里通常随主包自带 js-yaml）。
// ⚠️ 解析器不可用时**显式降级**：cordis.patch.yml 与技能 frontmatter 判为「不可解析」，
//    而不是静默当成空清单（那会把"读不到"伪装成"全绿"）。
let yaml = null;
let yamlLoadError = null;
try {
  const require = createRequire(path.join(_bootPaths.PROFILE_DIR, 'package.json'));
  yaml = require('js-yaml');
} catch (e) {
  yamlLoadError = String(e?.message ?? e);
}
export const YAML_AVAILABLE = yaml !== null;
export const YAML_ERROR = yamlLoadError;
/** 统一的"解析器不可用"文案 */
const YAML_HINT = 'YAML 解析器（js-yaml）不可用 ⇒ 该判据不可得出'
  + (yamlLoadError ? `：${yamlLoadError}` : '')
  + '。修法：确认数据根下 profiles/<profile> 的依赖链里能解析到 js-yaml（通常随宿主主包提供），'
  + '或用 DSH_ECOSYSTEM_PANEL_HOME 指向正确的数据根。';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function exists(p) { try { return fs.statSync(p).isFile() || fs.statSync(p).isDirectory(); } catch { return false; } }
/** scoped 包实体路径：node_modules/<name> 或 node_modules/@scope/<name> */
function entityDir(name, P) {
  const seg = name.startsWith('@') ? name.split('/') : [name];
  return path.join(P.PROFILE_NM, ...seg);
}
/**
 * insert 实体的解析结果（Node 解析链口径）：profile 自己的 node_modules 优先，
 * 其次共享 fallback 层；两层都读不到才算缺失。
 * @param {string} name 包名（含 scope 形式）
 * @param {object} P paths()
 * @returns {{ dir: string, source: 'profile'|'profiles-shared' } | null}
 */
function resolveEntity(name, P) {
  const seg = name.startsWith('@') ? name.split('/') : [name];
  for (const [nm, source] of [[P.PROFILE_NM, 'profile'], [P.SHARED_NM, 'profiles-shared']]) {
    const dir = path.join(nm, ...seg);
    if (readJson(path.join(dir, 'package.json'))) return { dir, source };
  }
  return null;
}
/**
 * 特征扫描目标文件解析：
 *   target='global' → 主包 node_modules/<pkg>/<rest>（主包布局未探测到 ⇒ 返回 null，由调用方降级）
 *   否则            → profile node_modules/<pkg>/<rest>
 */
function resolveCheckFile(fileSpec, P) {
  if (fileSpec.target === 'global') {
    if (!P.MAIN_NM) return null;
    return path.join(P.MAIN_NM, fileSpec.pkg, fileSpec.rel ?? '');
  }
  return path.join(P.PROFILE_NM, fileSpec.pkg, fileSpec.rel ?? '');
}

// ---------------------------------------------------------------------------
// 补丁特征表（**外置**：见 examples/patch-manifest.example.json）
// 条目形状（与旧版一致）：
//   { id, title, script, retired?, checks: [{ pkg, rel, target?: 'profile'|'global', contains?[], notContains?[] }],
//     special?: { kind: 'dir-has-file', pkg, dir, suffix, label } | { kind: 'no-sidecar-files', dir, suffix: ['.db-wal'], label } }
// checks：每个 check 全部满足才算健康（contains 缺一 = 特征丢失；notContains 命中 = 残留应无特征）。
// special：整体性判定（如"某目录下必须有某后缀文件" / "某目录不许有 -wal 残留"）。
// 字符串里可写 ${HOME} / ${PROFILE_NM} / ${MAIN_NM} / ${MAIN_PKG_DIR} 占位符（配置层展开成实际路径）。
// 默认**空清单**：本文件不内嵌任何环境的补丁表；未配置时该类显式降级为"不可判定"，不显示"0 个补丁"。
/** 取当前配置里的补丁清单 */
export function getPatchManifest(cfg = getConfig()) {
  return Array.isArray(cfg.patchManifest) ? cfg.patchManifest : [];
}

// ---------------------------------------------------------------------------
// boot entries（抓宿主 HTML 里的 __DSH_BOOT__ 清单，15s 缓存；URL 来自配置层）
// 抓不到不影响其它类目：bootLoaded 一律为 null（= 未知），绝不把"未知"渲染成"未加载"。
// ---------------------------------------------------------------------------
let bootCache = { at: 0, ids: null, error: null, url: null };
async function fetchBootEntries(P, force = false) {
  const now = Date.now();
  if (!force && bootCache.ids !== null && bootCache.url === P.DSH_BOOT_URL && now - bootCache.at < 15000) return bootCache;
  try {
    const res = await fetch(P.DSH_BOOT_URL + '/', { cache: 'no-store' });
    // 非 2xx **必须按"抓不到"处理**（ids=null = 未知），不能当成"清单里 0 条"：
    // 需要 token 的实例（`/?token=…`）对未认领的请求回 401，正文是"authentication required"。
    // 早先把它当空清单 ⇒ 每一行都报「boot 无 client 条目（疑似未加载/崩溃）」，纯属误报。
    if (!res.ok) {
      bootCache = {
        at: now,
        ids: null,
        error: `宿主首页返回 HTTP ${res.status}（需要 token？本面板服务端不带 cookie 抓取；该实例上 boot 清单不可读）`,
        url: P.DSH_BOOT_URL
      };
      return bootCache;
    }
    const html = await res.text();
    const m = /__DSH_BOOT__"\s*\]\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/.exec(html);
    const ids = [];
    if (m) {
      for (const im of m[1].matchAll(/"id":"([^"]+)"/g)) ids.push(im[1]);
    }
    bootCache = { at: now, ids, error: ids.length === 0 ? 'HTML 里未解析到 __DSH_BOOT__ entries' : null, url: P.DSH_BOOT_URL };
  } catch (e) {
    bootCache = { at: now, ids: null, error: String(e?.message ?? e), url: P.DSH_BOOT_URL };
  }
  return bootCache;
}

// ---------------------------------------------------------------------------
// ① bundles（profile package.json dsh.profile.bundles）
// ---------------------------------------------------------------------------
/** core 包白名单（默认 = 随宿主主包发行的内置包；可经配置追加） */
function coreBundlesOf(cfg) {
  return new Set(Array.isArray(cfg?.coreBundles) ? cfg.coreBundles : []);
}

/** 包名 → 一句话简介（面板可读性）。默认**空**：由使用者用 LABELS 配置提供（见 examples/）。
 *  没登记的包照常参与判定，只是没有简介 —— 简介缺失不影响任何状态色。 */
function labelsOf(cfg) {
  const l = cfg?.labels;
  return l && typeof l === 'object' && !Array.isArray(l) ? l : {};
}

function collectBundles(profilePkg, bootIds, P) {
  const deps = profilePkg?.dependencies ?? {};
  const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
  const coreBundles = coreBundlesOf(P.cfg);
  const labels = labelsOf(P.cfg);
  return bundles.map((name) => {
    const isCore = coreBundles.has(name);
    const declared = isCore ? null : (deps[name] ?? null);
    const ent = entityDir(name, P);
    const entPkg = readJson(path.join(ent, 'package.json'));
    const hasClientCapability = !!(entPkg?.dsh?.client) || !!(entPkg?.exports?.['./client']);
    const bootLoaded = bootIds === null ? null : bootIds.includes(name);
    const problems = [];
    let status = 'green';

    if (!isCore && !entPkg) {
      // 实体目录缺失（可能走 link 或主包路径 —— 有 boot 条目即实际加载，仅提示）
      if (bootLoaded === false) { status = 'red'; problems.push('声明在 bundles 且无实体目录、boot 无 client 条目'); }
      else if (bootLoaded === true) { status = 'yellow'; problems.push('无 profile 实体目录（link/主包提供），但 boot 已加载'); }
      else { status = 'yellow'; problems.push('无 profile 实体目录，加载状态未知'); }
    } else if (isCore) {
      status = 'green'; // core 内置：client 由子包提供，boot 有 50+ 官方条目即证在跑
    } else {
      // 实体在：查 client 声明 vs boot 加载
      if (hasClientCapability && bootLoaded === false) {
        status = 'red';
        problems.push('实体声明 client 能力但 boot 无加载条目（疑似未加载/崩溃）');
      } else if (bootLoaded === true) {
        status = 'green';
      } else if (hasClientCapability && bootLoaded === null) {
        // boot 清单拿不到（宿主未响应 / 基址配错）⇒ 客户端加载状态**未知**——
        // 这时绝不能渲染成绿（"读不到"与"已加载"是两回事）。
        status = 'yellow';
        problems.push('boot 清单不可用 ⇒ 客户端加载状态未知（这不是"已加载"）');
      }
      // 版本漂移：deps 声明（去 link: 前缀 / ^ 范围）≠ 实体 version
      if (declared !== null && entPkg?.version) {
        const cleanDeclared = declared.replace(/^link:/, '');
        if (/^\d/.test(cleanDeclared) && cleanDeclared !== entPkg.version) {
          if (status === 'green') status = 'yellow';
          problems.push(`声明 ${cleanDeclared} ≠ 实体 ${entPkg.version}（版本漂移）`);
        }
      }
      if (status === 'green' && problems.length === 0 && !hasClientCapability && bootLoaded !== false) {
        // 服务端插件（无 client）：实体在即绿
      }
    }
    return {
      kind: 'bundle', name, source: 'npm/github', declared, isCore,
      description: labels[name] ?? null,
      entityVersion: entPkg?.version ?? null,
      hasClientCapability, bootLoaded,
      status, problems
    };
  });
}

// ---------------------------------------------------------------------------
// ② cordis.patch.yml inserts（insert 声明的插件：实体是否存在）
// ---------------------------------------------------------------------------
function collectInserts(P) {
  const patchPath = path.join(P.PROFILE_DIR, 'cordis.patch.yml');
  const raw = readText(patchPath);
  if (raw === null) return { inserts: [], parseError: `cordis.patch.yml 读取失败（路径：${patchPath}）` };
  if (!yaml) return { inserts: [], parseError: YAML_HINT };
  let docs;
  try { docs = yaml.load(raw); } catch (e) { return { inserts: [], parseError: `cordis.patch.yml YAML 解析失败: ${e.message}` }; }
  const list = Array.isArray(docs) ? docs : [];
  const labels = labelsOf(P.cfg);
  const inserts = [];
  for (const doc of list) {
    if (!doc || typeof doc !== 'object') continue;
    for (const row of Array.isArray(doc.insert) ? doc.insert : []) {
      if (!row || typeof row !== 'object') continue;
      const id = String(row.id ?? '');
      const name = String(row.name ?? id);
      const ent = resolveEntity(name, P);
      const entPkg = ent ? readJson(path.join(ent.dir, 'package.json')) : null;
      const problems = [];
      let status = 'green';
      if (!entPkg) { status = 'red'; problems.push('insert 声明但实体目录缺失'); }
      if (doc.disabled === true) { status = 'yellow'; problems.push('被 disabled'); }
      inserts.push({
        kind: 'insert', id, name, source: 'patch insert',
        description: labels[name] ?? null,
        declaredVersion: entPkg?.version ?? null,
        entityExists: !!entPkg,
        entitySource: ent?.source ?? null,
        disabled: doc.disabled === true,
        status, problems
      });
    }
  }
  // 也收集 disabled 的 id patch（如官方 first-prompt provider 被禁）
  const disabledIds = list.filter((d) => d && typeof d === 'object' && d.disabled === true && d.id).map((d) => String(d.id));
  return { inserts, disabledIds, parseError: null };
}

// ---------------------------------------------------------------------------
// ②' 客户端装配（2026-11-09 新增 · 0.5.2）
//
// 为什么单开一类：上面两类都只看"文件在不在/特征在不在"，而 2026-11-09 实测到的那类
// 故障**文件全在、读数是绿的、界面上什么都没有**：
//   · 插件包自带的 cordis.patch.yml 里把 insert 的 name 写成了不带 scope 的旧名
//     （`dsh-butler-panel`），而从注册表装进 profile 的实体叫 `@kira905/dsh-butler-panel`
//     ⇒ 宿主解析不到那一行 ⇒ **宿主半根本没挂** ⇒ 它的 dsh.client 也不会被扫进 boot graph
//     ⇒ 侧边栏连入口都不出现，且没有任何报错（2026-11-09 A-8 关 4，桌面版实测）。
//   · 客户端 bundle 顶层 require 一个"名字与实际装着的包不一致"的 external（同一个坑的另一面）。
// 这一类的每个红项都带三段：**缺什么 / 该改哪个文件（或装哪个包） / 改完怎么验证** ——
// 目标是不翻源码、只照这几行字就能改回来。
//
// 全部离线判定（不抓 boot、不联网）：boot graph 里有没有这一行，取决于"宿主半挂上了没有"，
// 而挂没挂由 profile 的组合列表 + 自带 patch 的 name 解析结果决定，两样都在磁盘上。
// ---------------------------------------------------------------------------
/** 从 package.json 里取 dsh.client 声明（非对象 = 没声明）。 */
function clientDeclOf(pkg) {
  const c = pkg?.dsh?.client;
  return c && typeof c === 'object' ? c : null;
}
/** exports["./client"] → 相对路径（字符串或一层条件形式）。 */
function clientRelOf(pkg) {
  const c = pkg?.exports?.['./client'];
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && typeof c.default === 'string') return c.default;
  return null;
}
/** 在文本里找 `name: <value>` 那一行的行号（1 起；找不到回 null）。
 *  同时认 YAML 块写法（`name: 'x'` / `name: x`）与 JSON/flow 写法（`"name":"x"` / `"name": "x"`）——
 *  夹具里 js-yaml 被 stub 成 JSON.parse，两种写法都要能给出人话行号。 */
function lineOfNameAssignment(text, name) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const pats = [
    `name: '${name}'`, `name: "${name}"`, `name: ${name}`,
    `"name":"${name}"`, `"name": "${name}"`,
  ];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('#') || t.startsWith('//')) continue;
    if (pats.some((p) => t.includes(p))) return i + 1;
  }
  return null;
}
/**
 * 包名 → 实体；找不到时给出"最像的那个已装包"（用来把「名字对不上」说成人话）。
 * 找法：取名字的最后一段（scoped 名 @s/x 取 x，裸名取自己），在 profile 的
 * node_modules 下按「不带 scope 的 <tail>」与「各 @scope/<tail>」两处看看有没有一个
 * package.json#name 与之不同的包 —— 那就是"名字对不上"的真凶。
 * @returns {{ entity: object|null, suggestion: {name:string,dir:string,pkg:object}|null }}
 */
function locateWithSuggestion(name, P) {
  const entity = resolveEntity(name, P);
  if (entity) return { entity, suggestion: null };
  const tail = name.startsWith('@') ? (name.split('/')[1] ?? name) : name;
  const nm = P.PROFILE_NM;
  const candidates = [path.join(nm, tail)];
  let scopes = [];
  try {
    scopes = fs.readdirSync(nm, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && d.name.startsWith('@'))
      .map((d) => d.name);
  } catch { scopes = []; }
  for (const s of scopes) candidates.push(path.join(nm, s, tail));
  for (const dir of candidates) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg?.name && pkg.name !== name) return { entity: null, suggestion: { name: pkg.name, dir, pkg } };
  }
  return { entity: null, suggestion: null };
}

/**
 * 采客户端装配（离线）。
 * @param {object} profilePkg profile 的 package.json（可能为 null）
 * @param {object} P paths()
 */
function collectClientGraph(profilePkg, P) {
  const rows = [];
  const bundles = Array.isArray(profilePkg?.dsh?.profile?.bundles) ? profilePkg.dsh.profile.bundles : [];
  const profilePatchFile = path.join(P.PROFILE_DIR, 'cordis.patch.yml');
  const inserts = [];
  {
    const raw = readText(profilePatchFile);
    if (raw !== null && yaml) {
      let docs = null;
      try { docs = yaml.load(raw); } catch { docs = null; }
      for (const doc of Array.isArray(docs) ? docs : []) {
        if (!doc || typeof doc !== 'object') continue;
        for (const r of Array.isArray(doc.insert) ? doc.insert : []) {
          if (r && typeof r === 'object') inserts.push(String(r.name ?? r.id ?? ''));
        }
      }
    }
  }
  /** 判定一个包"是否已经被挂上"（在 bundles，或命中 profile 自己的 insert） */
  const mounted = (name) => bundles.includes(name) || inserts.includes(name);

  // — A 层：bundle 列表里的每一个包，实体在不在 —
  for (const name of bundles) {
    const { entity, suggestion } = locateWithSuggestion(name, P);
    if (entity) continue;
    const wantDir = entityDir(name, P);
    rows.push({
      kind: 'client',
      title: `缺模块：${name}`,
      status: 'red',
      description: `profile 的组合列表（dsh.profile.bundles）里有它，但 node_modules 里没有这个包的实体目录 —— 这个包的宿主半和客户端半都挂不上。`,
      problems: [
        `该改哪个文件：把 ${wantDir} 恢复成一个完整的包目录（最常见的原因：目录被改名/被删，或者 npm 装上的是别的名字）。` +
          (suggestion ? ` 现在这个位置上是 ${suggestion.name}（真名和组合列表里写的 ${name} 不一致）。` : ''),
        `改完怎么验证：刷新本面板，本条应变成绿色；命令行复验：node <安装器>\\bin\\dsh-butler-install.mjs --profile <profile>（第 N 项的"挂载"判据应 ✅）。`,
      ],
    });
  }

  // — B 层：每个包**自带的** cordis.patch.yml（dsh.bundle.patch）里 insert 的 name 能不能解析 —
  for (const bundleName of bundles) {
    const entity = resolveEntity(bundleName, P);
    if (!entity) continue;
    const pkg = readJson(path.join(entity.dir, 'package.json'));
    const patchRel = pkg?.dsh?.bundle?.patch;
    if (!patchRel) continue;
    const patchFile = path.resolve(entity.dir, patchRel);
    const text = readText(patchFile);
    if (text === null || !yaml) continue;
    let docs = null;
    try { docs = yaml.load(text); } catch { docs = null; }
    for (const doc of Array.isArray(docs) ? docs : []) {
      if (!doc || typeof doc !== 'object') continue;
      for (const r of Array.isArray(doc.insert) ? doc.insert : []) {
        if (!r || typeof r !== 'object') continue;
        const rowName = String(r.name ?? r.id ?? '');
        if (!rowName) continue;
        if (resolveEntity(rowName, P)) continue;
        const realName = pkg?.name ?? bundleName;
        if (rowName === realName) continue; // 真名解析不到已在 A 层报过
        const line = lineOfNameAssignment(text, rowName);
        rows.push({
          kind: 'client',
          title: `插件挂载不上：${realName}`,
          status: 'red',
          description:
            `这个包自带的挂载条目写的是 \`name: ${rowName}\`，而 profile 里根本没有叫这个名字的包 ⇒ ` +
            `宿主解析不到这一行、**宿主半不挂**，它的客户端半也就不会进 boot graph（症状：侧边栏没有入口，且没有任何报错）。`,
          problems: [
            `该改哪个文件：${patchFile}${line ? ` 第 ${line} 行` : ''} —— 把 \`name: ${rowName}\` 改成 \`name: '${realName}'\`（必须与 package.json 的 name 逐字一致）。`,
            `改完怎么验证：重启 DSH 后刷新本面板，本条应消失、同名的 bundle 行应变绿；或跑 node <安装器>\\bin\\dsh-butler-install.mjs --profile <profile> --only <该包> --apply（"挂载"判据应 ✅）。`,
          ],
        });
      }
    }
  }

  // — C 层：已挂上、声明了 dsh.client 的包，客户端产物在不在 —
  const clientOwners = [];
  for (const name of bundles) {
    const entity = resolveEntity(name, P);
    if (!entity) continue;
    const pkg = readJson(path.join(entity.dir, 'package.json'));
    const decl = clientDeclOf(pkg);
    if (!decl) continue;
    const owningName = pkg?.name ?? name;
    clientOwners.push({ name: owningName, dir: entity.dir, pkg, decl });
    const rel = clientRelOf(pkg);
    const file = rel ? path.join(entity.dir, rel) : null;
    if (!rel) {
      rows.push({
        kind: 'client',
        title: `客户端半缺声明：${owningName}`,
        status: 'red',
        description: 'package.json 里声明了 dsh.client，但没有 exports["./client"] ⇒ 宿主会以 "declares dsh.client but exports no \\"./client\\" bundle" 拒载。',
        problems: [
          `该改哪个文件：${path.join(entity.dir, 'package.json')} —— 补上 exports["./client"]（指向已经构建好的浏览器 bundle）。`,
          '改完怎么验证：重启 DSH 后刷新本面板，本条应消失；侧边栏/界面上该插件的入口应出现。',
        ],
      });
    } else if (!exists(file)) {
      rows.push({
        kind: 'client',
        title: `客户端产物缺失：${owningName}`,
        status: 'red',
        description: `exports["./client"] 指向的浏览器 bundle 不存在 ⇒ 宿主报 "client bundle not found; run pnpm run build before launch"。`,
        problems: [
          `该改哪个文件：补上 ${file}（重新构建该包，或重装：dsh plugin --profile <profile> add ${owningName}@<版本>）。`,
          '改完怎么验证：重启 DSH 后刷新本面板，本条应消失。',
        ],
      });
    }
  }

  // — D 层：external 的名字必须等于"某个已装包的 package.json#name"（行 id 就是它） —
  for (const owner of clientOwners) {
    const externals = Array.isArray(owner.decl.external) ? owner.decl.external : [];
    for (const raw of externals) {
      const ext = String(raw);
      const bare = ext.endsWith('/client') ? ext.slice(0, -'/client'.length) : ext;
      const { entity, suggestion } = locateWithSuggestion(bare, P);
      if (entity) {
        if (mounted(bare)) continue;
        rows.push({
          kind: 'client',
          title: `外部依赖没挂：${owner.name} → ${bare}`,
          status: 'red',
          description: `包的实体在，但它不在 profile 的组合列表里 ⇒ 宿主不会把它的客户端半放进 boot graph ⇒ ${owner.name} 里同步 require("${bare}") 会 MISS（整个客户端 bundle 崩，入口消失）。`,
          problems: [
            `该改哪个文件：${path.join(P.PROFILE_DIR, 'package.json')} 的 dsh.profile.bundles —— 加一行 "${bare}"（或用命令装一遍：dsh plugin --profile <profile> add ${bare}）。`,
            '改完怎么验证：重启 DSH 后刷新本面板，本条应消失；侧边栏该插件的入口应出现。',
          ],
        });
        continue;
      }
      rows.push({
        kind: 'client',
        title: `外部依赖名字对不上：${owner.name} → ${bare}`,
        status: 'red',
        description:
          `它 require("${bare}") 并把它声明成 external，但 profile 里没有 package.json#name 等于 "${bare}" 的包` +
          (suggestion ? `（装着的那个真名是 ${suggestion.name}）` : '（这个包压根没装）') +
          ' ⇒ 同步 require 必 MISS，整个客户端 bundle 在 factory 顶层就抛。',
        problems: [
          `该改哪个文件：${path.join(owner.dir, 'package.json')} 的 dsh.client.external，改成真名 ${suggestion ? `"${suggestion.name}"` : `（先装：dsh plugin --profile <profile> add ${bare}）`}；` +
            `同时该包 lib/client.js 里那一句 require("${bare}") 要改成同一个名字。`,
          '改完怎么验证：重启 DSH 后刷新本面板，本条应消失；侧边栏该插件的入口应出现。',
        ],
      });
    }
  }

  return {
    rows,
    meta: { clientCheckedBundles: bundles.length, clientOwners: clientOwners.map((o) => o.name) },
  };
}

// ---------------------------------------------------------------------------
// ③ 补丁健康（特征串扫描）
// ---------------------------------------------------------------------------
function checkSpecial(special, P) {
  if (special.kind === 'dir-has-file') {
    const dir = path.join(entityDir(special.pkg, P), special.dir);
    try {
      const files = fs.readdirSync(dir);
      const hit = files.find((f) => f.toLowerCase().endsWith(special.suffix));
      return { ok: !!hit, detail: hit ? `找到 ${hit}` : `${special.label} 缺失` };
    } catch { return { ok: false, detail: `目录不存在: ${dir}` }; }
  }
  if (special.kind === 'no-sidecar-files') {
    try {
      const files = fs.readdirSync(special.dir);
      const bad = files.filter((f) => special.suffix.some((s) => f.endsWith(s)));
      return { ok: bad.length === 0, detail: bad.length === 0 ? '无 -wal/-shm 残留' : `发现: ${bad.join(', ')}` };
    } catch { return { ok: false, detail: `目录不可读: ${special.dir}` }; }
  }
  return { ok: false, detail: 'unknown special' };
}

function collectPatches(P) {
  const manifest = getPatchManifest(P.cfg);
  if (manifest.length === 0) {
    // **显式降级**：清单为空 ≠ 没有补丁 ⇒ 该组不可判定，绝不显示"0 个补丁全绿"。
    return [{
      kind: 'patch', id: null, title: '补丁清单未配置', script: null, healthy: null, status: 'yellow',
      problems: ['未配置补丁清单 ⇒ 本类不可判定（这不代表"没有补丁"）。配置法：设 DSH_ECOSYSTEM_PANEL_PATCH_MANIFEST_FILE'
        + '=<JSON 路径>（条目形状见 examples/patch-manifest.example.json）；若本环境确实不做补丁体检，'
        + '用 disabledGroups=["patches"] 显式停用本类'],
      checks: [], special: null
    }];
  }
  // 带 retired 的条目（目标包已退役/能力已移植）不参与体检，避免长期假红淹没真信号。
  return manifest.filter((e) => !e.retired).map((entry) => {
    const checks = [];
    let fileMissing = false;
    for (const c of entry.checks ?? []) {
      const p = resolveCheckFile(c, P);
      if (p === null) {
        // 主包布局未探测到（global 类目标）⇒ 显式缺失，不伪造为"特征丢失"
        checks.push({
          file: `(主包 node_modules 未探测到：${c.pkg})`, fileExists: false,
          contains: c.contains ?? [], missing: c.contains ?? [], notContains: c.notContains ?? [], forbiddenHit: []
        });
        fileMissing = true;
        continue;
      }
      const text = readText(p);
      const fileExists = text !== null;
      if (!fileExists) fileMissing = true;
      const missing = (c.contains ?? []).filter((s) => text === null || !text.includes(s));
      const forbiddenHit = (c.notContains ?? []).filter((s) => text !== null && text.includes(s));
      checks.push({
        file: p,
        fileExists,
        contains: c.contains ?? [], missing,
        notContains: c.notContains ?? [], forbiddenHit
      });
    }
    let special = null;
    if (entry.special) {
      const r = checkSpecial(entry.special, P);
      special = { ...r, label: entry.special.label };
      if (!r.ok && !fileMissing) fileMissing = false;
    }
    const ok = checks.every((c) => c.fileExists && c.missing.length === 0 && c.forbiddenHit.length === 0)
      && (entry.special ? (special?.ok ?? false) : true);
    let status = 'green';
    const problems = [];
    if (!ok) {
      if (fileMissing) { status = 'red'; problems.push('补丁目标文件缺失（插件整体可能已卸载）'); }
      else { status = 'yellow'; problems.push('补丁特征丢失（插件更新/重装冲掉了定制，需重打补丁）'); }
      for (const c of checks) {
        for (const s of c.missing) problems.push(`缺特征: ${c.file.split(path.sep).slice(-2).join('/')} 无 "${s}"`);
        for (const s of c.forbiddenHit) problems.push(`残留应无特征: "${s}"`);
      }
      if (special && !special.ok) problems.push(special.detail);
    }
    return {
      kind: 'patch', id: entry.id, title: entry.title, script: entry.script,
      healthy: ok, status, problems,
      checks: checks.map((c) => ({ file: c.file, fileExists: c.fileExists, missing: c.missing, forbiddenHit: c.forbiddenHit })),
      special
    };
  });
}

// ---------------------------------------------------------------------------
// ④ 技能（<数据根>/skills 下各技能目录的 SKILL.md frontmatter）
// ---------------------------------------------------------------------------
function parseFrontmatter(text) {
  // 首个 --- 行到第二个 --- 行之间的内容
  const lines = text.split(/\r?\n/);
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) start = i;
      else { end = i; break; }
    }
  }
  if (start === -1 || end === -1) return { fm: null, bodyStart: 0, err: '没有 frontmatter（缺少 --- 围栏）' };
  const fmText = lines.slice(start + 1, end).join('\n');
  if (!yaml) return { fm: null, bodyStart: end + 1, err: YAML_HINT };
  try {
    const obj = yaml.load(fmText);
    return { fm: (obj && typeof obj === 'object') ? obj : null, bodyStart: end + 1, err: null };
  } catch (e) {
    return { fm: null, bodyStart: end + 1, err: `frontmatter YAML 解析失败: ${e.message}` };
  }
}

function collectSkills(P) {
  const out = [];
  let userDirOk = exists(P.SKILLS_DIR);
  if (userDirOk) {
    for (const d of fs.readdirSync(P.SKILLS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const name = d.name;
      const skillFile = path.join(P.SKILLS_DIR, name, 'SKILL.md');
      const text = readText(skillFile);
      const problems = [];
      let status = 'green';
      let fmName = null, fmDescription = null;
      if (text === null) {
        status = 'red';
        problems.push('目录无 SKILL.md');
      } else {
        const { fm, err } = parseFrontmatter(text);
        if (err) { status = 'yellow'; problems.push(err); }
        else {
          fmName = typeof fm?.name === 'string' ? fm.name : null;
          fmDescription = typeof fm?.description === 'string' ? fm.description : null;
          if (fmName === null || fmName === '') { if (status === 'green') status = 'yellow'; problems.push('frontmatter 缺 name'); }
          if (fmDescription === null || fmDescription === '') { if (status === 'green') status = 'yellow'; problems.push('frontmatter 缺 description'); }
        }
      }
      out.push({
        kind: 'skill', name, origin: 'user', dir: path.join(P.SKILLS_DIR, name),
        hasSkillMd: text !== null, fmName, fmDescription,
        description: fmDescription ?? null,
        status, problems
      });
    }
  }
  return { skills: out, userDirOk };
}

// ---------------------------------------------------------------------------
// ⑤ 升级体检（版本 + 兼容风险 + 补丁关联；只读，唯一写=自己的缓存文件）
// ---------------------------------------------------------------------------
async function collectUpgrades(profilePkg, force, decouplingInputs = null, P = paths()) {
  const labels = labelsOf(P.cfg);
  try {
    const r = await buildUpgradeState({
      profilePkg,
      profileNm: P.PROFILE_NM,
      mainPkgDir: P.MAIN_PKG_DIR,
      patchManifest: getPatchManifest(P.cfg),
      force,
      decouplingInputs,
      config: P.cfg
    });
    for (const it of r.items) {
      if (!it.description) it.description = labels[it.name] ?? null;
    }
    return r;
  } catch (e) {
    return {
      items: [],
      summary: { total: 0, green: 0, yellow: 0, red: 0, unknown: 0 },
      cacheAt: null,
      cacheSource: 'error',
      errors: { _: String(e?.message ?? e) },
      breaking: getBreakingSymbols(P.cfg),
      fetchedAt: new Date().toISOString(),
      tier: { ok: false, tierSource: 'unavailable', reason: `升级体检整体失败：${String(e?.message ?? e)}`, inputGaps: [], elapsedMs: null }
    };
  }
}

// ---------------------------------------------------------------------------
// ⑥ 解耦健康（R1 运行时 import / R2 依赖面）
//    复用外部解耦检查脚本的导出函数（动态 import），**不复制判定逻辑**——两处真相会漂移；
//    脚本未配置或不存在时只降级成一条 🟡（附原因），绝不让整份体检失败、也绝不假装通过。
// ---------------------------------------------------------------------------
async function collectDecoupling(P = paths()) {
  const scriptPath = P.cfg.scripts?.decoupling?.path ?? null;
  const meta = {
    script: scriptPath, scriptVersion: null, scope: null, imported: false,
    scriptFrom: P.cfg.scripts?.decoupling?.from ?? null
  };
  const fallback = (detail) => ({
    items: [{
      kind: 'decoupling', name: 'check-decoupling.mjs', scope: null,
      status: 'yellow', problems: [detail],
      description: '解耦检查未执行（脚本不可用）'
    }],
    meta
  });
  if (scriptPath === null) {
    return fallback('未配置解耦检查脚本（工具目录未指定）⇒ 本类不可判定。配置法：DSH_ECOSYSTEM_PANEL_TOOLS_DIR=<工具目录>'
      + ' 或 DSH_ECOSYSTEM_PANEL_DECOUPLING_SCRIPT=<脚本路径>；若本环境不做解耦体检，用 disabledGroups=["decoupling"] 停用本类');
  }
  if (!exists(scriptPath)) return fallback(`脚本不存在：${scriptPath}`);
  let mod;
  try {
    mod = await import(pathToFileURL(scriptPath).href);
  } catch (e) {
    return fallback(`脚本导入失败：${String(e?.message ?? e)}`);
  }
  if (typeof mod.scanRoot !== 'function') return fallback('脚本未导出 scanRoot（版本不匹配？）');
  meta.scriptVersion = typeof mod.VERSION === 'string' ? mod.VERSION : null;
  meta.imported = true;

  if (P.TOOLS_DIR === null) return fallback('已配置解耦脚本但未指定工具目录（DSH_ECOSYSTEM_PANEL_TOOLS_DIR）⇒ 无法确定扫描范围');
  const tools = mod.scanRoot(P.TOOLS_DIR);
  if (tools.error) return fallback(tools.error);
  const scanned = [...tools.results];
  meta.scope = `tools ${tools.results.length} 包`;
  if (typeof mod.scanProfilePackages === 'function') {
    try {
      const pr = mod.scanProfilePackages();
      scanned.push(...pr.results);
      meta.scope += ` + profile ${pr.results.length} 包`;
    } catch { /* profile 侧不可用不算失败 */ }
  }
  meta.packages = scanned.length;

  const items = scanned.map((r) => {
    const problems = [];
    for (const v of r.hardViolations) {
      problems.push(`R1 静态 import \`${v.module}\` → ${v.symbols.join(', ') || '（裸导入）'}（${v.file}:${v.line}）`);
    }
    for (const v of r.softViolations) {
      problems.push(`R1 动态导入 \`${v.module}\`（${v.file}:${v.line}）→ 需确认调用点有 try/catch 兜底`);
    }
    if (r.dependencies.length) problems.push(`R2 dependencies 未归零：${r.dependencies.join(', ')}`);
    if (r.clientInject.length) problems.push(`R2 client.inject 未归零：${r.clientInject.join(', ')}`);
    const status = r.hardViolations.length ? 'red' : (problems.length ? 'yellow' : 'green');
    return {
      kind: 'decoupling', name: r.name, scope: r.scope, version: r.version,
      status, problems,
      r1Hard: r.hardViolations.length, r1Soft: r.softViolations.length,
      depCount: r.dependencies.length, injectCount: r.clientInject.length,
      description: r.scope === 'profile'
        ? '本地包（源码只在 profile 实体，无独立工具目录）'
        : '本地包（工具目录源码）'
    };
  });
  // 把解耦结论**复用**给档位 CLI（`meta.triageInputs`），CLI 侧不再重复扫一遍全部包 ⇒ 首屏更快。
  //   口径来源（**不复制判定**）：
  //     · R1 计数 = 上面 `scanRoot`/`scanProfilePackages` **明细的聚合**（判定仍是外部脚本做的）；
  //     · R5 = 适配层一致性校验器（配置项，可缺）的 `verifySummary()`（只比 sha，几毫秒）；
  //           未配置 ⇒ 该项判"不可用"并在档位输入里如实标注（**不假绿**）。
  let triageInputs = { ok: false, reason: '解耦结论未产出' };
  try {
    const r5Script = P.cfg.scripts?.hostAdapterSync?.path ?? null;
    if (r5Script === null) throw new Error('未配置适配层一致性校验器（可选项）');
    const syncMod = await import(pathToFileURL(r5Script).href);
    if (typeof syncMod.verifySummary !== 'function') throw new Error('适配层一致性校验器未导出 verifySummary');
    const r5 = syncMod.verifySummary();
    triageInputs = {
      ok: true,
      r1HardCount: items.reduce((s, it) => s + (it.r1Hard ?? 0), 0),
      r1SoftCount: items.reduce((s, it) => s + (it.r1Soft ?? 0), 0),
      r1HardPackages: items.filter((it) => (it.r1Hard ?? 0) > 0).map((it) => it.name),
      r5Ok: r5?.level === 'ok',
      r5Note: r5?.note ?? null,
      source: 'panel:decoupling-section + host-adapter-sync.verifySummary'
    };
  } catch (e) {
    triageInputs = { ok: false, reason: `适配层一致性（R5）判定不可用：${String(e?.message ?? e)}` };
  }
  return { items, meta: { ...meta, triageInputs } };
}

// ---------------------------------------------------------------------------
// ⑦ 跨表准入一致性（可选类目）
//    判定唯一源 = 外部校验器（动态 import，**不复制判定**，与 collectDecoupling 同形）——
//    校验器路径由配置层给出（DSH_ECOSYSTEM_PANEL_REGISTRY_AUDIT_LIB），**未配置即整组 unavailable**。
//    ⚠️ **显式状态枚举 `ok / fail / unavailable`** ——**不许照抄 collectUpgrades 的 catch 形态**：
//       那个 catch 返 `summary 全 0 + ok:true` = **静默变绿**（同类错误不许再犯）；本函数把三态写在
//       `meta.status` 上，且 **`asOf` 缺失即判 unavailable**（显示"不可用"，**不是 0/0/0 绿**）。
//    只渲染不自算（判定实现只许有一份，就在外部校验器里 —— 这里只消费它的输出）；
//    纯只读：不写任何文件、不改开关、不发通知、不消费去重配额。
// ---------------------------------------------------------------------------
/** 跨表准入校验器路径（可选类目）：来自配置层；未配置即整组 unavailable（**不是绿**） */
function registryAuditLibPath(cfg) {
  return cfg?.scripts?.registryAudit?.path ?? null;
}

/** @param {{registryLibPath?:string, home?:string, root?:string, now?:number, startedAt?:number}} [opts]
 *         `registryLibPath` **仅供夹具**（把库指向沙箱/改名后的副本 ⇒ 实测 unavailable 反例）；
 *         `startedAt` 缺省 = **本进程启动时刻**（`Date.now() - process.uptime()*1000`）——
 *         面板跑的是**实体副本**、且它在进程启动时加载了当时的源仓 lib ⇒ "磁盘绿 ≠ 运行态绿"的判据就是它。 */
export async function collectRegistry(opts = {}) {
  const cfg = opts.config ?? getConfig();
  const libPath = opts.registryLibPath ?? registryAuditLibPath(cfg);
  const home = opts.home ?? cfg.home;
  const root = opts.root ?? (cfg.toolsDir ? path.dirname(cfg.toolsDir) : cfg.home);
  const nowMs = opts.now ?? Date.now();
  // 判定源新鲜度：校验库 mtime 晚于本进程启动时刻 ⇒ 该进程仍在跑旧代码（重启才生效）
  const startedAtMs = Number.isFinite(opts.startedAt)
    ? opts.startedAt
    : nowMs - Math.round(process.uptime() * 1000);
  const base = {
    lib: libPath, home, root, asOf: null, source: null, counts: null,
    checkFailed: null, problemCount: null, unavailableCount: null,
    problems: [], problemTotal: null, unavailable: [], unknown: [],
  };
  const unavailable = (reason, extra = {}) => ({ status: 'unavailable', ...base, reason, ...extra });
  let mod;
  try {
    if (libPath === null) {
      return unavailable('未配置跨表准入校验器 ⇒ 本组不可用（不是绿）。配置法：'
        + 'DSH_ECOSYSTEM_PANEL_REGISTRY_AUDIT_LIB=<校验器路径>；若本环境没有这类校验器，用 disabledGroups=["registry"] 停用本组');
    }
    if (!exists(libPath)) return unavailable(`校验器不存在：${libPath}`);
    mod = await import(pathToFileURL(libPath).href);
  } catch (e) {
    return unavailable(`校验器导入失败：${String(e?.message ?? e)}`);
  }
  if (typeof mod.auditRegistries !== 'function') return unavailable('校验器未导出 auditRegistries（版本不匹配？）');
  let r;
  try {
    r = mod.auditRegistries({ home, root, now: nowMs, startedAt: startedAtMs });
  } catch (e) {
    return unavailable(`校验器执行抛错：${String(e?.message ?? e)}`, { libVersion: mod.REGISTRY_AUDIT_VERSION ?? null });
  }
  // asOf 缺失 / 结构不对 ⇒ **unavailable**（判据：不许当 0/0/0 绿）
  if (!r || typeof r.asOf !== 'string' || !r.asOf) {
    return unavailable('校验器返回值缺 asOf ⇒ 判 unavailable（不许当 0/0/0 绿）', { libVersion: mod.REGISTRY_AUDIT_VERSION ?? null });
  }
  const problems = Array.isArray(r.problems) ? r.problems : [];
  const un = Array.isArray(r.unavailable) ? r.unavailable : [];
  const src = r.source ?? {};
  return {
    status: r.ok === true ? 'ok' : 'fail',
    ...base,
    libVersion: src.libVersion ?? mod.REGISTRY_AUDIT_VERSION ?? null,
    asOf: r.asOf,
    source: {
      lib: src.lib ?? (libPath ? path.basename(libPath) : null),
      libVersion: src.libVersion ?? mod.REGISTRY_AUDIT_VERSION ?? null,
      libMtime: src.libMtime ?? null,
      startedAt: src.startedAt ?? null,
      pendingRestart: src.pendingRestart ?? null,
    },
    counts: r.counts ?? null,
    checkFailed: Object.values(r.byDomain ?? {}).reduce((s, v) => s + Number(v?.failed ?? 0), 0),
    problemCount: problems.length,
    problemTotal: problems.length,
    unavailableCount: un.length,
    problems: problems.slice(0, 5).map((p) => `[${p.domain}] ${p.id} · ${p.check}：${p.detail}`),
    unavailable: un.slice(0, 5).map((u) => `[${u.domain}] ${u.check}：${u.detail}`),
    reason: r.ok === true
      ? null
      : (problems.length ? `差异 ${problems.length} 项（判定唯一源：registry-audit.mjs）` : `判定不可用 ${un.length} 项（**不是绿**）`),
  };
}

// ---------------------------------------------------------------------------
// 本插件自己的版本 + 停用提示（装配层小件）
// ---------------------------------------------------------------------------
/** 本插件自己的版本（从自身 package.json 读；**不写死**，避免发版时漏改一处） */
const SELF_VERSION = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return readJson(pkgPath)?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** 类目停用提示项（**显式呈现**为一条提示，不伪装成"0 项"、也不假装全绿） */
function disabledNotice(key) {
  return [{
    kind: key.replace(/s$/, ''),
    name: `${key}（已按配置停用）`,
    status: 'yellow',
    problems: [`该类体检被配置停用（disabledGroups 含 "${key}"）⇒ 不计入 summary，也不代表"全绿"`],
    description: '停用项：配置层 disabledGroups'
  }];
}

// ---------------------------------------------------------------------------
// 数据源清单（**参数化**）
//
// 首屏的每个格子 = 一个源。新增一个源 = 往 BUILTIN_SOURCES 里加一条（或在运行时
// registerSource()），**装配主流程 buildState 不用改一行** —— 这是本卡拿来证明
// "分片是参数化的"的判据（夹具里现场注册一个源跑通）。
//
// 每条源：
//   id         源名（也是 SLI / 预热清单里的键名）
//   label      页面上的中文名（降级时显示成「<label> 不可探测」）
//   group      落到面板哪个分组；不给 = 只贡献 meta、不出行
//   deps       依赖哪些源（跑之前先把它们读完；用 ctx.get(id) 取值，拿不到就是 undefined）
//   timeoutMs  单源缺省超时（配置层 sourceTimeouts / 环境变量可按 id 覆盖）
//   run(ctx)   只负责取数；**不许自己画降级**（降级是车道与装配层的事）
//   describe(v) 把取数结果翻成 { rows, meta, state }：
//                rows  → 面板行；meta → 并入 state.meta；state → 并入顶层字段 / 分组附加键
// ---------------------------------------------------------------------------
const BUILTIN_SOURCES = [
  {
    id: 'boot',
    label: 'boot 清单',
    timeoutMs: 1500,
    async run(ctx) {
      return fetchBootEntries(ctx.paths);
    },
    describe(v) {
      const ids = v?.ids ?? null;
      return {
        rows: [],
        meta: { bootEntries: ids === null ? null : ids.length, bootError: v?.error ?? null }
      };
    }
  },
  {
    id: 'profile',
    label: 'profile 清单',
    timeoutMs: 800,
    async run(ctx) {
      return readJson(path.join(ctx.paths.PROFILE_DIR, 'package.json'));
    },
    describe() {
      return { rows: [], meta: {} };
    }
  },
  {
    id: 'bundles',
    label: '插件包（bundle）',
    group: 'bundles',
    deps: ['profile', 'boot'],
    timeoutMs: 1500,
    async run(ctx) {
      const profilePkg = ctx.get('profile') ?? null;
      const bootIds = ctx.get('boot')?.ids ?? null;
      return collectBundles(profilePkg, bootIds, ctx.paths);
    },
    describe(v) {
      return { rows: Array.isArray(v) ? v : [] };
    }
  },
  {
    id: 'inserts',
    label: 'patch insert',
    group: 'inserts',
    timeoutMs: 1200,
    async run(ctx) {
      return collectInserts(ctx.paths);
    },
    describe(v) {
      return {
        rows: Array.isArray(v?.inserts) ? v.inserts : [],
        meta: { patchYamlError: v?.parseError ?? null },
        state: { groups: { disabledPatchIds: Array.isArray(v?.disabledIds) ? v.disabledIds : [] } }
      };
    }
  },
  {
    id: 'client',
    label: '客户端装配',
    group: 'client',
    deps: ['profile'],
    timeoutMs: 1500,
    async run(ctx) {
      return collectClientGraph(ctx.get('profile') ?? null, ctx.paths);
    },
    describe(v) {
      return {
        rows: Array.isArray(v?.rows) ? v.rows : [],
        meta: { clientCheckedBundles: v?.meta?.clientCheckedBundles ?? null }
      };
    }
  },
  {
    id: 'patches',
    label: '补丁健康',
    group: 'patches',
    timeoutMs: 1200,
    async run(ctx) {
      return collectPatches(ctx.paths);
    },
    describe(v) {
      return { rows: Array.isArray(v) ? v : [] };
    }
  },
  {
    id: 'skills',
    label: '技能',
    group: 'skills',
    timeoutMs: 1500,
    async run(ctx) {
      return collectSkills(ctx.paths);
    },
    describe(v) {
      return {
        rows: Array.isArray(v?.skills) ? v.skills : [],
        meta: { skillsDirOk: v?.userDirOk ?? null }
      };
    }
  },
  {
    id: 'decoupling',
    label: '解耦健康',
    group: 'decoupling',
    timeoutMs: 3000,
    async run(ctx) {
      return collectDecoupling(ctx.paths);
    },
    describe(v) {
      const items = Array.isArray(v?.items) ? v.items : [];
      const meta = v?.meta ?? {};
      const s = { green: 0, yellow: 0, red: 0, total: items.length };
      for (const it of items) s[it.status] = (s[it.status] ?? 0) + 1;
      return {
        rows: items,
        meta: {
          decouplingScript: meta.script ?? null,
          decouplingScriptVersion: meta.scriptVersion ?? null,
          decouplingScope: meta.scope ?? null
        },
        state: {
          decouplingMeta: {
            script: meta.script ?? null,
            scriptVersion: meta.scriptVersion ?? null,
            scope: meta.scope ?? null,
            packages: meta.packages ?? 0,
            summary: s
          }
        }
      };
    }
  },
  {
    id: 'upgrades',
    label: '升级体检',
    group: 'upgrades',
    deps: ['profile', 'decoupling'],
    // 唯一会出网的一格（查 npm 最新版）：慢一点可以等，但**必须**有上限 —— 上限到了就降级那一格，
    // 不能让它把整页按在转圈里。实测冷缓存一次 1.5~3 s，留足余量。
    timeoutMs: 12000,
    async run(ctx) {
      const profilePkg = ctx.get('profile') ?? null;
      const triageInputs = ctx.get('decoupling')?.meta?.triageInputs ?? null;
      return collectUpgrades(profilePkg, ctx.opts?.refreshUpgrades === true, triageInputs, ctx.paths);
    },
    describe(v) {
      return {
        rows: Array.isArray(v?.items) ? v.items : [],
        meta: { upgradeCacheAt: v?.cacheAt ?? null, upgradeCacheSource: v?.cacheSource ?? null },
        state: {
          upgradesMeta: {
            summary: v?.summary ?? { total: 0, green: 0, yellow: 0, red: 0, unknown: 0 },
            cacheAt: v?.cacheAt ?? null,
            cacheSource: v?.cacheSource ?? null,
            errors: v?.errors ?? {},
            breaking: v?.breaking ?? null,
            fetchedAt: v?.fetchedAt ?? null,
            tier: v?.tier ?? null
          }
        }
      };
    }
  },
  {
    id: 'registry',
    label: '跨表准入校验器',
    group: 'registry',
    timeoutMs: 3000,
    async run(ctx) {
      const o = ctx.opts ?? {};
      return collectRegistry({
        config: ctx.cfg,
        ...(typeof o.registryLibPath === 'string' ? { registryLibPath: o.registryLibPath } : {}),
        ...(typeof o.registryHome === 'string' ? { home: o.registryHome } : {}),
        ...(typeof o.registryRoot === 'string' ? { root: o.registryRoot } : {}),
        ...(Number.isFinite(o.registryNow) ? { now: o.registryNow } : {})
      });
    },
    describe(v) {
      const status = v?.status ?? 'unavailable';
      const row = {
        kind: 'registry',
        name: '跨表准入校验器',
        // 面板色域只有 green/yellow/red ⇒ unavailable 用 yellow；**权威枚举看 registryMeta.status**
        status: status === 'ok' ? 'green' : (status === 'fail' ? 'red' : 'yellow'),
        problems: status === 'unavailable' ? [`判定不可用：${v?.reason}`] : (v?.problems ?? []),
        description: status === 'ok'
          ? '跨表准入零差集（判定唯一源 = 外部校验器，本面板只渲染不自算）'
          : v?.reason
      };
      return {
        rows: [row],
        state: {
          registryMeta: {
            status,
            asOf: v?.asOf ?? null,
            reason: v?.reason ?? null,
            lib: v?.lib ?? null,
            libVersion: v?.libVersion ?? null,
            source: v?.source ?? null,
            home: v?.home ?? null,
            root: v?.root ?? null,
            counts: v?.counts ?? null,
            checkFailed: v?.checkFailed ?? null,
            problemCount: v?.problemCount ?? null,
            problemTotal: v?.problemTotal ?? null,
            unavailableCount: v?.unavailableCount ?? null,
            problems: v?.problems ?? [],
            unavailable: v?.unavailable ?? []
          }
        }
      };
    }
  }
];

let SOURCES = BUILTIN_SOURCES.slice();

/**
 * 运行时追加 / 覆盖一个数据源（下游插件可以把自己的健康片挂进这块面板；夹具也用它
 * 证明"源清单是参数化的、加源不用改主流程"）。
 * @param {{id:string,label?:string,group?:string,deps?:string[],timeoutMs?:number,
 *          requires?:(ctx:object)=>(string|null),run:(ctx:object)=>any,describe?:(v:any)=>object}} def
 */
export function registerSource(def) {
  if (!def || typeof def.id !== 'string' || typeof def.run !== 'function') {
    throw new Error('registerSource: 至少需要 { id, run }');
  }
  const at = SOURCES.findIndex((s) => s.id === def.id);
  if (at >= 0) SOURCES[at] = def;
  else SOURCES.push(def);
  return def;
}
/** 当前生效的源清单（顺序 = 装配顺序） */
export function listSources() {
  return SOURCES.slice();
}
/** 回到内置清单（夹具收尾用） */
export function resetSources() {
  SOURCES = BUILTIN_SOURCES.slice();
}

// ---------------------------------------------------------------------------
// 取数车道（每个配置指纹一条）：
//   TTL 缓存 + SWR / 单飞 / 超时预算 / 局部降级 全在 fetch-lane 里，
//   这里只负责"按当前配置建一条、并保证源清单变化时同步进车道"。
// ---------------------------------------------------------------------------
const lanes = new Map();
const LANE_LIMIT = 4;

function laneFingerprint(cfg, opts = {}) {
  return JSON.stringify({
    home: cfg.home,
    profile: cfg.profile,
    webUrl: cfg.webUrl,
    toolsDir: cfg.toolsDir,
    mainNm: cfg.mainNm,
    cacheFile: cfg.cacheFile,
    scripts: cfg.scripts,
    patchManifest: cfg.patchManifest,
    upgradeRules: cfg.upgradeRules,
    breakingSymbols: cfg.breakingSymbols,
    labels: cfg.labels,
    text: cfg.text,
    disabledGroups: cfg.disabledGroups,
    coreBundles: cfg.coreBundles,
    ttlMs: cfg.ttlMs,
    sourceTimeoutMs: cfg.sourceTimeoutMs,
    totalBudgetMs: cfg.totalBudgetMs,
    sourceTimeouts: cfg.sourceTimeouts,
    registryLibPath: opts.registryLibPath ?? null,
    registryHome: opts.registryHome ?? null,
    registryRoot: opts.registryRoot ?? null,
    registryNow: opts.registryNow ?? null
  });
}

/** 取（或建）当前配置对应的车道；源清单新增项会自动补进去 */
export function getLane(cfg = getConfig(), opts = {}) {
  const key = laneFingerprint(cfg, opts);
  let lane = lanes.get(key);
  if (!lane) {
    lane = createLane({
      sources: SOURCES,
      ttlMs: cfg.ttlMs,
      defaultTimeoutMs: cfg.sourceTimeoutMs,
      totalBudgetMs: cfg.totalBudgetMs,
      // 预热器调用 lane.prime() 时只给源名（它不该知道路径怎么拼），所以路径放进车道级上下文
      context: { cfg, paths: pathsFromConfig(cfg) },
      ...(typeof opts.now === 'function' ? { now: opts.now } : {})
    });
    lanes.set(key, lane);
    while (lanes.size > LANE_LIMIT) lanes.delete(lanes.keys().next().value);
  }
  for (const def of SOURCES) if (!lane.defs.has(def.id)) lane.addSource(def);
  return lane;
}
/** 丢开所有车道（夹具 / 重启后重来） */
export function resetLanes() {
  lanes.clear();
}

// ---------------------------------------------------------------------------
// 预热状态上报（由 lib/index.js 注册；buildState 只读不建 —— 别在纯取数路径里起定时器）
// ---------------------------------------------------------------------------
let warmupReporter = null;
/** @param {null | (() => object)} fn */
export function setWarmupReporter(fn) {
  warmupReporter = typeof fn === 'function' ? fn : null;
}
function warmupStatus() {
  if (warmupReporter === null) return { enabled: false, reason: '未挂预热器（面板未起在宿主里时属正常）' };
  try {
    return warmupReporter();
  } catch (error) {
    return { enabled: false, reason: `预热状态读取失败：${String(error?.message ?? error)}` };
  }
}

// ---------------------------------------------------------------------------
// 降级行的统一画法
// ---------------------------------------------------------------------------
function degradeRow(source, res) {
  const why = `${res.reason ?? '不可探测'}${res.detail ? `（${res.detail}）` : ''}`;
  return {
    kind: source.rowKind ?? source.id,
    name: source.label ?? source.id,
    status: 'yellow',
    problems: [`不可探测：${why}${res.coolingDown ? ' —— 失败冷却中，稍后自动重试' : ''}`],
    description: `${source.label ?? source.id} 本次没取到数；**只有这一格受影响**，其余类目照常出`
  };
}

// ---------------------------------------------------------------------------
// 汇总（装配）
// ---------------------------------------------------------------------------
const GROUP_KEYS = ['bundles', 'inserts', 'client', 'patches', 'skills', 'decoupling', 'upgrades', 'registry'];
// 计数口径保持不变（前五类）：新增的 client 类只在自己的 Tab 上有红黄计数，
// 不改顶栏那行「N 正常 / N 风险 / N 异常」的分母 —— 那一行要与历史读数可比。
const COUNTED_GROUPS = ['bundles', 'inserts', 'patches', 'skills', 'decoupling'];

/**
 * 跑一遍首屏取数并装配状态。
 * @param {object} [options]
 * @param {object} [options.config]          配置层显式覆盖（夹具 / verify-state 用）
 * @param {boolean} [options.refreshUpgrades] 强制重查升级体检（等价于只刷新 upgrades 这一源）
 * @param {boolean|string[]} [options.force]  强制刷新（true = 全部源；数组 = 指定源）
 * @param {object} [options.lane]            直接注入车道（夹具用；缺省按配置指纹取）
 * @param {Function} [options.now]           时钟（夹具注入假时钟用）
 */
export async function buildState(options = {}) {
  const P = paths(options.config ?? null);
  const cfg = P.cfg;
  const lane = options.lane ?? getLane(cfg, options);
  const sources = listSources();
  const ids = sources.map((s) => s.id);

  const force = options.force === true
    ? true
    : [
      ...(Array.isArray(options.force) ? options.force : []),
      ...(options.refreshUpgrades === true ? ['upgrades'] : [])
    ];

  const read = await lane.readAll(ids, {
    force,
    cfg,
    paths: P,
    opts: {
      refreshUpgrades: options.refreshUpgrades === true,
      sourceTimeouts: cfg.sourceTimeouts,
      registryLibPath: options.registryLibPath,
      registryHome: options.registryHome,
      registryRoot: options.registryRoot,
      registryNow: options.registryNow
    }
  });

  const groups = {};
  const extraGroups = {};
  const top = {};
  const freshness = { ttlMs: lane.ttlMs, stale: false, oldestAgeMs: null, sources: {} };
  const degradeEvents = [];
  const requestSources = [];
  const meta = {
    profileName: cfg.profile,
    profileDir: P.PROFILE_DIR,
    skillsDir: P.SKILLS_DIR,
    // 下面这些是"源没取到"时的**中性缺省**：显式 null/空，不编造、也不假绿
    bootEntries: null,
    bootError: null,
    patchYamlError: null,
    skillsDirOk: null,
    panelVersion: SELF_VERSION,
    upgradeCacheAt: null,
    upgradeCacheSource: null,
    decouplingScript: null,
    decouplingScriptVersion: null,
    decouplingScope: null,
    toolsDir: P.TOOLS_DIR,
    disabledGroups: cfg.disabledGroups,
    yamlAvailable: YAML_AVAILABLE,
    config: describeResolution(cfg),
    configErrors: cfg.errors,
    // 界面文案覆盖：有值则前端用它替代内置中性文案（见 lib/client.js）
    ui: Object.keys(cfg.text).length ? cfg.text : null
  };
  const registryMetaDefault = {
    status: 'unavailable', asOf: null, reason: '本次未取到跨表准入结论（该源降级）',
    lib: null, libVersion: null, source: null, home: null, root: null, counts: null,
    checkFailed: null, problemCount: null, problemTotal: null, unavailableCount: null,
    problems: [], unavailable: []
  };
  const upgradesMetaDefault = {
    summary: { total: 0, green: 0, yellow: 0, red: 0, unknown: 0 },
    cacheAt: null, cacheSource: null, errors: {}, breaking: getBreakingSymbols(cfg),
    fetchedAt: null, tier: null
  };
  const decouplingMetaDefault = { script: null, scriptVersion: null, scope: null, packages: 0, summary: { green: 0, yellow: 0, red: 0, total: 0 } };

  for (const source of sources) {
    const res = read.byId[source.id];
    const ok = res !== undefined && res.status !== 'degraded';
    requestSources.push({
      id: source.id,
      label: source.label ?? source.id,
      status: res?.status ?? 'missing',
      elapsedMs: res?.elapsedMs ?? null,
      ageMs: res?.ageMs ?? null,
      reason: res?.reason ?? null
    });

    if (ok) {
      const block = source.describe ? (source.describe(res.value) ?? {}) : {};
      const rows = Array.isArray(block.rows) ? block.rows : [];
      if (source.group) groups[source.group] = (groups[source.group] ?? []).concat(rows);
      Object.assign(meta, block.meta ?? {});
      Object.assign(top, block.state ?? {});
      if (block.state?.groups) Object.assign(extraGroups, block.state.groups);
      freshness.sources[source.id] = {
        status: res.status,
        stale: res.status === 'stale',
        fetchedAt: new Date(res.fetchedAt).toISOString(),
        ageMs: res.ageMs
      };
      if (res.status === 'stale') {
        freshness.stale = true;
        freshness.oldestAgeMs = Math.max(freshness.oldestAgeMs ?? 0, res.ageMs ?? 0);
      }
    } else {
      // 局部降级：只有这一格标「不可探测 + 原因」，其余源照常出
      const degraded = res ?? { reason: '未取到', detail: null };
      if (source.group) groups[source.group] = (groups[source.group] ?? []).concat([degradeRow(source, degraded)]);
      degradeEvents.push({
        id: source.id,
        label: source.label ?? source.id,
        reason: degraded.reason ?? '未知',
        detail: degraded.detail ?? null,
        coolingDown: degraded.coolingDown === true
      });
      freshness.sources[source.id] = {
        status: 'degraded',
        stale: false,
        fetchedAt: null,
        ageMs: null,
        reason: degraded.reason ?? null
      };
    }
  }

  // 分组附加键（例如 disabledPatchIds）落在分组表里；没有就显式给空数组（与旧输出一致）
  groups.disabledPatchIds = extraGroups.disabledPatchIds ?? [];

  // 配置层停用类目：显式呈现为一条"已停用"项（**不伪装成 0 项**），且不计入 summary
  for (const key of GROUP_KEYS) {
    if (cfg.isGroupDisabled(key)) groups[key] = disabledNotice(key);
  }

  // summary 只统计"真正参与判定的前五类"（与改造前一致：upgrades / registry 各有独立 meta）
  const countedGroups = COUNTED_GROUPS.filter((k) => !cfg.isGroupDisabled(k));
  const all = countedGroups.flatMap((k) => groups[k] ?? []);
  const summary = { total: all.length, green: 0, yellow: 0, red: 0 };
  for (const item of all) summary[item.status] = (summary[item.status] ?? 0) + 1;

  const laneSli = lane.sli();
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    meta,
    groups,
    upgradesMeta: top.upgradesMeta ?? upgradesMetaDefault,
    registryMeta: top.registryMeta ?? registryMetaDefault,
    decouplingMeta: top.decouplingMeta ?? decouplingMetaDefault,
    summary,
    /**
     * 这一屏的数据新鲜度：stale=true 表示"有源先给了旧值、后台正在换新"，
     * 页面上据此标「旧值 · 旧了 N 秒」，而不是干等转圈。
     */
    freshness,
    /** SLI：取数耗时（每源 + 总）/ 命中率（命中·未命中·冷启动分开）/ 降级次数（每源）+ 预热状态 */
    sli: {
      ...laneSli,
      request: {
        startedAt: new Date(read.startedAt).toISOString(),
        totalMs: read.elapsedMs,
        budgetMs: lane.totalBudgetMs,
        sources: requestSources
      },
      degradeEvents,
      warmup: warmupStatus()
    }
  };
}
