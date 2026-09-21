// dsh-ecosystem-panel / lib/index.js（服务端）
// 注册 GET /api/dsh-ecosystem-panel/state —— 只读聚合，无副作用，不加请求栅栏。
// 本 API 只暴露一个只读 GET（没有任何写操作入口），因此不需要控制面栅栏。
import { API_PREFIX, buildState } from './state.js';
// 宿主服务名常量（自带，不依赖任何外部适配层；服务名可经环境变量覆盖，见 host-protocol.js）
import { SVC } from './host-protocol.js';
import { setConfigOverride } from './config.js';

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
  ctx.effect(() => {
    const disposers = [];
    try {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}/state`,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' });
          }
          try {
            // ?refresh=1 强制重查 npm latest（默认走 24h 文件缓存，面板打开不卡）
            const refresh = /(?:\?|&)refresh=1(?:&|$)/.test(req.url ?? '');
            const state = await buildState({ refreshUpgrades: refresh });
            writeJson(res, 200, state, { 'cache-control': 'no-store' });
          } catch (error) {
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) }, { 'cache-control': 'no-store' });
          }
        }
      }));
    } catch (error) {
      for (const dispose of disposers) dispose();
      throw error;
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'ecosystem-panel: state route');
}

export { apply };
