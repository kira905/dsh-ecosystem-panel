// dsh-ecosystem-panel / lib/fetch-lane.js
//
// 取数车道：只读面板首屏的四件工程件，一处实现、按源复用。
//
//   ① TTL 缓存 + SWR —— 数据块自带 fetchedAt；过期先给旧值（带年龄），后台换新。
//      冷启动（连旧值都没有）**不许返回空壳**：阻塞取真值，并把这一次记成 coldMiss。
//   ② 单飞 —— 同一源同一时刻只有一次在途取数；并发请求共享那一次。
//   ③ 超时预算 —— 每源一个超时，整页一个总预算；慢源不拖死整页。
//   ④ 局部降级 —— 某源超时 / 报错 / 未配置 ⇒ 只有那一格标「不可探测 + 原因」，其余照出。
//
// 计量（SLI）也在这里数：命中 / 未命中 / 冷启动 / 取数耗时 / 降级次数。**每轮读数都是现算的**，
// 不落盘、不跨进程复用。
//
// 这一层只做"取数这件事"，不掺任何业务判定 —— 源的清单与每个源怎么跑，由调用方给
// （本仓见 lib/state.js 的 SOURCES；下游也可以 registerSource() 追加自己的源）。

/** 缺省 TTL = 300 s（复用体系里既有的五分钟节奏；依据见文档仓《06-只读监控面板的设计纪律》§3.2） */
export const DEFAULT_TTL_MS = 300000;
/** 缺省单源超时 */
export const DEFAULT_SOURCE_TIMEOUT_MS = 2000;
/** 缺省整页总预算（单源超时之和会远大于它，这里防"十个慢源叠起来"） */
export const DEFAULT_TOTAL_BUDGET_MS = 6000;
/** 失败后的冷却：冷却期内不再反复打同一个坏源（避免一个挂掉的源被每屏请求反复捅） */
export const DEFAULT_RETRY_DELAY_MS = 5000;

/** 降级原因枚举（页面上原样显示，所以只放三种 + 预算一种） */
export const REASON = Object.freeze({
  TIMEOUT: '超时',
  ERROR: '报错',
  NOT_CONFIGURED: '未配置',
  BUDGET: '总预算耗尽'
});

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function timeoutError(ms) {
  const e = new Error(`取数超时（>${ms} ms）`);
  e.code = 'LANE_TIMEOUT';
  return e;
}

/**
 * 建一条车道。
 * @param {object} options
 * @param {Array<object>} options.sources 源定义：{ id, label, group, deps?, timeoutMs?, requires?(ctx), run(ctx) }
 * @param {number} [options.ttlMs]
 * @param {number} [options.defaultTimeoutMs]  每源超时缺省值（源定义里的 timeoutMs 优先）
 * @param {number} [options.totalBudgetMs]     一次 readAll 的总预算
 * @param {number} [options.retryDelayMs]      失败冷却窗口
 * @param {() => number} [options.now]         时钟（夹具注入假时钟测 TTL 用）
 * @param {() => number} [options.elapsedClock] 真实耗时用的钟（缺省 Date.now；两者故意分开）
 * @param {object} [options.context]           车道级上下文（paths / cfg / opts）：预热走 lane.prime() 时也要能取数
 */
export function createLane(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  // 两个钟故意分开：clock 管"数据块什么时候取的"（夹具会注入假时钟测 TTL），
  // real 管"这次取数花了多久"（假时钟不会随真实等待走动，混用会把耗时读成 0）。
  const real = typeof options.elapsedClock === 'function' ? options.elapsedClock : () => Date.now();
  const ttlMs = num(options.ttlMs, DEFAULT_TTL_MS);
  const defaultTimeoutMs = num(options.defaultTimeoutMs, DEFAULT_SOURCE_TIMEOUT_MS);
  const totalBudgetMs = num(options.totalBudgetMs, DEFAULT_TOTAL_BUDGET_MS);
  const retryDelayMs = num(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);

  /** id -> 源定义 */
  const defs = new Map();
  /** id -> { value, fetchedAt, elapsedMs }：已取回的数据块（自带 fetchedAt 就是 SWR 的全部状态） */
  const cache = new Map();
  /** id -> { promise, startedAt }：在途表（单飞的唯一凭据） */
  const inflight = new Map();
  /** id -> { at, reason, detail }：最近一次失败（冷却窗口用） */
  const failure = new Map();
  /** id -> 计数 */
  const meters = new Map();
  const totals = { requests: 0, requestMs: 0, lastRequestMs: 0 };

  function addSource(def) {
    if (!def || typeof def.id !== 'string' || typeof def.run !== 'function') {
      throw new Error('fetch-lane: 源定义至少要 { id, run }');
    }
    defs.set(def.id, def);
    return def;
  }
  for (const def of options.sources ?? []) addSource(def);

  function meter(id) {
    let m = meters.get(id);
    if (!m) {
      m = { hit: 0, miss: 0, coldMiss: 0, fetches: 0, failures: 0, degraded: 0, fetchMs: 0, lastMs: 0 };
      meters.set(id, m);
    }
    return m;
  }

  const expired = (entry, t) => (t - entry.fetchedAt) > ttlMs;

  /** 一次读取的结果形状（stale/fresh/cold/degraded 四态，页面只认前三个有值） */
  function freshResult(id, entry, t, status) {
    return {
      id,
      status,
      value: entry.value,
      fetchedAt: entry.fetchedAt,
      ageMs: Math.max(0, t - entry.fetchedAt),
      elapsedMs: 0,
      reason: null,
      detail: null
    };
  }

  function degradedResult(id, reason, detail, elapsedMs, extra = {}) {
    return {
      id,
      status: 'degraded',
      value: undefined,
      fetchedAt: null,
      ageMs: null,
      elapsedMs,
      reason,
      detail: detail ?? null,
      ...extra
    };
  }

  function classify(error) {
    if (error?.code === 'LANE_TIMEOUT') return { reason: REASON.TIMEOUT, detail: String(error?.message ?? error) };
    return { reason: REASON.ERROR, detail: String(error?.message ?? error) };
  }

  /** 迟到 / 及时的成功都缓存：成功后清掉失败标记 */
  function store(id, value, startedAt) {
    const at = clock();
    const prev = cache.get(id);
    if (!prev || prev.fetchedAt <= at) {
      cache.set(id, { value, fetchedAt: at, elapsedMs: at - startedAt });
    }
    failure.delete(id);
    return at;
  }

  function withTimeout(promise, ms) {
    if (!(ms > 0) || !Number.isFinite(ms)) return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(timeoutError(ms)), ms);
      if (typeof timer.unref === 'function') timer.unref();
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  /**
   * 真正跑一次源（含单飞 / 超时 / 预算 / 降级记账）。
   * @returns {Promise<{ok:boolean, value?:any, reason?:string, detail?:string, elapsedMs:number}>}
   */
  function refresh(def, ctx = {}) {
    const running = inflight.get(def.id);
    if (running) return running.promise;   // ← 单飞：后来者共享在途那一次

    const startedAt = clock();
    const startedReal = real();
    const budgetLeft = typeof ctx.deadline === 'number' ? ctx.deadline - clock() : Infinity;
    const ownTimeout = num(ctx?.opts?.sourceTimeouts?.[def.id], num(def.timeoutMs, defaultTimeoutMs));
    const limit = Math.min(ownTimeout, budgetLeft);
    // 掐断是"单源超时"还是"整页预算用完了"？—— 页脚上这两个原因必须分得开：
    // 前者说明这个源慢，后者说明整页的预算该调了（或者某个源在拖后腿）。
    const budgetBound = budgetLeft < ownTimeout;

    const m = meter(def.id);
    const promise = (async () => {
      if (!(limit > 0)) {
        m.degraded += 1;
        return { ok: false, reason: REASON.BUDGET, detail: `整页总预算 ${totalBudgetMs} ms 已用完`, elapsedMs: real() - startedReal, noFetch: true };
      }
      const gateReason = typeof def.requires === 'function' ? def.requires(ctx) : null;
      if (gateReason) {
        m.degraded += 1;
        return { ok: false, reason: REASON.NOT_CONFIGURED, detail: String(gateReason), elapsedMs: real() - startedReal, noFetch: true };
      }
      m.fetches += 1;
      const startedFetch = clock();
      const sourcePromise = Promise.resolve().then(() => def.run(ctx));
      // 迟到的成功也收下：超时只是"这一屏不再等"，不是"这个源的数据作废"
      sourcePromise.then(
        (value) => { store(def.id, value, startedFetch); },
        () => { /* 失败由下面的 catch 记账；这里只吞掉未处理的 rejection */ }
      );
      try {
        const value = await withTimeout(sourcePromise, limit);
        const elapsed = real() - startedReal;
        store(def.id, value, startedFetch);
        m.lastMs = elapsed;
        m.fetchMs += elapsed;
        return { ok: true, value, elapsedMs: elapsed };
      } catch (error) {
        const elapsed = real() - startedReal;
        const classified = classify(error);
        const reason = budgetBound && classified.reason === REASON.TIMEOUT ? REASON.BUDGET : classified.reason;
        const detail = reason === REASON.BUDGET
          ? `整页总预算 ${totalBudgetMs} ms 已用完（本源的超时上限是 ${ownTimeout} ms）`
          : classified.detail;
        m.failures += 1;
        m.degraded += 1;
        m.lastMs = elapsed;
        failure.set(def.id, { at: clock(), reason, detail });
        return { ok: false, reason, detail, elapsedMs: elapsed };
      }
    })();

    inflight.set(def.id, { promise, startedAt });
    promise.finally(() => {
      const cur = inflight.get(def.id);
      if (cur && cur.promise === promise) inflight.delete(def.id);
    }).catch(() => {});
    return promise;
  }

  /**
   * 读一个源。
   *   新鲜 → hit；过期 → 先给旧值（stale）+ 后台刷新（miss）；没有旧值 → 阻塞取真值（coldMiss）。
   */
  async function read(target, ctx = {}) {
    const def = typeof target === 'string' ? defs.get(target) : target;
    if (!def) throw new Error(`fetch-lane: 未知数据源 ${String(target)}`);
    const t = clock();
    const entry = cache.get(def.id);
    const m = meter(def.id);

    if (entry !== undefined && !expired(entry, t)) {
      m.hit += 1;
      return freshResult(def.id, entry, t, 'fresh');
    }
    if (entry !== undefined) {
      m.miss += 1;
      refresh(def, ctx);                       // 不 await：这一屏用旧值先出
      return freshResult(def.id, entry, t, 'stale');
    }
    const cool = failure.get(def.id);
    if (cool && (t - cool.at) < retryDelayMs) {
      // 刚失败过：冷却期内不再捅它，直接如实报「不可探测」+ 上次的原因
      m.degraded += 1;
      return degradedResult(def.id, cool.reason, cool.detail, 0, { coolingDown: true });
    }
    m.coldMiss += 1;
    const started = real();
    const r = await refresh(def, ctx);
    if (r.ok) {
      const at = clock();
      const justStored = cache.get(def.id);
      const entryNow = justStored ?? { value: r.value, fetchedAt: at };
      if (!justStored) cache.set(def.id, { value: r.value, fetchedAt: at, elapsedMs: r.elapsedMs });
      return { ...freshResult(def.id, entryNow, at, 'cold'), elapsedMs: real() - started };
    }
    return degradedResult(def.id, r.reason, r.detail, real() - started, { reasonCode: r.reason });
  }

  /**
   * 一次取数 pass：按依赖顺序把给定源读出来（同一 pass 内同一源只读一次），
   * 整页共享一个总预算 deadline。
   * @param {string[]} ids
   * @param {{ opts?: object, force?: string[]|boolean }} [ctx]
   * @returns {Promise<{ results: Map<string, object>, byId: object, startedAt:number, elapsedMs:number, deadline:number }>}
   */
  async function readAll(ids, ctx = {}) {
    const startedAt = clock();
    const startedReal = real();
    const deadline = startedAt + totalBudgetMs;
    const base = options.context ?? {};   // 车道级上下文：路径/配置这类"每条车道都一样"的东西
    const pass = {
      opts: ctx.opts ?? base.opts ?? {},
      deadline,
      values: new Map(),
      results: new Map(),
      pending: new Map()
    };
    const force = ctx.force === true ? new Set(ids) : new Set(Array.isArray(ctx.force) ? ctx.force : []);

    const visit = (id) => {
      if (pass.results.has(id)) return Promise.resolve(pass.results.get(id));
      if (pass.pending.has(id)) return pass.pending.get(id);
      const def = defs.get(id);
      if (!def) return Promise.reject(new Error(`fetch-lane: 未知数据源 ${id}`));
      const p = (async () => {
        for (const dep of def.deps ?? []) {
          if (!defs.has(dep)) continue;
          await visit(dep);
        }
        const one = {
          ...base,
          ...ctx,
          deadline,
          get: (depId) => pass.values.get(depId),
          paths: ctx.paths ?? base.paths ?? null,
          cfg: ctx.cfg ?? base.cfg ?? null
        };
        if (force.has(id)) cache.delete(id);     // 显式刷新：丢掉旧值，按冷路径重取
        const r = await read(def, one);
        pass.results.set(id, r);
        pass.values.set(id, r.value);
        return r;
      })();
      pass.pending.set(id, p);
      return p;
    };

    await Promise.all(ids.map(visit));
    const elapsedMs = real() - startedReal;
    totals.requests += 1;
    totals.requestMs += elapsedMs;
    totals.lastRequestMs = elapsedMs;
    const byId = {};
    for (const [id, r] of pass.results) byId[id] = r;
    return { results: pass.results, byId, startedAt, elapsedMs, deadline };
  }

  /** 预热用：把给定源读一遍（新鲜的就只算命中，不重复取） */
  async function prime(ids, ctx = {}) {
    const out = await readAll(ids, ctx);
    const summary = { at: new Date().toISOString(), elapsedMs: out.elapsedMs, sources: {} };
    for (const [id, r] of out.results) {
      summary.sources[id] = { status: r.status, elapsedMs: r.elapsedMs, reason: r.reason ?? null };
    }
    return summary;
  }

  /** 等在途取数全部落定（夹具与"后台刷新完再看一眼"用） */
  async function settle() {
    while (inflight.size > 0) {
      const list = [...inflight.values()].map((v) => v.promise.catch(() => {}));
      await Promise.all(list);
    }
  }

  /** SLI 读数（页脚那三行数的源） */
  function sli() {
    const perSource = {};
    const sums = { hit: 0, miss: 0, coldMiss: 0, fetches: 0, failures: 0, degraded: 0 };
    for (const [id, m] of meters) {
      const avgMs = m.fetches > 0 ? Math.round(m.fetchMs / m.fetches) : 0;
      perSource[id] = {
        hit: m.hit,
        miss: m.miss,
        coldMiss: m.coldMiss,
        fetches: m.fetches,
        failures: m.failures,
        degraded: m.degraded,
        lastMs: m.lastMs,
        avgMs,
        cached: cache.has(id),
        ageMs: cache.has(id) ? Math.max(0, clock() - cache.get(id).fetchedAt) : null,
        stale: cache.has(id) ? expired(cache.get(id), clock()) : null,
        inflight: inflight.has(id)
      };
      for (const k of Object.keys(sums)) sums[k] += m[k];
    }
    return {
      ttlMs,
      defaultTimeoutMs,
      totalBudgetMs,
      retryDelayMs,
      sources: perSource,
      totals: {
        ...sums,
        requests: totals.requests,
        lastRequestMs: totals.lastRequestMs,
        avgRequestMs: totals.requests > 0 ? Math.round(totals.requestMs / totals.requests) : 0,
        inflight: inflight.size
      }
    };
  }

  /** 夹具用：清空缓存/在途/计数（不删源定义） */
  function reset() {
    cache.clear();
    inflight.clear();
    failure.clear();
    meters.clear();
    totals.requests = 0;
    totals.requestMs = 0;
    totals.lastRequestMs = 0;
  }

  return {
    ids: () => [...defs.keys()],
    defs,
    addSource,
    read,
    readAll,
    prime,
    settle,
    sli,
    reset,
    ttlMs,
    totalBudgetMs
  };
}
