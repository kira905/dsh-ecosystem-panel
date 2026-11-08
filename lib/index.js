// dsh-ecosystem-panel / lib/index.js（服务端）
// 注册 GET /api/dsh-ecosystem-panel/state —— 只读聚合，无副作用，不加请求栅栏。
// 本 API 只暴露一个只读 GET（没有任何写操作入口），因此不需要控制面栅栏。
//
// 首屏三件（SWR / 周期预热 / 分片取数）的接线都在这里：
//   · 车道（fetch-lane）按当前配置建一条，route 与预热器**共用同一条** ——
//     否则预热填的是另一份缓存，首屏照样吃冷启动（"预热开着却没用"最常见的写法错误）；
//   · 预热器由配置层决定开不开（缺省关），生命周期跟着插件 effect 走，卸载时 timer 一并停掉。
import { API_PREFIX, buildState, getLane, setWarmupReporter } from './state.js';
import { startWarmup } from './warmup.js';
// 宿主服务名常量（自带，不依赖任何外部适配层；服务名可经环境变量覆盖，见 host-protocol.js）
import { SVC } from './host-protocol.js';
import { getConfig, setConfigOverride } from './config.js';

export const inject = [SVC.webServer];
export const name = 'dsh-ecosystem-panel';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer'
};
function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(payload);
}

/**
 * @param {object} ctx 宿主上下文（cordis）
 * @param {object} [pluginConfig] 宿主传给插件的 config（可含 home / profile / toolsDir / patchManifest …
 *                                等任意配置层键；优先级高于配置文件与环境变量，见 lib/config.js）
 */
function apply(ctx, pluginConfig) {
  if (pluginConfig && typeof pluginConfig === 'object') setConfigOverride(pluginConfig);
  // 【0.5.2 · 2026-11-09】默认读**正在跑的那个 profile**，而不是写死的 web。
  // 桌面版（Electron）用的是 profiles/desktop：本面板过去只读 profiles/web，
  // 于是"在桌面版上把某个包改坏，面板读数一动不动"（A-8 关 4 实测）。
  // 优先级不变：显式配置（cli/env/配置文件）＞ 宿主报的 profileContext ＞ 默认 web。
  try {
    const pcRaw = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
    const pc = pcRaw && typeof pcRaw === 'object' ? pcRaw : null;
    const before = getConfig();
    const hint = {};
    const profileFrom = String(before?.sources?.profile?.from ?? '');
    if (pc?.name && profileFrom.startsWith('default')) hint.profile = String(pc.name);
    const homeFrom = String(before?.sources?.home?.from ?? '');
    if (pc?.home && homeFrom.startsWith('default')) hint.home = String(pc.home);
    if (Object.keys(hint).length > 0) setConfigOverride(hint);
  } catch {
    // 拿不到 profileContext 就按旧口径（web）走，绝不因为这一层把面板整体弄挂
  }
  ctx.effect(() => {
    const disposers = [];
    const cfg = getConfig();
    const lane = getLane(cfg);
    const warm = startWarmup({
      lane,
      cfg,
      log: (m) => console.log('[ecosystem-panel] ' + m)
    });
    // 预热状态进 SLI（页脚与 /state 都能看到"开没开、跑过几次、上次多久"）
    setWarmupReporter(() => warm.status());
    try {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}/state`,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' });
          }
          try {
            // ?refresh=1 只强制重查升级体检（默认走 TTL 缓存，面板打开不卡）；
            // ?refresh=all 则整屏丢缓存重取（排障用，别日常按）
            const url = req.url ?? '';
            const refresh = /(?:\?|&)refresh=1(?:&|$)/.test(url);
            const forceAll = /(?:\?|&)refresh=all(?:&|$)/.test(url);
            const state = await buildState({ lane, refreshUpgrades: refresh, ...(forceAll ? { force: true } : {}) });
            writeJson(res, 200, state, { 'cache-control': 'no-store' });
          } catch (error) {
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) }, { 'cache-control': 'no-store' });
          }
        }
      }));
    } catch (error) {
      for (const dispose of disposers) dispose();
      warm.stop();
      setWarmupReporter(null);
      throw error;
    }
    return () => {
      warm.stop();
      setWarmupReporter(null);
      for (const dispose of disposers) dispose();
    };
  }, 'ecosystem-panel: state route');
}

export { apply };
