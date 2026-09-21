// dsh-ecosystem-panel / lib/upgrade.js
// ⑤ 升级体检（只读聚合）：本地实体版本 vs npm latest + 兼容风险 + 补丁关联。
// 设计要点：
//   · 本地版本优先读「实体 package.json」——profile 里的声明值会漂移（声明 ≠ 实体是常态）。
//   · npm 查询走文件缓存（TTL 24h），面板打开不卡；force=true 才真查（并发 + 单包超时）。
//   · 规则表（getUpgradeRules）只出**文案**；断裂符号表（getBreakingSymbols）只出**参考底表**。
//     两张表**默认都为空**：发布集不内嵌任何环境的禁升/冻结结论，由使用者用配置提供。
//   · 红黄绿档位**不自算**：交给外部**只读 CLI**（DSH_ECOSYSTEM_PANEL_TRIAGE_CLI）判定，
//     本文件只做「采本地事实 + npm 缓存 → 交给 CLI → 渲染」。
//     CLI 不可用/超时/输入缺口 ⇒ 渲染「档位不可用（原因）」，**绝不猜颜色**。
//     主包行**不参与**档位判定：分级授权只覆盖插件；主包行的 status 语义仍是「版本落后度」。
//   · 只读：唯一写操作是自己的缓存文件（默认 <数据根>/ecosystem-panel-upgrade-cache.json），
//     不碰任何其它文件。**绝不执行升级**（升级永远由人决定）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getConfig } from './config.js';

// 缓存文件落在配置层解析出的数据根（见 lib/config.js；可用 DSH_ECOSYSTEM_PANEL_CACHE_FILE 覆盖）。
// ⚠️ 路径必须在**调用时**解析：模块加载期固化成默认用户目录，会让隔离实例把缓存写进别的数据根。
export const UPGRADE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const MAIN_PKG = '@deepseek-ai/dsh';

/** 当前配置下的缓存文件路径 */
export function upgradeCacheFile(cfg = getConfig()) {
  return cfg.cacheFile;
}
/** 兼容导出（默认配置下的值；运行期请用 upgradeCacheFile(cfg)） */
export const UPGRADE_CACHE_FILE = upgradeCacheFile();

/** 升级决策规则表（**外置**）：包名 → { verdict, label, note }
 *  verdict 只是**文案分类**（本插件不据此变色，颜色一律来自外部只读 CLI）：
 *    blocked    需先升主包才能升
 *    frozen     已转自建/自维护 fork，升级 = 降级（不升）
 *    upgradable 可升（note 里写清升后要做什么，如重打补丁）
 *    internal   随宿主主包发行的内置包（忽略远端版本提示）
 *    self       本地包 / 无 npm 来源（不涉"升版"）
 *  默认**空**：发布集不内嵌任何环境的禁升结论。配置法：DSH_ECOSYSTEM_PANEL_UPGRADE_RULES_FILE
 *  （形状见 examples/upgrade-rules.example.json）。 */
export function getUpgradeRules(cfg = getConfig()) {
  const r = cfg?.upgradeRules;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
}
/** 兼容导出（默认配置下的值；运行期请用 getUpgradeRules(cfg)） */
export const UPGRADE_RULES = getUpgradeRules();

/** 已知断裂符号（**外置**）：包名 → { removed: [...], since, replacement, affected: [...] }
 *  含义：目标主包线已移除这些导出；插件若仍静态 import 则升级后必崩。
 *  默认**空**：发布集不内嵌任何环境的预检结论。配置法：DSH_ECOSYSTEM_PANEL_BREAKING_SYMBOLS_FILE
 *  （形状见 examples/breaking-symbols.example.json）。 */
export function getBreakingSymbols(cfg = getConfig()) {
  const r = cfg?.breakingSymbols;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
}
/** 兼容导出（默认配置下的值；运行期请用 getBreakingSymbols(cfg)） */
export const BREAKING_SYMBOLS = getBreakingSymbols();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
/** 去掉规则文案里的状态 emoji——状态由列表圆点表示，避免"🟢 圆点 + 🔴 文案"的矛盾 */
function stripMark(s) {
  return String(s ?? '').replace(/^(?:🟢|🟡|🔴|⬜|✅)\s*/u, '').trim();
}
function cmpVersion(a, b) {
  const pa = String(a).replace(/^[^\d]*/, '').split(/[.\-+]/);
  const pb = String(b).replace(/^[^\d]*/, '').split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] ?? '0', 10), nb = parseInt(pb[i] ?? '0', 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) return String(a).localeCompare(String(b));
    if (na !== nb) return na - nb;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// npm latest（带文件缓存）
// ---------------------------------------------------------------------------
async function fetchLatestOne(name) {
  const url = 'https://registry.npmjs.org/' + name.replace('/', '%2F');
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: 'no-store'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const latest = j?.['dist-tags']?.latest ?? null;
  // 官方 latest 标签不一定是最高版本（实测主包 latest=0.1.2-rc.1，最高=0.1.5-alpha.1）
  let highest = latest;
  for (const v of Object.keys(j?.versions ?? {})) {
    if (highest === null || cmpVersion(v, highest) > 0) highest = v;
  }
  if (!latest && !highest) throw new Error('no versions');
  return { latest: latest ?? highest, highest: highest ?? latest };
}

/**
 * 解析 latest 版本表（缓存优先）。
 * @returns {{ latest: Record<string,string>, at: number|null, source: 'cache'|'network'|'mixed', errors: Record<string,string> }}
 */
export async function resolveLatest(names, { force = false, cacheFile = upgradeCacheFile(), ttlMs = UPGRADE_CACHE_TTL_MS } = {}) {
  const cache = readJson(cacheFile) ?? {};
  const cached = cache.latest ?? {};
  const cachedHigh = cache.highest ?? {};
  const at = typeof cache.at === 'number' ? cache.at : null;
  const fresh = at !== null && (Date.now() - at) < ttlMs && Object.keys(cachedHigh).length > 0;
  if (!force && fresh) {
    return { latest: cached, highest: cachedHigh, at, source: 'cache', errors: {} };
  }
  const errors = {};
  const latest = force ? {} : { ...cached };
  const highest = force ? {} : { ...cachedHigh };
  await Promise.all(names.map(async (n) => {
    try {
      const r = await fetchLatestOne(n);
      latest[n] = r.latest;
      highest[n] = r.highest;
    } catch (e) {
      errors[n] = String(e?.message ?? e);
      if (!force && cached[n]) latest[n] = cached[n];
      if (!force && cachedHigh[n]) highest[n] = cachedHigh[n];
    }
  }));
  // 写缓存（唯一写操作；失败静默——缓存不可写不应影响面板）
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), latest, highest }, null, 1), 'utf8');
  } catch { /* ignore */ }
  return { latest, highest, at: Date.now(), source: 'network', errors };
}

// ---------------------------------------------------------------------------
// 本地插件事实（实体版本优先 + 补丁关联）
// ---------------------------------------------------------------------------
function collectLocalFacts(profilePkg, profileNm, patchManifest) {
  const deps = profilePkg?.dependencies ?? {};
  const patchesByPkg = {};
  for (const p of patchManifest ?? []) {
    const pkgs = new Set();
    for (const c of p.checks ?? []) pkgs.add(c.pkg);
    if (p.special?.pkg) pkgs.add(p.special.pkg);
    for (const pk of pkgs) {
      (patchesByPkg[pk] ??= []).push({ id: p.id, title: p.title, script: p.script });
    }
  }
  const facts = [];
  for (const [name, declared] of Object.entries(deps)) {
    const seg = name.startsWith('@') ? name.split('/') : [name];
    const entDir = path.join(profileNm, ...seg);
    const entPkg = readJson(path.join(entDir, 'package.json'));
    const isLink = typeof declared === 'string' && declared.startsWith('link:');
    facts.push({
      name,
      declared,
      isLink,
      entityVersion: entPkg?.version ?? null,
      // 实体优先：声明值会漂移
      localVersion: entPkg?.version ?? (isLink ? null : declared),
      versionDrift: !!(entPkg?.version && typeof declared === 'string' && /^\d/.test(declared) && declared !== entPkg.version),
      patches: patchesByPkg[name] ?? []
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// 档位判定：交给外部**只读 CLI**（配置项 DSH_ECOSYSTEM_PANEL_TRIAGE_CLI）
//
// 链路：面板采「本地事实 + npm 缓存」→（stdin，同一份缓存输入）→ 外部 CLI
//       → 返回每包档位（唯一判定源）→ 面板只渲染。
// 为什么走**进程边界**而不是 import：① 判定实现只许有一份，经只读 CLI 才不会长出第二套口径；
//   ② CLI 不可用/超时/坏 JSON 在进程边界上是**可观测的一等事件**，fail-safe（显"档位不可用"）才有落点。
// ---------------------------------------------------------------------------
export const TRIAGE_CLI_TIMEOUT_MS = 20_000;
/** 档位只读 CLI 路径（配置层：显式传入 > 环境变量 > 配置文件 > 工具目录派生 > 未配置） */
export function triageCliPath(cfg = getConfig()) {
  return cfg?.scripts?.triageCli?.path ?? null;
}
/** 兼容导出（默认配置下的值；运行期请用 triageCliPath(cfg)） */
export const TRIAGE_CLI = triageCliPath();
/** 档位结果短 TTL 缓存：**键 = payload 指纹 + CLI 文件 mtime**（同输入同结果 ⇒ 缓存天然幂等）。
 *  动机：spawn 一个 node 子进程本身要 200ms 量级，而 CLI 内部通常只跑十几毫秒；
 *  面板每次打开都付这笔开销。命中缓存后档位取数 0ms。 */
export const TRIAGE_CACHE_TTL_MS = 30_000;
let _triageCache = null;

/**
 * 把面板已知事实打包成 CLI 输入（**"同一份缓存输入"就是这一份**，判据 4 的比对基准）。
 * @param {object} o
 * @param {Array}  o.facts        collectLocalFacts() 的输出
 * @param {object} o.latest       resolveLatest() 的 latest
 * @param {object} o.highest      resolveLatest() 的 highest
 * @param {number|null} o.cacheAt
 * @param {string} o.cacheSource
 * @param {object} o.errors       npm 查询错误表（可缺）
 */
export function buildTriagePayload({ facts, latest, highest, cacheAt, cacheSource, errors, decouplingInputs = null, rules = getUpgradeRules() }) {
  const hostUpgradeRequiredByPkg = {};
  for (const f of facts) {
    // 「要升主包才能升」= 规则表里 blocked 类；frozen（已转自建 / 自维护 fork）不属此类。
    if (rules[f.name]?.verdict === 'blocked') hostUpgradeRequiredByPkg[f.name] = true;
  }
  return {
    source: { panel: 'dsh-ecosystem-panel', cacheSource: cacheSource ?? null },
    packages: facts.map((f) => ({
      name: f.name,
      localVersion: f.localVersion,
      declared: typeof f.declared === 'string' ? f.declared : null,
      entityVersion: f.entityVersion ?? null,
      // 无 npm 源（link 包 / 本地包 / 规则表 self）⇒ 不涉"升版"，CLI 侧不当缺口
      npmSource: !f.isLink && rules[f.name]?.verdict !== 'self',
      targetVersion: (highest ?? {})[f.name] ?? (latest ?? {})[f.name] ?? null,
    })),
    npmCache: { at: cacheAt ?? null, latest: latest ?? {}, highest: highest ?? {} },
    npmErrors: errors ?? {},
    hostUpgradeRequiredByPkg,
    // ★解耦结论由面板注入（同一份判定源的聚合 + R5 唯一源判定）：
    //   CLI 因此不再自扫一遍全部包（首屏省 ~443ms）。形状不对/缺失时由 triage fail-closed 消费。
    inputs: decouplingInputs ? { decoupling: decouplingInputs } : {},
  };
}

/**
 * 调只读 CLI 取档位。**任何失败都不抛**（降级成 {ok:false, reason}，由调用方渲染"档位不可用"）。
 * @returns {{ok:true, result:object, elapsedMs:number}|{ok:false, reason:string, elapsedMs:number}}
 */
export function evaluateTriageViaCli(payload, { cliPath = triageCliPath(), timeoutMs = TRIAGE_CLI_TIMEOUT_MS, nodePath = process.execPath, cacheTtlMs = TRIAGE_CACHE_TTL_MS } = {}) {
  const t0 = Date.now();
  if (cliPath === null) {
    return { ok: false, reason: '未配置档位判定 CLI（DSH_ECOSYSTEM_PANEL_TRIAGE_CLI 或 DSH_ECOSYSTEM_PANEL_TOOLS_DIR）⇒ 档位不可用（未渲染任何颜色）', elapsedMs: Date.now() - t0 };
  }
  if (!fs.existsSync(cliPath)) return { ok: false, reason: `档位 CLI 不存在：${cliPath}`, elapsedMs: Date.now() - t0 };
  let cliMtime = 0;
  try { cliMtime = fs.statSync(cliPath).mtimeMs; } catch { /* 保持 0 */ }
  const cacheKey = createHash('sha1').update(cliPath + '\u0000' + JSON.stringify(payload)).digest('hex') + '|' + cliMtime;
  if (cacheTtlMs > 0 && _triageCache && _triageCache.key === cacheKey && (Date.now() - _triageCache.at) < cacheTtlMs) {
    return { ..._triageCache.value, cached: true, elapsedMs: Date.now() - t0 };
  }
  const r = spawnSync(nodePath, [cliPath, '--json', '--input', '-'], {
    input: JSON.stringify(payload),
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - t0;
  if (r.error) return { ok: false, reason: `档位 CLI 执行失败：${r.error.message}`, elapsedMs };
  if (r.status !== 0) return { ok: false, reason: `档位 CLI 退出码 ${r.status}：${String(r.stderr ?? '').trim().slice(-300)}`, elapsedMs };
  try {
    const result = JSON.parse(r.stdout);
    if (result?.ok !== true) return { ok: false, reason: `档位 CLI 返回 ok=false：${result?.error ?? '(无原因)'}`, elapsedMs };
    const value = { ok: true, result, elapsedMs, cached: false };
    _triageCache = { key: cacheKey, at: Date.now(), value };
    return value;
  } catch (e) {
    return { ok: false, reason: `档位 CLI 输出不是 JSON：${String(e?.message ?? e)}`, elapsedMs };
  }
}

/**
 * 渲染口径的唯一落点（**纯函数**：把 CLI 结果映射到面板行；夹具直接断言它 == CLI 的档位）。
 * 规则：
 *   · CLI 不可用 → 每行 status='unknown' + 原因（绝不猜颜色）；
 *   · 行 available=false（输入缺口 / 目标版本不可判）→ status='unknown' + 原因；
 *   · 行 available=true → status = tier（green/yellow/red），标签取 CLI 的 tierLabel。
 * @returns {{items:Array, meta:object}}
 */
export function applyTriage(items, triage) {
  const meta = {
    ok: false, tierSource: 'unavailable', cliVersion: null, triageVersion: null,
    cacheOnly: null, elapsedMs: triage?.elapsedMs ?? null, inputGaps: [], byName: {},
    reason: null, cached: triage?.cached === true,
  };
  const out = items.map((it) => ({ ...it }));
  const byName = new Map();
  if (triage?.ok === true) {
    for (const row of triage.result.items ?? []) byName.set(row.name, row);
    meta.ok = true;
    meta.tierSource = triage.result.tierSource ?? 'upgrade-triage';
    meta.cliVersion = triage.result.cliVersion ?? null;
    meta.triageVersion = triage.result.triageVersion ?? null;
    meta.cacheOnly = triage.result.cacheOnly ?? null;
    meta.inputGaps = triage.result.inputGaps ?? [];
    meta.elapsedMs = triage.result.elapsedMs ?? meta.elapsedMs;
  } else {
    meta.reason = triage?.reason ?? '未调用档位 CLI';
  }

  for (const it of out) {
    if (triage?.ok !== true) {
      it.status = 'unknown';
      it.tier = null;
      it.tierAvailable = false;
      it.tierSource = 'unavailable';
      it.unavailableReason = meta.reason;
      it.problems = [...(it.problems ?? []), `档位不可用（${meta.reason}）—— 未渲染颜色`];
      continue;
    }
    const row = byName.get(it.name);
    if (!row) {
      it.status = 'unknown';
      it.tier = null;
      it.tierAvailable = false;
      it.tierSource = 'unavailable';
      it.unavailableReason = '档位 CLI 未返回该包的行';
      it.problems = [...(it.problems ?? []), '档位不可用（CLI 未返回该包）—— 未渲染颜色'];
      continue;
    }
    it.tier = row.tier ?? null;
    it.tierAvailable = row.available === true;
    it.tierSource = 'upgrade-triage-cli';
    it.tierReasons = row.reasons ?? [];
    it.evidenceGaps = row.evidenceGaps ?? [];
    it.triageLocal = row.local ?? null;
    it.triageTarget = row.target ?? null;
    it.triageTargetSource = row.targetSource ?? null;
    if (row.available === true) {
      it.status = row.tier;                       // ← 档位唯一源，面板不自算
      it.unavailableReason = null;
      it.verdictLabel = row.tierLabel ?? it.verdictLabel;
      for (const r of (row.reasons ?? []).slice(0, 3)) it.problems = [...it.problems, `档位判据：${r}`];
    } else {
      it.status = 'unknown';                      // ← 绝不猜颜色（表 3 逃生舱）
      it.unavailableReason = row.unavailableReason ?? '输入不可用';
      it.problems = [...(it.problems ?? []), `档位不可用（${it.unavailableReason}）—— 未渲染颜色`];
    }
    // 原规则文案（"需主包 ≥0.1.2" 之类）降级为注解，信息不丢；与档位冲突的旧标签不再上屏
    if (it.ruleNote) it.problems = [...it.problems, `规则表：${it.ruleNote}`];
  }
  meta.byName = Object.fromEntries([...byName.entries()].map(([k, v]) => [k, { tier: v.tier, available: v.available === true, unavailableReason: v.unavailableReason ?? null, tierLabel: v.tierLabel ?? null }]));
  return { items: out, meta };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
/**
 * 构建「升级体检」分组数据（只读）。
 * @param {object} opts
 * @param {object} opts.profilePkg   profile package.json 内容
 * @param {string} opts.profileNm    profile node_modules 路径
 * @param {string} opts.mainPkgDir   主包目录（.../npm/node_modules/@deepseek-ai/dsh）
 * @param {Array}  opts.patchManifest 补丁清单（用于反查该包挂了哪些补丁）
 * @param {boolean} opts.force       是否强制刷新 npm 查询
 */
export async function buildUpgradeState(opts) {
  const { profilePkg, profileNm, mainPkgDir, patchManifest, force = false, decouplingInputs = null } = opts;
  const cfg = opts.config ?? getConfig();
  const rules = getUpgradeRules(cfg);
  const facts = collectLocalFacts(profilePkg, profileNm, patchManifest);

  // 主包（mainPkgDir = 全局 npm 下的 @deepseek-ai/dsh 目录）
  const mainPkg = readJson(path.join(mainPkgDir, 'package.json'));
  const mainLocal = mainPkg?.version ?? null;

  // 需要查远端的包：非 link、有 npm 来源的
  const queryNames = facts
    .filter((f) => !f.isLink && !(rules[f.name]?.verdict === 'self'))
    .map((f) => f.name);
  const mainNames = [MAIN_PKG];
  const { latest, highest, at: cacheAt, source, errors } = await resolveLatest([...mainNames, ...queryNames], { force, cacheFile: cfg.cacheFile });

  const items = [];

  // 主包行（用「最高版本」判定是否落后；npm latest 标签另记）
  // ⚠️ 主包行**不走档位判定**：分级授权只覆盖插件、不覆盖主包 ——
  //    它的 status 语义是「版本落后度」（绿=最新 / 黄=有新版），不是「升级授权档」。
  const mainTag = latest[MAIN_PKG] ?? null;
  const mainHighest = highest[MAIN_PKG] ?? mainTag;
  const mainItems = [];
  if (mainLocal) {
    const behind = mainHighest && cmpVersion(mainHighest, mainLocal) > 0;
    const isPrerelease = /-(alpha|beta|rc)/.test(String(mainHighest ?? ''));
    const tagDiffers = !!(mainTag && mainHighest && mainTag !== mainHighest);
    mainItems.push({
      kind: 'upgrade',
      name: MAIN_PKG,
      status: behind ? 'yellow' : 'green',
      description: 'DSH 主包（全局 npm 安装）',
      local: mainLocal,
      latest: mainHighest,
      latestTag: mainTag,
      verdict: behind ? 'main-behind' : 'latest',
      verdictLabel: behind
        ? (isPrerelease ? '有新 prerelease（默认不升）' : '有新正式版')
        : '最新',
      patchCount: 0,
      problems: behind
        ? [
            tagDiffers
              ? `npm latest 标签=${mainTag}，最高版本=${mainHighest}（官方全 prerelease）`
              : '官方当前全为 prerelease',
            '预发布线默认不升；真要升，先做兼容审计（老插件用到的 SDK 符号）+ 全量补丁重打 + 回归。'
          ]
        : []
    });
  }

  for (const f of facts) {
    const rule = rules[f.name];
    const lat = highest[f.name] ?? latest[f.name] ?? null;
    const err = errors[f.name] ?? null;
    const behind = lat && f.localVersion && cmpVersion(lat, f.localVersion) > 0;
    const patchCount = f.patches.length;

    // ⚠️ 这里只算**文案**（verdict / verdictLabel / problems）；**status 不自算**——
    //    红黄绿档位一律来自只读 CLI（applyTriage 填），见本文件头说明。
    let verdict, verdictLabel;
    const problems = [];
    if (rule?.verdict === 'self' || rule?.verdict === 'internal' || f.isLink) {
      verdict = 'local-only';
      verdictLabel = stripMark(rule?.label) || '本地包（无 npm 源）';
    } else if (rule?.verdict === 'blocked' || rule?.verdict === 'frozen') {
      verdict = rule.verdict;
      verdictLabel = stripMark(rule.label);
    } else if (!lat) {
      verdict = 'unknown';
      verdictLabel = err ? '远端查询失败' : '无 npm 源';
      if (err) problems.push('npm registry: ' + err);
    } else if (!behind) {
      verdict = 'latest';
      verdictLabel = '最新';
    } else {
      verdict = 'upgradable';
      verdictLabel = stripMark(rule?.label) || '可升';
    }

    if (f.versionDrift) problems.push(`⚠ 版本漂移：声明 ${f.declared} ≠ 实体 ${f.entityVersion}`);
    if (patchCount > 0) problems.push(`本地补丁 ${patchCount} 个：${f.patches.map((p) => p.script).join(', ')}`);
    // 防再犯：规则文案声称「无补丁」但补丁清单里其实挂着该包的补丁 ⇒ 文案自相矛盾
    // （面板一边报「无补丁，直接升」一边在「补丁健康」里列该包的补丁）。以补丁清单为事实源纠正。
    if (patchCount > 0 && /无(本地)?(定制)?补丁/.test(String(verdictLabel ?? ''))) {
      verdictLabel = `升版需重打 ${patchCount} 个补丁`;
      problems.push('规则文案与补丁清单不一致（原声称"无补丁"）—— 已按事实源纠正，请同步你的升级规则表配置');
    }

    items.push({
      kind: 'upgrade',
      name: f.name,
      status: 'unknown',        // 占位：紧接着被 applyTriage 用 CLI 档位覆盖（拿不到就保持 unknown）
      description: null, // 由 state.js 注入 CN_INTRO
      local: f.localVersion,
      declared: f.declared,
      entityVersion: f.entityVersion,
      latest: lat,
      verdict,
      verdictLabel,
      ruleNote: rule?.note ?? null,   // 规则表注解（供 applyTriage 降级为 problems 注释，不再决定档位）
      patchCount,
      patchScripts: f.patches.map((p) => p.script),
      problems
    });
  }

  // 档位单源：把「本地事实 + npm 缓存」交给只读 CLI，取回每包档位
  const payload = buildTriagePayload({ facts, latest, highest, cacheAt, cacheSource: source, errors, decouplingInputs, rules });
  // ⚠️ 必须显式传当前配置推导出的 CLI 路径：否则会用"进程默认配置"的路径，
  //    在有配置覆盖（隔离实例 / 夹具 / 使用者自定义）时静默失效。
  const triage = evaluateTriageViaCli(payload, { cliPath: triageCliPath(cfg) });
  const applied = applyTriage(items, triage);
  const triagedItems = applied.items;

  // 排序：红 → 档位不可用 → 黄 → 绿；同类按名字（"不可用"靠前，避免被满屏绿掩盖）
  const order = { red: 0, unknown: 1, yellow: 2, green: 3 };
  triagedItems.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(a.name).localeCompare(String(b.name)));

  const allItems = [...mainItems, ...triagedItems];
  const summary = { total: allItems.length, green: 0, yellow: 0, red: 0, unknown: 0 };
  for (const it of allItems) summary[it.status] = (summary[it.status] ?? 0) + 1;

  return {
    items: allItems,
    summary,
    cacheAt,
    cacheSource: source,
    errors,
    breaking: getBreakingSymbols(cfg),
    fetchedAt: new Date().toISOString(),
    tier: applied.meta            // 档位来源自证（CLI 版本/耗时/输入缺口/逐包档位）
  };
}
