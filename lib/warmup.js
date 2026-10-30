// dsh-ecosystem-panel / lib/warmup.js
//
// 周期预热：让首屏别再"每次都从零算"。
//
// 三条纪律（缺一条都会变成"悄悄后台常驻"）：
//   ① **缺省关闭** —— 预热是要花资源的后台动作，默认不替使用者决定。
//   ② 开了就有自证 —— 开启 / 周期 / 预热哪些源（三个环境变量口 + 配置文件同名键），
//      以及"跑过几次、上次多久、上次每个源什么状态"全部进 SLI，页脚跟状态接口都看得到。
//   ③ 周期缺省 = 300 s，与 TTL 同源（文档仓《06-只读监控面板的设计纪律》§3.2：
//      复用体系里既有的五分钟节奏，**不新增定时作业**）—— 预热只是把同一个 TTL 提前填好，
//      频率比 TTL 更密是白烧 CPU，更疏则首屏照样吃冷启动。
//
// 预热**不联网做额外的事**：它只调用面板本来就会调的那几个源（lane.prime），所以"预热改了行为"
// 这种风险不存在；最坏情况是它把某个慢源多读了几遍 —— 而读幂等、只读、无副作用。

/** 缺省预热周期 = 300 s（与 TTL 同源，见文件头） */
export const DEFAULT_WARMUP_INTERVAL_MS = 300000;
/** 预热周期下限：再密就纯属烧 CPU（一屏数据 300 s 才旧一次） */
export const MIN_WARMUP_INTERVAL_MS = 5000;
/**
 * 缺省预热哪些源：**只挑纯本地、零网络的轻片**。
 * boot / bundles / inserts / patches / skills 都是"读几个文件 + 抓一次本机 HTML"；
 * decoupling / upgrades / registry 要跑外部脚本或查 npm，**不进缺省预热**（要就自己点名）。
 */
export const DEFAULT_WARMUP_SOURCES = ['boot', 'bundles', 'inserts', 'patches', 'skills'];

export const WARMUP_DEFAULTS = Object.freeze({
  enabled: false,
  intervalMs: DEFAULT_WARMUP_INTERVAL_MS,
  sources: DEFAULT_WARMUP_SOURCES
});

function clampInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WARMUP_INTERVAL_MS;
  return Math.max(MIN_WARMUP_INTERVAL_MS, Math.round(n));
}

/**
 * 起一个预热器。
 * @param {object} opts
 * @param {object} opts.lane                     fetch-lane 实例
 * @param {object} [opts.cfg]                    配置层解析结果（读 cfg.warmup）
 * @param {(m:string)=>void} [opts.log]
 * @returns {{ enabled:boolean, config:object, status:()=>object, primeNow:()=>Promise<object>,
 *            whenReady:()=>Promise<object|undefined>, stop:()=>void }}
 */
export function startWarmup(opts = {}) {
  const lane = opts.lane;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const conf = { ...WARMUP_DEFAULTS, ...(opts.cfg?.warmup ?? {}) };
  const enabled = conf.enabled === true;
  const intervalMs = clampInterval(conf.intervalMs);
  const sources = Array.isArray(conf.sources) && conf.sources.length ? conf.sources.slice() : DEFAULT_WARMUP_SOURCES.slice();

  const state = {
    enabled,
    intervalMs,
    sources,
    runs: 0,
    lastRunAt: null,
    lastElapsedMs: null,
    lastSources: null,
    errors: 0,
    lastError: null,
    nextRunAt: null
  };

  if (!lane || !enabled) {
    return {
      enabled: false,
      config: { enabled, intervalMs, sources },
      status: () => ({ ...state, reason: lane ? `未开启（缺省关闭；开法：环境变量 WARMUP=1，见 README）` : '未接车道' }),
      primeNow: async () => ({ skipped: true, reason: '预热未开启' }),
      whenReady: async () => undefined,
      stop: () => {}
    };
  }

  const knownIds = typeof lane.ids === 'function' ? new Set(lane.ids()) : null;
  const asked = sources.includes('*') ? (knownIds ? [...knownIds] : []) : sources;
  const targets = knownIds ? asked.filter((id) => knownIds.has(id)) : asked;
  state.sources = targets;

  let timer = null;
  let running = null;

  const runOnce = async () => {
    const startedAt = Date.now();
    try {
      const summary = await lane.prime(targets);
      state.runs += 1;
      state.lastRunAt = new Date().toISOString();
      state.lastElapsedMs = Date.now() - startedAt;
      state.lastSources = summary.sources;
      log(`warmup #${state.runs}: ${targets.length} 源 / ${state.lastElapsedMs} ms`);
      return summary;
    } catch (error) {
      state.errors += 1;
      state.lastError = String(error?.message ?? error);
      log(`warmup 失败：${state.lastError}`);
      return { error: state.lastError };
    } finally {
      state.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    }
  };

  const primeNow = () => {
    if (running) return running;              // 上一次还没回来就别叠着跑
    running = runOnce().finally(() => { running = null; });
    return running;
  };

  // 先填一次（"预热生效"的证据就在这里：首屏请求到达时缓存已经热了），然后按周期续。
  const first = primeNow();
  timer = setInterval(() => { primeNow(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    enabled: true,
    config: { enabled, intervalMs, sources: targets },
    status: () => ({ ...state, inFlight: running !== null }),
    primeNow,
    whenReady: () => first,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      state.enabled = false;
    }
  };
}
