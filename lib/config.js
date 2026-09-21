// dsh-ecosystem-panel / lib/config.js
// 配置层：把原本写死在源码里的路径 / 白名单 / 规则表 / 文案全部外置。
//
// 解析优先级（**每个键独立**）：
//   ① 显式传入（插件 config、本模块 cli 入参；夹具与 CLI 用这一层）
//   ② 环境变量（前缀 DSH_ECOSYSTEM_PANEL_；见下表）
//   ③ 配置文件（DSH_ECOSYSTEM_PANEL_CONFIG 指向的 JSON，键名与 ① 同名）
//   ④ 自动探测（只探测形态确定的东西：用户目录 / 全局 npm 布局 / 项目相对路径）
//   ⑤ 内置默认
//
// ⚠️ 设计红线：**探测不到就返回 null + 原因，绝不猜、绝不用 0 或空表冒充"全绿"**。
//    下游（state.js / upgrade.js）对每个 null 都必须有显式降级分支（见各自的 collect* 函数）。
//
// 环境变量一览：
//   DSH_ECOSYSTEM_PANEL_HOME               DSH 数据根（默认 <os.homedir()>/.dsh）
//   DSH_HOME                               同上（DSH 官方口径，作为兜底）
//   DSH_ECOSYSTEM_PANEL_PROFILE            profile 名（默认 web）
//   DSH_ECOSYSTEM_PANEL_WEB_URL            本实例的 Web 基址（默认 http://127.0.0.1:3080）
//   DSH_WEB_URL                            同上（DSH 宿主会注入，作为兜底）
//   DSH_ECOSYSTEM_PANEL_TOOLS_DIR          外部工具目录（**不自动探测**，不设则该类目降级）
//   DSH_ECOSYSTEM_PANEL_MAIN_NM            主包 node_modules（默认按全局 npm 布局探测）
//   DSH_ECOSYSTEM_PANEL_CONFIG             配置文件 JSON 路径
//   DSH_ECOSYSTEM_PANEL_CACHE_FILE         升级体检缓存文件（默认 <HOME>/ecosystem-panel-upgrade-cache.json）
//   DSH_ECOSYSTEM_PANEL_DECOUPLING_SCRIPT  解耦检查脚本路径
//   DSH_ECOSYSTEM_PANEL_TRIAGE_CLI         升级档位只读 CLI 路径
//   DSH_ECOSYSTEM_PANEL_REGISTRY_AUDIT_LIB 跨表准入校验器路径
//   DSH_ECOSYSTEM_PANEL_HOST_ADAPTER_SYNC  适配层一致性校验器路径（可选）
//   DSH_ECOSYSTEM_PANEL_PATCH_MANIFEST_FILE / _UPGRADE_RULES_FILE / _BREAKING_SYMBOLS_FILE / _LABELS_FILE
//                                          四个数据清单的 JSON 文件路径
//   DSH_ECOSYSTEM_PANEL_WEBSERVER_SERVICE  宿主 web server 服务名（默认 webServer，见 host-protocol.js）
//   DSH_ECOSYSTEM_PANEL_DISABLED_GROUPS    逗号分隔：把某几类体检整组标为"未启用"

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLUGIN_ID = 'dsh-ecosystem-panel';
export const ENV_PREFIX = 'DSH_ECOSYSTEM_PANEL_';

/** 内置默认值：**全部与具体机器无关**（这里出现任何绝对路径或个人环境清单都是缺陷） */
export const DEFAULTS = {
  profile: 'web',
  webUrl: 'http://127.0.0.1:3080',
  /** 随主包发行、profile 里没有实体目录的官方 core 包（client 由子包提供，boot 有子包条目即证在跑） */
  coreBundles: [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-client-ui-jobs'
  ],
  /** 定制补丁清单：默认**空**（发布集不内嵌任何个人环境的补丁表） */
  patchManifest: [],
  /** 升级决策规则表：默认**空**（不内嵌任何个人环境的禁升/冻结结论） */
  upgradeRules: {},
  /** 已知断裂符号表：默认**空** */
  breakingSymbols: {},
  /** 包名 → 一句话简介：默认**空** */
  labels: {},
  /** 界面文案覆盖：默认**空**（前端有内置中性文案，这里只做覆盖） */
  text: {},
  /** 整组停用的类目（例如不想要补丁体检就写 ["patches"]） */
  disabledGroups: []
};

const SCRIPT_KEYS = ['decoupling', 'triageCli', 'registryAudit', 'hostAdapterSync'];
/** 各外部脚本在 toolsDir 下的默认相对位置（只作候选；文件不存在即降级，不影响其它类目） */
const SCRIPT_DEFAULT_REL = {
  decoupling: 'check-decoupling.mjs',
  triageCli: 'upgrade-triage-cli.mjs',
  registryAudit: 'registry-audit.mjs',
  hostAdapterSync: 'sync-host-adapter.mjs'
};
const MANIFEST_KEYS = {
  patchManifest: 'PATCH_MANIFEST_FILE',
  upgradeRules: 'UPGRADE_RULES_FILE',
  breakingSymbols: 'BREAKING_SYMBOLS_FILE',
  labels: 'LABELS_FILE'
};

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
function firstOf(...vals) {
  for (const v of vals) {
    const x = str(v);
    if (x !== null) return x;
  }
  return null;
}
function toAbs(v, base) {
  const x = str(v);
  if (x === null) return null;
  return path.isAbsolute(x) ? path.normalize(x) : path.resolve(base ?? process.cwd(), x);
}
function readJsonFile(p) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8')), error: null };
  } catch (e) {
    return { ok: false, value: null, error: `${p} 读取/解析失败：${String(e?.message ?? e)}` };
  }
}
function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 把配置里的 ${HOME} / ${PROFILE_DIR} / ${PROFILE_NM} / ${SKILLS_DIR} / ${MAIN_NM} 占位符展开成实际路径 */
export function expandVars(value, cfg) {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  const map = {
    HOME: cfg.home ?? '',
    PROFILE_DIR: cfg.profileDir ?? '',
    PROFILE_NM: cfg.profileNm ?? '',
    SKILLS_DIR: cfg.skillsDir ?? '',
    MAIN_NM: cfg.mainNm ?? '',
    MAIN_PKG_DIR: cfg.mainPkgDir ?? ''
  };
  return value.replace(/\$\{([A-Z_]+)\}/g, (m, k) => (k in map ? map[k] : m));
}
function expandDeep(value, cfg) {
  if (typeof value === 'string') return expandVars(value, cfg);
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, cfg));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v, cfg);
    return out;
  }
  return value;
}

/**
 * 解析出一份完整配置（纯函数：不改全局状态，可被夹具直接断言）。
 * @param {object} [cli] 显式覆盖（优先级最高）
 * @param {object} [env] 环境变量表（默认 process.env）
 */
export function resolveConfig(cli = {}, env = process.env) {
  const errors = [];
  const envVal = (key) => str(env[ENV_PREFIX + key]);
  const cliVal = (key) => (cli && cli[key] !== undefined ? cli[key] : undefined);

  // ---- 配置文件（③ 层）------------------------------------------------------
  const configFile = toAbs(firstOf(cliVal('configFile'), envVal('CONFIG')));
  let fileCfg = {};
  if (configFile) {
    const r = readJsonFile(configFile);
    if (r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) fileCfg = r.value;
    else errors.push(r.error ?? `${configFile} 内容不是对象`);
  }
  const fileVal = (key) => (fileCfg && fileCfg[key] !== undefined ? fileCfg[key] : undefined);

  const sources = {};
  /** 三层取值（cli > env > 配置文件），返回 { value, from } */
  const pick = (key, envKey) => {
    const c = cliVal(key);
    if (str(c) !== null) return (sources[key] = { value: c, from: 'cli' }), sources[key];
    const e = envKey ? envVal(envKey) : null;
    if (e !== null) return (sources[key] = { value: e, from: `env:${ENV_PREFIX}${envKey}` }), sources[key];
    const f = fileVal(key);
    if (str(f) !== null) return (sources[key] = { value: f, from: `config-file(${path.basename(configFile)})` }), sources[key];
    return (sources[key] = { value: null, from: null }), sources[key];
  };

  // ---- 数据根 / profile ------------------------------------------------------
  const home = toAbs(firstOf(cliVal('home'), envVal('HOME'), env.DSH_HOME, fileVal('home')))
    ?? path.join(os.homedir(), '.dsh');
  sources.home = {
    value: home,
    from: str(cliVal('home')) !== null ? 'cli'
      : str(envVal('HOME')) !== null ? `env:${ENV_PREFIX}HOME`
        : str(env.DSH_HOME) !== null ? 'env:DSH_HOME'
          : str(fileVal('home')) !== null ? `config-file(${path.basename(configFile ?? '-')})`
            : 'default(<os.homedir()>/.dsh)'
  };
  const profile = firstOf(cliVal('profile'), envVal('PROFILE'), fileVal('profile')) ?? DEFAULTS.profile;
  sources.profile = {
    value: profile,
    from: str(cliVal('profile')) !== null ? 'cli'
      : str(envVal('PROFILE')) !== null ? `env:${ENV_PREFIX}PROFILE`
        : str(fileVal('profile')) !== null ? `config-file(${path.basename(configFile ?? '-')})`
          : 'default(web)'
  };
  const profileDir = path.join(home, 'profiles', profile);
  const profileNm = path.join(profileDir, 'node_modules');
  const sharedNm = path.join(home, 'profiles', 'node_modules');
  const skillsDir = path.join(home, 'skills');

  const webUrl = firstOf(cliVal('webUrl'), envVal('WEB_URL'), env.DSH_WEB_URL, fileVal('webUrl')) ?? DEFAULTS.webUrl;
  sources.webUrl = {
    value: webUrl,
    from: str(cliVal('webUrl')) !== null ? 'cli'
      : str(envVal('WEB_URL')) !== null ? `env:${ENV_PREFIX}WEB_URL`
        : str(env.DSH_WEB_URL) !== null ? 'env:DSH_WEB_URL'
          : str(fileVal('webUrl')) !== null ? 'config-file'
            : 'default(127.0.0.1:3080)'
  };

  // ---- 主包 node_modules（自动探测：全局 npm 布局）----------------------------
  const mainNmExplicit = toAbs(firstOf(cliVal('mainNm'), envVal('MAIN_NM'), fileVal('mainNm')));
  const mainNmDefault = env.APPDATA
    ? path.join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
    : null;
  const mainNm = mainNmExplicit ?? (mainNmDefault && dirExists(mainNmDefault) ? mainNmDefault : null);
  sources.mainNm = {
    value: mainNm,
    from: mainNmExplicit !== null ? (str(cliVal('mainNm')) !== null ? 'cli' : (str(envVal('MAIN_NM')) !== null ? `env:${ENV_PREFIX}MAIN_NM` : 'config-file'))
      : mainNm !== null ? 'probe(%APPDATA%/npm/node_modules/@deepseek-ai/dsh/node_modules)'
        : 'unavailable(未探测到全局 npm 主包布局；用 ' + ENV_PREFIX + 'MAIN_NM 显式指定)'
  };
  // mainNm = .../node_modules/@deepseek-ai/dsh/node_modules ⇒ 主包目录 = 它向上一级
  const mainPkgDir = mainNm ? path.dirname(mainNm) : null;

  // ---- 外部工具目录（**不自动探测**）----------------------------------------
  const toolsDir = toAbs(firstOf(cliVal('toolsDir'), envVal('TOOLS_DIR'), fileVal('toolsDir')));
  sources.toolsDir = {
    value: toolsDir,
    from: str(cliVal('toolsDir')) !== null ? 'cli'
      : str(envVal('TOOLS_DIR')) !== null ? `env:${ENV_PREFIX}TOOLS_DIR`
        : str(fileVal('toolsDir')) !== null ? 'config-file'
          : 'unavailable(未配置：依赖外部工具的三类体检会显式降级，不会假绿)'
  };

  const cfg = {
    home,
    profile,
    profileDir,
    profileNm,
    sharedNm,
    skillsDir,
    mainNm,
    mainPkgDir,
    webUrl,
    toolsDir,
    configFile,
    cacheFile: toAbs(firstOf(cliVal('cacheFile'), envVal('CACHE_FILE'), fileVal('cacheFile')))
      ?? path.join(home, 'ecosystem-panel-upgrade-cache.json'),
    scripts: {},
    errors,
    sources
  };

  // ---- 四个外部脚本（cli > env > 配置文件 > toolsDir 派生 > null）------------
  for (const key of SCRIPT_KEYS) {
    const envKey = { decoupling: 'DECOUPLING_SCRIPT', triageCli: 'TRIAGE_CLI', registryAudit: 'REGISTRY_AUDIT_LIB', hostAdapterSync: 'HOST_ADAPTER_SYNC' }[key];
    const cliScripts = (cli && typeof cli.scripts === 'object' && cli.scripts) || {};
    const fileScripts = (fileCfg && typeof fileCfg.scripts === 'object' && fileCfg.scripts) || {};
    let value = toAbs(firstOf(cliScripts[key], envVal(envKey), fileScripts[key]));
    let from = str(cliScripts[key]) !== null ? 'cli'
      : str(envVal(envKey)) !== null ? `env:${ENV_PREFIX}${envKey}`
        : str(fileScripts[key]) !== null ? 'config-file'
          : null;
    if (value === null && toolsDir) {
      value = path.join(toolsDir, SCRIPT_DEFAULT_REL[key]);
      from = `tools-dir(${SCRIPT_DEFAULT_REL[key]})`;
    }
    cfg.scripts[key] = { path: value, from: from ?? 'unavailable(未配置)' };
  }

  // ---- 四份数据清单（内联 > 文件 > 默认空）-----------------------------------
  const readManifest = (key) => {
    const inline = cliVal(key) ?? fileVal(key);
    if (inline && typeof inline === 'object') return { value: inline, from: str(cliVal(key)) !== null ? 'cli' : 'config-file' };
    const p = toAbs(firstOf(cliVal(key + 'File'), envVal(MANIFEST_KEYS[key]), fileVal(key + 'File')));
    if (p === null) return { value: null, from: 'default(空)' };
    const r = readJsonFile(p);
    if (!r.ok) {
      errors.push(r.error);
      return { value: null, from: `failed(${p})` };
    }
    return { value: r.value, from: p };
  };
  for (const key of Object.keys(MANIFEST_KEYS)) {
    const r = readManifest(key);
    const fallback = DEFAULTS[key];
    const value = r.value === null ? fallback : r.value;
    cfg[key] = Array.isArray(value) ? value.slice() : { ...value };
    cfg.sources[key] = { value: Array.isArray(cfg[key]) ? `[${cfg[key].length}]` : `{${Object.keys(cfg[key]).length}}`, from: r.from };
  }
  // 清单里的 ${HOME} 之类占位符在此展开（使用者不必写死绝对路径）
  cfg.patchManifest = expandDeep(cfg.patchManifest, cfg);

  // ---- core 包白名单 / 停用类目 / 文案 ---------------------------------------
  const coreExtra = cliVal('coreBundles') ?? fileVal('coreBundles');
  cfg.coreBundles = [...new Set([...DEFAULTS.coreBundles, ...(Array.isArray(coreExtra) ? coreExtra.filter((x) => typeof x === 'string') : [])])];
  cfg.sources.coreBundles = { value: `[${cfg.coreBundles.length}]`, from: Array.isArray(coreExtra) ? 'default+config-file' : 'default(官方 core 3 包)' };

  // 三种形态都认：显式数组（cli / 配置文件）、逗号分隔字符串（环境变量）、不设（默认全开）
  const disabledCli = cliVal('disabledGroups');
  const disabledFile = fileVal('disabledGroups');
  let disabledArr;
  let disabledFrom;
  if (Array.isArray(disabledCli)) {
    disabledArr = disabledCli.filter((x) => typeof x === 'string');
    disabledFrom = 'cli';
  } else {
    const disabledRaw = firstOf(disabledCli, envVal('DISABLED_GROUPS'));
    if (disabledRaw !== null) {
      disabledArr = String(disabledRaw).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      disabledFrom = str(disabledCli) !== null ? 'cli' : `env:${ENV_PREFIX}DISABLED_GROUPS`;
    } else if (Array.isArray(disabledFile)) {
      disabledArr = disabledFile.filter((x) => typeof x === 'string');
      disabledFrom = 'config-file';
    } else {
      disabledArr = DEFAULTS.disabledGroups;
      disabledFrom = 'default(全开)';
    }
  }
  cfg.disabledGroups = [...new Set(disabledArr)];
  cfg.sources.disabledGroups = { value: cfg.disabledGroups.join(',') || '(none)', from: disabledFrom };

  const textOverride = cliVal('text') ?? fileVal('text');
  cfg.text = textOverride && typeof textOverride === 'object' && !Array.isArray(textOverride) ? { ...textOverride } : {};
  cfg.sources.text = { value: `{${Object.keys(cfg.text).length}}`, from: Object.keys(cfg.text).length ? 'config-file/cli' : 'default(前端内置中性文案)' };

  cfg.disabledGroupSet = new Set(cfg.disabledGroups);
  cfg.isGroupDisabled = (g) => cfg.disabledGroupSet.has(g);
  return cfg;
}

// ---------------------------------------------------------------------------
// 进程内单例（同一份 cli 入参只解析一次；夹具/校验器可用 resetConfig 清空）
// ---------------------------------------------------------------------------
let _override = null;
let _cache = null;   // { key, cfg }

/** 供插件入口注入宿主给的 plugin config（等价于 cli 层） */
export function setConfigOverride(obj) {
  if (obj && typeof obj === 'object') {
    _override = { ...(_override ?? {}), ...obj };
    _cache = null;
  }
}
export function resetConfig() {
  _override = null;
  _cache = null;
}
/** @param {object} [cli] 显式覆盖（会与已 setConfigOverride 的合并） */
export function getConfig(cli = null) {
  const merged = { ...(_override ?? {}), ...(cli ?? {}) };
  let key;
  try {
    key = JSON.stringify(merged);
  } catch {
    key = null;   // 含循环引用等不可序列化入参 ⇒ 不缓存
  }
  if (key !== null && _cache && _cache.key === key) return _cache.cfg;
  const cfg = resolveConfig(merged);
  if (key !== null) _cache = { key, cfg };
  return cfg;
}

/** 来源自证：每个键"从哪读到的"（写进面板 meta，便于陌生环境排障） */
export function describeResolution(cfg = getConfig()) {
  const out = {};
  for (const [k, v] of Object.entries(cfg.sources ?? {})) out[k] = { value: v.value, from: v.from };
  for (const key of SCRIPT_KEYS) {
    out['scripts.' + key] = { value: cfg.scripts?.[key]?.path ?? null, from: cfg.scripts?.[key]?.from ?? null };
  }
  if (cfg.errors?.length) out.errors = { value: cfg.errors.length, from: 'config 解析期收集的失败项' };
  return out;
}
