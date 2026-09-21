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
  const cfg = getConfig(cli);
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
// 汇总
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

export async function buildState(options = {}) {
  const P = paths(options.config ?? null);
  const cfg = P.cfg;
  const profilePkg = readJson(path.join(P.PROFILE_DIR, 'package.json'));
  const { ids: bootIds, error: bootError } = await fetchBootEntries(P);
  const { inserts, disabledIds, parseError: patchParseError } = collectInserts(P);
  const bundles = collectBundles(profilePkg, bootIds, P);
  const patches = collectPatches(P);
  const { skills, userDirOk } = collectSkills(P);
  const decoupling = await collectDecoupling(P);
  // 串行是**有意的**：升级体检要消费解耦结论（下面注入 decoupling.meta.triageInputs），结论先算出来。
  const upgrades = await collectUpgrades(profilePkg, options.refreshUpgrades === true, decoupling.meta.triageInputs, P);
  // ⑦ 跨表准入一致性：只渲染不自算；三态显式 ok / fail / unavailable
  const registry = await collectRegistry({
    config: cfg,
    ...(typeof options.registryLibPath === 'string' ? { registryLibPath: options.registryLibPath } : {}),
    ...(typeof options.registryHome === 'string' ? { home: options.registryHome } : {}),
    ...(typeof options.registryRoot === 'string' ? { root: options.registryRoot } : {}),
    ...(Number.isFinite(options.registryNow) ? { now: options.registryNow } : {})
  });

  const registryItems = [{
    kind: 'registry',
    name: '跨表准入校验器',
    // 面板色域只有 green/yellow/red ⇒ unavailable 用 yellow；**权威枚举看 registryMeta.status**
    status: registry.status === 'ok' ? 'green' : (registry.status === 'fail' ? 'red' : 'yellow'),
    problems: registry.status === 'unavailable' ? [`判定不可用：${registry.reason}`] : registry.problems,
    description: registry.status === 'ok'
      ? '跨表准入零差集（判定唯一源 = 外部校验器，本面板只渲染不自算）'
      : registry.reason
  }];

  const groups = {
    bundles,
    inserts,
    disabledPatchIds: disabledIds,
    patches,
    skills,
    decoupling: decoupling.items,
    upgrades: upgrades.items,
    registry: registryItems
  };
  // 配置层停用类目：显式呈现为一条"已停用"项（**不伪装成 0 项**），且不计入 summary
  const GROUP_KEYS = ['bundles', 'inserts', 'patches', 'skills', 'decoupling', 'upgrades', 'registry'];
  for (const key of GROUP_KEYS) if (cfg.isGroupDisabled(key)) groups[key] = disabledNotice(key);

  // summary 只统计"真正参与判定的前五类"（与改造前一致：upgrades / registry 各有独立 meta）
  const countedGroups = ['bundles', 'inserts', 'patches', 'skills', 'decoupling'].filter((k) => !cfg.isGroupDisabled(k));
  const all = countedGroups.flatMap((k) => groups[k]);
  const summary = { total: all.length, green: 0, yellow: 0, red: 0 };
  for (const item of all) summary[item.status]++;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    meta: {
      profileDir: P.PROFILE_DIR,
      skillsDir: P.SKILLS_DIR,
      bootEntries: bootIds === null ? null : bootIds.length,
      bootError,
      patchYamlError: patchParseError,
      skillsDirOk: userDirOk,
      panelVersion: SELF_VERSION,
      upgradeCacheAt: upgrades.cacheAt,
      upgradeCacheSource: upgrades.cacheSource,
      decouplingScript: decoupling.meta.script,
      decouplingScriptVersion: decoupling.meta.scriptVersion,
      decouplingScope: decoupling.meta.scope,
      // 配置来源自证 + 配置期错误：陌生环境排障的第一手证据（每项写明"从哪读到的"）
      toolsDir: P.TOOLS_DIR,
      disabledGroups: cfg.disabledGroups,
      yamlAvailable: YAML_AVAILABLE,
      config: describeResolution(cfg),
      configErrors: cfg.errors,
      // 界面文案覆盖：有值则前端用它替代内置中性文案（见 lib/client.js）
      ui: Object.keys(cfg.text).length ? cfg.text : null
    },
    groups,
    upgradesMeta: {
      summary: upgrades.summary,
      cacheAt: upgrades.cacheAt,
      cacheSource: upgrades.cacheSource,
      errors: upgrades.errors,
      breaking: upgrades.breaking,
      fetchedAt: upgrades.fetchedAt,
      // 档位来源自证（唯一源 = 外部只读 CLI）；拿不到 CLI 就是 ok:false + reason，**绝不猜颜色**
      tier: upgrades.tier ?? null
    },
    // 跨表准入分组元数据 —— **status 是显式枚举 `ok / fail / unavailable`（配置停用时为 `disabled`）**：
    //   asOf 缺失即判 unavailable（**不是 0/0/0 绿**）；判定与明细全部来自外部校验器，面板只渲染。
    registryMeta: {
      status: cfg.isGroupDisabled('registry') ? 'disabled' : registry.status,
      asOf: registry.asOf,
      reason: registry.reason,
      lib: registry.lib,
      libVersion: registry.libVersion ?? null,
      source: registry.source,
      home: registry.home,
      root: registry.root,
      counts: registry.counts,
      checkFailed: registry.checkFailed,
      problemCount: registry.problemCount,
      problemTotal: registry.problemTotal,
      unavailableCount: registry.unavailableCount,
      problems: registry.problems,
      unavailable: registry.unavailable
    },
    decouplingMeta: {
      script: decoupling.meta.script,
      scriptVersion: decoupling.meta.scriptVersion,
      scope: decoupling.meta.scope,
      packages: decoupling.meta.packages ?? 0,
      summary: (() => {
        const s = { green: 0, yellow: 0, red: 0, total: decoupling.items.length };
        for (const it of decoupling.items) s[it.status]++;
        return s;
      })()
    },
    summary
  };
}