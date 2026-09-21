// dsh-ecosystem-panel / lib/host-protocol.js
// 宿主协议常量（本插件只用到「web server 服务名」这一个符号）。
//
// 为什么单独一个文件、而不是引用宿主适配层：
//   本插件服务端只需要把 route 注册到宿主的 web server 服务上，因此 `inject` 里只能出现
//   服务名字面量。发布集**自带这一份常量**，使用者不需要自备任何适配层（开箱即用）；
//   同时它是**唯一**与本插件耦合的宿主符号，升级宿主时只需核对这一行。
//
// 核对方法（升级主包后建议做一次）：
//   ① 在你自己的实例上确认 web server 服务名仍是 `webServer`
//      （例如在主包里 grep 服务注册点，或在插件里打印 `ctx.get('webServer')` 是否非空）；
//   ② 若宿主把它改名，**不必改代码**：设环境变量
//        DSH_ECOSYSTEM_PANEL_WEBSERVER_SERVICE=<新服务名>
//      即可（本文件在模块加载期读取，插件启动前设好即可生效）。
//
// 注：主包曾把若干服务名在 0.1.5 线收敛/改名（如 apiProxy / conversationEvents 等三方服务）。
//   本插件只依赖 webServer 这一个，未受影响；若日后 `webServer` 也被移除，症状是
//   `inject` 找不到服务 ⇒ 插件不激活（面板按钮不出现），而不是静默出错。

/** 环境变量覆盖键（见文件头说明） */
const OVERRIDE = typeof process !== 'undefined' && process.env
  ? String(process.env.DSH_ECOSYSTEM_PANEL_WEBSERVER_SERVICE ?? '').trim()
  : '';

/** 宿主服务名常量表（本插件只用 webServer，其余按需增补） */
export const SVC = Object.freeze({
  webServer: OVERRIDE || 'webServer'
});

/** 本插件用到的外部 API 前缀（与服务端 route 同源，客户端产物里不要另写一份） */
export const API_PREFIX = '/api/dsh-ecosystem-panel';

export const HOST_PROTOCOL_VERSION = '1.0.0';
