# dsh-ecosystem-panel

> ### 这是什么
> **一个只读的「生态体检」面板插件**：bundle / patch / skill / 升级 / 解耦，一屏看完。
>
> ### 它解决什么
> 装了十几个插件之后，"到底挂上了没、有没有重复挂、谁的补丁和谁打架"会变成玄学。这个面板只做一件事：把六类体检结果摊在一屏上，**全是只读**，不会替你改任何东西。首屏还有 SWR 与周期预热（旧值先出、不转圈），以及一页脚 SLI 告诉你"这屏数据多久之前采的"。
>
> ### 一条命令跑起来
> ```powershell
> dsh plugin --profile web add @kira905/dsh-ecosystem-panel
> ```
> 装完在侧边栏进入面板；不用改 `cordis.patch.yml`。
>
> ### 它长什么样
> 一屏六组卡片（每个插件一行状态 + 一句诊断理由），页脚一行采样时间与耗时。⚠️ 本仓**暂无截图**。

> ### 它不附带什么（先看清楚，省得装完失望）
>
> 这套开源出来的是**能用的工具 + 装完自检 + 设计文档**。有两块**不在开源范围里**：
>
> 1. **「自己盯着活干」的那套引擎**：定时调度、队列盯守、管家日报、自主决定要不要动手 —— 这几件还没整理出来放（整理完会陆续放）。它的**设计本身是公开的**，写在 [`ops-handoff-design`](https://github.com/kira905/ops-handoff-design) 仓里，想自己实现的人照着做得到。
> 2. **「出事喊到人」的通道**：企业微信、语音播报这类 —— **不随开源发布**。
>
> 所以：装完你拿到的是一套**能用的工具**，不是一个会自己上班的管家。

> ### 支持哪个版本的 DSH
> **DSH 0.2.x** —— 现在发出来的 0.2.1 / 0.2.2 各个 rc 都能用。
>
> 为什么不用 `peerDependencies` 卡版本：宿主目前发布的**都是预发布版**，而按 node-semver 的规则，
> 预发布版本只有当区间里存在「同 major.minor.patch 且带预发布比较器」的条目时才放行 ——
> 也就是说 `>=0.2.0-rc.2 <0.3.0` 这种写法在**任何一个真实宿主上都必然报警**，纯噪音（实测不阻断安装、也不阻断挂载）。
> 所以本包的做法是：**装的时候不拦你；运行时按能力探测，探测不到就走降级路径**，不会硬崩。

---

> **本仓装完即用**：`dsh plugin --profile <profile> add @kira905/dsh-ecosystem-panel` 一条命令，`dsh.bundle` 会让它自动挂进 profile 的组合列表，**不需要再手工写 `cordis.patch.yml`**。

## 装完自检（三条只读验法）

`<profile>` 换成你实际用的 profile（默认 `web`），`<数据根>` 换成你的 DSH 数据根（默认 `~/.dsh`）。

```powershell
# ① 组合树里有没有它（只读、约 0.6 秒、不启服务）
dsh --profile <profile> --dump-config | Select-String "dsh-ecosystem-panel"
# 期望：bundle 层出现一行 "# == <登记名>"、insert 层出现 "- id: <entry>"（问的都是「它挂上没」）；
#       本仓包名 @kira905/dsh-ecosystem-panel —— 带 scope 装的写带 scope 名、老工装 / 手写的可能是裸名，两种都搜一遍
#       ⚠️ 若该包会 insert 一行，还要数一遍"同一个 id 出现了几次"，必须 == 1

# ② 组合列表里有没有它（只读）
Get-Content <数据根>/profiles/<profile>/package.json | Select-String "@kira905/dsh-ecosystem-panel"
# 期望：dependencies 与 dsh.profile.bundles 两处都有（CLI 类只需要 dependencies；bundles 里也可能写裸名 dsh-ecosystem-panel）

# ③ 本仓是插件、没有命令入口 —— 跳过这一步（判据看 ① 与 ②）
```

---

> **English**: [README.en.md](./README.en.md)

> 给 DSH 实例装一块**只读**的生态总览面板：插件有没有加载、补丁还在不在、技能 frontmatter 有没有写坏、
> 依赖有没有升级风险 —— 一屏看完，🟢🟡🔴 三色。
>
> 它**只诊断，不动手**：不装包、不卸包、不升级、不改配置、不写任何被体检对象。

侧边栏底部「设置」齿轮上方会多一个图标按钮，点开就是面板；服务端只暴露一个只读接口：

```
GET /api/dsh-ecosystem-panel/state
```

## 设计依据

本组件是「[ops-handoff-design](https://github.com/kira905/ops-handoff-design)」所述运维体系的一个实现，
设计依据（对应文档仓约定的固定四问）：

- **它为什么存在、边界在哪** → 见《只读监控面板的设计纪律》**§1 面板要回答的问题**、**§2 显示纪律（不可探测 + 原因）**；本组件的六类体检正是那份纪律的一次落地
- **首屏怎么取数（SWR / 周期预热 / 分片 + 单飞 + 超时预算 + 局部降级）** → 见《只读监控面板的设计纪律》**§3.2「处置：分片 + TTL + 单飞 + 超时预算」**（**TTL = 300 s** 的出处就在这一节：「复用既有五分钟节奏，不新增定时作业」）；同篇 §3.2 末尾「缓存只走 TTL + 单飞、不加 HTTP 缓存协商」也是本实现的取舍依据（见本 README §5.1）
- **它与宿主版本的兼容区间** → 见《多机交接与云中继》**§4.5「兼容性要求」**（另见本 README 第 6 节「兼容性」）
- **本组件特有的坑与实测** → 见本 README「已知限制」一节；另见《只读监控面板的设计纪律》**§7 设计教训汇总**（三次"静默不报"的来历）
- **文档仓地址** → Gitee（镜像）<https://gitee.com/kira905/ops-handoff-design>
  ｜ GitHub（主）<https://github.com/kira905/ops-handoff-design>
  （文档仓的组件索引表回指本仓；两仓互链、版本各自独立）

> 设计稿里不写具体仓库地址（写死即死链），实现清单统一收在文档仓的组件索引表里——本仓只负责回链章节。

---

## 1. 它看什么（六类 + 一个可选类）

| 类目 | 数据来源 | 判定 | 数据缺失时 |
|---|---|---|---|
| ① **bundle 插件** | profile 的 `package.json`（`dsh.profile.bundles` + `dependencies`）+ 各包实体 `package.json` + 宿主首页的 boot 清单 | 实体在不在 / 声明版本与实体版本是否漂移 / 声明了 client 能力但 boot 里没加载 = 🔴 | boot 抓不到 ⇒ 显示「加载状态未知」（黄），**不当作已加载** |
| ② **patch insert 插件** | profile 的 `cordis.patch.yml` 里的 `insert` 条目 | 实体目录能否解析到（profile 层 → 共享 fallback 层）；被 `disabled` 的标黄 | YAML 解析器不可用 ⇒ 明说「不可解析」，不当成空清单 |
| ③ **补丁健康** | **你提供的补丁清单**（外置 JSON） | 逐条做特征串扫描：`contains` 缺一个 = 定制被冲掉（黄）；目标文件没了 = 🔴；`notContains` 命中 = 残留 | 清单没配 ⇒ 显示「未配置 ⇒ 不可判定」（黄），**不显示"0 个补丁"** |
| ④ **技能** | 数据根下 `skills/*/SKILL.md` 的 frontmatter | 缺 `name` / `description`、frontmatter 解析失败 | 目录不存在 ⇒ 报 `skillsDirOk=false` |
| ⑤ **升级体检** | 本地实体版本 + npm registry 最新版（24h 文件缓存）+ 你的规则表文案 | 颜色由**外部只读 CLI** 判定；本面板只渲染（拿不到就显示「档位不可用」+ 原因，**绝不猜颜色**） | 没配 CLI ⇒ 每行 `unknown` + 原因 |
| ⑥ **解耦健康** | **你提供的外部检查脚本**（动态 import 复用其导出函数，不复制判定） | R1 静态 import 宿主符号 = 🔴；动态导入/依赖未归零 = 🟡 | 没配脚本 ⇒ 一条 🟡 + 配置指引 |
| ⑦ **跨表准入一致性**（可选） | **你提供的外部校验器** | 三态显式枚举 `ok / fail / unavailable`；`asOf` 缺失即判 `unavailable` | 没配 ⇒ `unavailable`（**不是** 0/0/0 绿） |

**设计红线（贯穿全仓）**：读不到的东西一律显示「不可探测 + 原因」，**绝不显示 0、绝不假装全绿**。
面板 meta 里还带一份**配置来源自证**（每个配置键到底是从 CLI / 环境变量 / 配置文件 / 自动探测 / 默认值
哪一层读到的），换机器排障时先看它。

## 同源说明

本仓**部分文件与一套内部生产实现同源**（同一份工程长期演进下来的两处落点）。

- **同源程度**：按**行级同源度**口径统计（同名可比件里，仓内文件的非空行有多少能在参照件中找到，多重集扣减），本仓「≥50% 行同占比」= **100%**。
- **这意味着**：本仓是那套实现的**提炼导出** —— **既不是逐字副本，也不是完全重写的独立实现**。拿单个文件当"独立参考实现"读之前，请先跑下面的判据。
- **怎么复跑**：同源度扫描器见 `dsh-quality-toolkit` 的 `dsh-sim-scan.mjs`（`--repo <本仓> --prod-root <参照根>`）；分档阈值与口径写在它的 `config/sim-scan.json` 里，不藏在代码里。
- **许可**：本仓许可见仓根 `LICENSE`（有子树例外时以子树 `LICENSE` 为准）。

## 2. 前置条件

- 一个 DSH 实例（web profile），主包线见 §6 兼容性表
- Node ≥ 18.17（用到了内置 `fetch` / `AbortSignal.timeout`）
- **YAML 解析器（`js-yaml`）**：由宿主 profile 的依赖链提供（通常随主包自带）。解析不到时 ②④
  两类会显式显示「不可解析」，其它四类不受影响
- 可选的三个/四个外部脚本（解耦检查、档位 CLI、跨表校验器、适配层一致性校验器）——**没有也能跑**，
  对应类目会降级；本仓不附带这些脚本（它们属于你自己的体检体系）

> **手工装（旧版 / 离线用）** —— 下面三步是 0.4.5 之前的装法（`npm install --prefix` + 手写 profile `package.json` 两处）；
> 现在有 `dsh.bundle`，一条 `dsh plugin --profile <profile> add @kira905/dsh-ecosystem-panel` 就够，见文首那段。
> **两条路别混用**：混用会在组合里留下**同一件的两份登记**（`dsh.profile.bundles` 里同一包名两行，或 `cordis.patch.yml` 里同一个 id 两行；后者**不一定会报错**，光看日志发现不了）⇒ 判据 = 两处各数一遍，每一处必须 == 1。

## 3. 安装三步

```bash
# ① 装进 profile（npm 包名：@kira905/dsh-ecosystem-panel）
npm install @kira905/dsh-ecosystem-panel --prefix "<数据根>/profiles/web"
#   离线 / 要改源码时：把本仓 clone 到
#   "<数据根>/profiles/web/node_modules/@kira905/dsh-ecosystem-panel"

# ② 注册：profile 的 package.json 里
#      "dependencies": 加一条  "@kira905/dsh-ecosystem-panel": "0.5.0"
#      "dsh.profile.bundles": 数组里加 "@kira905/dsh-ecosystem-panel"

# ③ 重启 DSH（本插件没有热加载），然后打开 GUI：侧边栏齿轮上方应出现面板按钮
```

验证（不依赖 GUI）：

```bash
node "<数据根>/profiles/web/node_modules/@kira905/dsh-ecosystem-panel/scripts/verify-state.mjs"
# 终端里应打印六类结果 + 配置来源自证
```

> 包已发布到 npm（`@kira905/dsh-ecosystem-panel`）：`npm install` 只装它自己（`dependencies` 为空，
> `js-yaml` 由宿主 profile 提供）。早期版本只发 Release、不进 npm；本版（`0.4.4`）起以 scope 包名发布。

## 4. 配置

优先级（**每个键独立**）：`显式传入（插件 config / 调用参数）` > `环境变量` > `配置文件` > `自动探测` > `内置默认`。

### 4.1 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_ECOSYSTEM_PANEL_HOME` | DSH 数据根 | `os.homedir()/.dsh`（`DSH_HOME` 同效、优先级更低） |
| `DSH_ECOSYSTEM_PANEL_PROFILE` | profile 名 | `web` |
| `DSH_ECOSYSTEM_PANEL_WEB_URL` | 本实例基址（抓 boot 清单用） | `DSH_WEB_URL`，否则 `http://127.0.0.1:3080` |
| `DSH_ECOSYSTEM_PANEL_TOOLS_DIR` | 外部工具目录（**不自动探测**） | 空 ⇒ 依赖它的类目降级 |
| `DSH_ECOSYSTEM_PANEL_MAIN_NM` | 宿主主包 node_modules | 按全局 npm 布局探测；探测不到即判不可用 |
| `DSH_ECOSYSTEM_PANEL_CONFIG` | 配置文件 JSON 路径 | 空 |
| `DSH_ECOSYSTEM_PANEL_CACHE_FILE` | 升级体检缓存文件 | `<数据根>/ecosystem-panel-upgrade-cache.json` |
| `DSH_ECOSYSTEM_PANEL_DECOUPLING_SCRIPT` | 解耦检查脚本 | `<toolsDir>/check-decoupling.mjs` |
| `DSH_ECOSYSTEM_PANEL_TRIAGE_CLI` | 升级档位只读 CLI | `<toolsDir>/upgrade-triage-cli.mjs` |
| `DSH_ECOSYSTEM_PANEL_REGISTRY_AUDIT_LIB` | 跨表准入校验器 | `<toolsDir>/registry-audit.mjs` |
| `DSH_ECOSYSTEM_PANEL_HOST_ADAPTER_SYNC` | 适配层一致性校验器（可选） | `<toolsDir>/sync-host-adapter.mjs` |
| `DSH_ECOSYSTEM_PANEL_PATCH_MANIFEST_FILE` | 补丁清单 JSON | 空 ⇒ ③ 显示「未配置」 |
| `DSH_ECOSYSTEM_PANEL_UPGRADE_RULES_FILE` | 升级规则表 JSON | 空 |
| `DSH_ECOSYSTEM_PANEL_BREAKING_SYMBOLS_FILE` | 断裂符号表 JSON | 空 |
| `DSH_ECOSYSTEM_PANEL_LABELS_FILE` | 包名 → 一句话简介 JSON | 空（没登记的包只是没有简介） |
| `DSH_ECOSYSTEM_PANEL_DISABLED_GROUPS` | 整组停用的类目（逗号分隔） | 全开 |
| `DSH_ECOSYSTEM_PANEL_WEBSERVER_SERVICE` | 宿主 web server 服务名 | `webServer` |
| `DSH_ECOSYSTEM_PANEL_TTL_MS` | 「过期」阈值（数据块 `fetchedAt` 与它的差） | `300000`（300 s，见 §5.1） |
| `DSH_ECOSYSTEM_PANEL_SOURCE_TIMEOUT_MS` | 单源缺省超时 | `2000` ms |
| `DSH_ECOSYSTEM_PANEL_TOTAL_BUDGET_MS` | 一次首屏的总预算 | `10000` ms |
| `DSH_ECOSYSTEM_PANEL_SOURCE_TIMEOUTS` | 逐源覆盖单源超时，形如 `boot=1500,skills=500` | 空（用单源缺省） |
| `DSH_ECOSYSTEM_PANEL_WARMUP` | 周期预热开关（`1/true/on` 开） | `0`（**关**：后台常驻要花资源，不替使用者决定） |
| `DSH_ECOSYSTEM_PANEL_WARMUP_MS` | 预热周期（< 5000 会被压到 5000；0/负数回缺省） | `300000`（300 s，与 TTL 同源） |
| `DSH_ECOSYSTEM_PANEL_WARMUP_SOURCES` | 预热哪些源（逗号分隔；`*` = 全部） | `boot,bundles,inserts,patches,skills`（纯本地五源） |

### 4.2 配置文件与示例

`examples/` 下有五份可直接抄的示例：

| 文件 | 对应配置 |
|---|---|
| `ecosystem-panel.config.example.json` | 总览（各键的位置与形态） |
| `patch-manifest.example.json` | ③ 补丁清单（`checks` / `special` / `retired` 三种形态都有例子，字符串里可用 `${HOME}` 占位符） |
| `upgrade-rules.example.json` | ⑤ 规则表文案（`verdict` 只是文案分类，不决定颜色） |
| `breaking-symbols.example.json` | 宿主主包断裂符号参考底表 |
| `labels.example.json` | 包名 → 一句话简介 |

用法：

```bash
DSH_ECOSYSTEM_PANEL_CONFIG=/path/to/my.config.json   # 指向你抄过去改的那份
```

### 4.3 降级语义（重要）

- **没配 ≠ 没有**：③ 未配清单时显示「未配置 ⇒ 不可判定」，不会显示"0 个补丁全绿"；
  ⑥⑦ 与 ⑤ 同理（都带配置指引）。
- **抓不到**：宿主首页抓不到 boot 清单时，① 只把"未知"标黄，并把抓取错误原文放进 `meta.bootError`。
- **停用**：确实不需要某一类，就把它写进 `disabledGroups` —— 面板会显示一条「已按配置停用」的提示项
  （比静默消失更清楚，且不计入汇总）。
- 配置解析失败（比如清单 JSON 坏了）不会让面板崩：`meta.configErrors` 里能看到原因，该键回落默认。

## 5. 界面

- 六类各占一张标签卡（Tab），Tab 上的小圆点 = 该类最差状态（红 > 黄 > 绿）
- 点「刷新」会重新取数；`GET /state?refresh=1` 强制重查 npm 最新版（否则 24h 缓存）；
  `GET /state?refresh=all` 整屏丢缓存重取（排障用，别日常按）
- 颜色：🟢 正常 / 🟡 风险或不可判定 / 🔴 异常（比如 patch insert 的实体缺失）
- 面板底部说明与标题可由配置覆盖（`text.title` / `text.note` / `text.tabs`，服务端经 `meta.ui` 下发）

### 5.1 首屏为什么不转圈（SWR / 周期预热 / 分片取数）

只读面板的首屏有三个常见坏毛病，本版各配一个处方，读数全部落在页脚那一行：

| 坏毛病 | 处方 | 你能看到什么 |
|---|---|---|
| ① 数据过期了就得干等刷新（转圈） | **SWR**：数据块自带 `fetchedAt`，过期判据 = `now - fetchedAt > 阈值`（缺省 **300 s**）；过期时**先把旧值渲染出去**，同时后台刷新，刷回来再替换 | 面板顶部一条「🕗 这是旧值：skills 旧了 320 s（后台正在换新，刷回来自动替换）」；页面不转圈 |
| ② 每次冷启动都从零算（慢） | **周期预热**：可配周期 + 三个环境变量口；**缺省关闭**，开了就先填一遍再按周期续 | 页脚「预热 开 · 300 s · 已跑 N 次」；关掉时页脚写「预热 关」 |
| ③ 某一个源挂了/超时，整页跟着废 | **分片 + 单飞 + 超时预算 + 局部降级**：源清单是参数化的、同一源同一时刻只有一次在途取数、每源一个超时 + 整页一个总预算；坏源**只坏那一格** | 那一格变成「不可探测：超时 / 报错 / 未配置 / 总预算耗尽」，其余照出，整页仍然 200 |

**为什么阈值是 300 s**：复用体系里既有的五分钟节奏，**不新增定时作业** —— 出处是文档仓
《只读监控面板的设计纪律》**§3.2**（见「设计依据」节）。想改就改 `ttlMs`，但别在代码里另写一个数。

**为什么预热缺省关**：预热是"后台常驻"的动作，会替你花资源；默认替你决定不合适。开了以后
缺省只预热**纯本地的五源**（`boot / bundles / inserts / patches / skills`）——
`decoupling / upgrades / registry` 要跑外部脚本或查 npm，不进缺省预热（要就自己在
`DSH_ECOSYSTEM_PANEL_WARMUP_SOURCES` 里点名，或写 `*` 全预热）。

**冷启动不许返回空壳**：没有任何旧值时，这一次**阻塞取真值**，并单独记成 SLI 的 `coldMiss`
（不记的话"命中率"会把冷启动算成命中，读数就废了）。页脚的三桶永远是分开的：
`命中 12（70.6%）· 未命中 3 · 冷启 2`。

**"预热生效"怎么证明**：不是看它跑没跑，而是**关掉它必须看得见冷窗**。夹具
`scripts/test-warmup-negctl.mjs` 就是这条阴性对照，读数形如：

```
场景         首屏耗时   首屏冷启动  源数
预热开         1 ms         0         10
预热关         159 ms       10        10
```

（开 = 全部命中缓存；关 = 首屏自己冷取 10 个源，其中那个 150 ms 的慢源躲不掉。）

**分片是参数化的**：新增数据源 = 在 `lib/state.js` 的源清单里加一条
（`{ id, label, group, deps, timeoutMs, run, describe }`），**装配主流程一行都不用改**；
下游插件也可以在运行时 `registerSource()` 把自己的健康片挂进这块面板（夹具里就是这么验的）。

**页脚 SLI 一行**（`state.sli`）：取数耗时（每源 + 总）· 命中率（命中 / 未命中 / 冷启动分开）·
降级次数（每源）· 预热状态。不做第二套仪表盘。

## 6. 兼容性

| 宿主主包线 | 状态 | 依据 |
|---|---|---|
| **`0.2.0-rc.2`** | ✅ **已端到端实测（2026-10-16）** | **本版 `peerDependencies` 声明的区间基线**：在隔离实例（独立数据根 + 端口 3090）上真装真跑 —— 本仓 `scripts/verify-state.mjs`（只读六类体检）**rc=0 跑通**，读到了该实例的数据根与配置来源；客户端半 `client.js` 出现在实例启动 HTML 的插件资源清单里 |
| `0.2.x` 后续版本 | ⚠️ **未实测，不作承诺**（区间上界 `<0.3.0`） | — |
| `0.1.1-rc.2` / `0.1.5` 线 | ⚠️ 历史静态核对（**本版起 `peerDependencies` 不再声明 0.1.x**） | 见 `v0.4.3` 及之前的本节 |
| ⚠️ 升级体检 / 解耦健康 两卡的**读数** | ⚠️ **未在 0.2.0 实例上校准** | 0.1.5 起客户端资源改成"名册制 + 合并 URL"，两卡是否读全未验证 —— **最可能的表现是读数偏保守，不是崩溃** |
| 其它 | ❓ 未知 | 需自测 |

## 7. 已知限制

1. **js-yaml 依赖宿主提供** —— 解析不到时 ②④ 两类显示「不可解析」（不假绿），但也就查不了了。
2. **boot 清单靠抓宿主首页**的内联 `__DSH_BOOT__` 段 —— 宿主若改了这个投影，① 的"加载状态"就变成未知（黄）。
3. **③ 的判定完全取决于你给的清单**：本仓**不内嵌**任何环境的补丁清单，清单写错就会报错。
4. **⑤ 的颜色不来自本面板**：它来自你配置的档位 CLI（唯一判定源）。本面板只渲染，绝不猜颜色。
5. **⑥⑦ 依赖外部脚本**，本仓不带这些脚本；未配置时对应类目只会显示降级提示。
6. **升级体检会访问 npm registry**（`registry.npmjs.org`），结果缓存 24h；离线时显示"远端查询失败"并继续用缓存。
7. **只读**：面板没有任何写操作入口（唯一写文件的是升级体检自己的缓存）。
8. **前端只支持 web platform**（`dsh.client.inject` 为空，不依赖任何 client 包）。
9. **界面文案为中文**，可通过 `text` 配置覆盖；没有内置多语言切换。
10. **未做移动端专门优化**（面板宽度自适应，但按钮/触摸交互没专门测过）。

## 8. 仓结构

```
lib/index.js          服务端：注册只读 route + 起预热器（route 与预热共用同一条取数车道）
lib/state.js          六类聚合逻辑 + **数据源清单（参数化）** + 首屏装配（每个数据源都走配置层 + 显式降级）
lib/fetch-lane.js     取数车道：TTL 缓存 + SWR / 单飞 / 超时预算 / 局部降级 / SLI 计数
lib/warmup.js         周期预热（缺省关；三个环境变量口；缺省只预热纯本地五源）
lib/upgrade.js        ⑤ 升级体检（本地事实 + npm 缓存 → 外部只读 CLI → 渲染）
lib/config.js         配置层（优先级解析 + 占位符展开 + 来源自证 + 取数策略）
lib/host-protocol.js  宿主协议常量（本插件只用 webServer 一个服务名）
lib/client.js         浏览器端：侧边栏按钮 + 面板 + 旧值提示 + 页脚 SLI（零 import）
cordis.patch.yml      bundle patch（把插件挂到宿主）
scripts/verify-source.mjs  发布前静态验证（语法 + 配置层行为 + 脱敏扫描）
scripts/test-fixture.mjs   干净临时路径上的端到端夹具（含缺数据降级断言）
scripts/test-swr.mjs           夹具①：过期先给旧值 / 冷启动阻塞取真值并记 coldMiss
scripts/test-warmup-negctl.mjs 夹具②：预热阴性对照（关掉预热必须看得见冷窗）
scripts/test-singleflight.mjs  夹具③：并发打同一源 ⇒ 源侧只被调用一次
scripts/test-degrade.mjs       夹具④：坏源只坏那一格、其余照出、总耗时不被拖爆
scripts/sim-selfcheck.mjs      新文件行级同源度自查（< 50% 通过）
scripts/verify-state.mjs   只读状态验证器（不依赖 GUI）
examples/                  五份配置示例
docs/RELEASING.md          发版规范与检查单
```

## 9. 自测

```bash
node scripts/verify-source.mjs .    # 语法 + 配置层行为 + 脱敏扫描（发布前必跑）
node scripts/test-fixture.mjs       # 端到端夹具：不需要任何真实安装，全在临时目录里造
node scripts/test-swr.mjs           # 首屏三件之①：SWR
node scripts/test-warmup-negctl.mjs # 首屏三件之②：预热阴性对照（关掉必须看得见冷窗）
node scripts/test-singleflight.mjs  # 首屏三件之③：单飞
node scripts/test-degrade.mjs       # 首屏三件之③：分片 + 超时预算 + 局部降级
node scripts/sim-selfcheck.mjs --since <commit>   # 新文件行级同源度（< 50% 通过）
node scripts/verify-state.mjs       # 对当前实例只读体检（打印六类 + 配置来源 + 三桶命中率）
# 或者一把梭：
npm run test:all
```

`test-fixture.mjs` 会现场造一个最小数据根（假 profile / 假插件实体 / 假技能 / 四个外部工具 stub），
断言六类都能跑出结果，并专门验证「缺数据必显式降级」。

## 10. 相关组件

同属 DSH 生态的伴生组件，各自独立仓、独立版本、许可各自独立；它们都回链到同一份文档仓
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
（Gitee 镜像 <https://gitee.com/kira905/ops-handoff-design>）：

| 组件仓 | 做什么 | 与本组件的关系 |
|---|---|---|
| `dsh-ecosystem-panel` | 只读生态总览面板 | **本仓** |
| [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) | 会话归档管理（列表 / 预览 / 恢复 / 删除 + 可选自动归档） | 它是**本面板第 ③ 类的观察对象之一**：靠 `cordis.patch.yml` 的 insert 注册，实体缺失时本面板报 🔴 |
| [`dsh-session-title-live`](https://github.com/kira905/dsh-session-title-live) | 会话标题跟着对话实时更新 | 同样靠 `cordis.patch.yml` 的 insert 注册（无 client 半）；「插件到底加载上了没有」由本面板第 ① 类回答 |
| [`dsh-diagnostic-tools`](https://github.com/kira905/dsh-diagnostic-tools) | 诊断取证工具组：依赖闭包体检 + 会话图片附件对账 | 分工互补：本面板回答**「今天怎么样」**（持续、只读、三色），它回答**「具体坏在哪、怎么修」**（离线、可复跑、带修法与回滚清单）——两者都只诊断 |
| [`dsh-task-board-local`](https://github.com/kira905/dsh-task-board-local) | 自维护任务看板（卡片 = 一次真实会话 + 人工验收闸） | 它是本面板**第 ① / ③ 类体检对象的典型**：自研 + 靠 `cordis.patch.yml` 的 insert 注册——插件装载状态与补丁健康这两类静默故障，在本面板上一眼看得到 |
| [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) | 零依赖急救台：起不来 / 假死 / 要撤销改动 / 数据被删四类现场压成一个入口 | 应急预案：**本面板自己也可能是坏掉的那个**（面板要起不来或者数据取不到，你没法用它诊断它），那时换它出场 |

> 组件之间**没有代码依赖**，也不共享运行时 —— 之所以互指，是因为它们回答的是同一类人的同一批问题
> （长期在自有机器上跑 agent：装得下、找得到、看得见、查得清）。谁装谁不装，互不影响。

## 11. 许可

**AGPL-3.0-only + 商业授权**（双许可；见 `LICENSE` 全文；`package.json` 的 `license` 字段为 `AGPL-3.0-only`）。

- ⚠️ **AGPL 本身不禁商用**：你可以自由使用、修改、再分发（含商用），但**通过网络向他人提供本软件的修改版时，必须按 AGPL 一并提供对应源码**；
- 「+ 商业授权」= **双许可**：若需在**闭源**或**商业场景**中使用（AGPL 的传染条款不适用），可另行取得**商业授权** —— 本仓暂无公开联系邮箱，**请通过本仓 Issue 联系**。
