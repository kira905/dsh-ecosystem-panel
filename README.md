# dsh-ecosystem-panel

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

## 2. 前置条件

- 一个 DSH 实例（web profile），主包线见 §6 兼容性表
- Node ≥ 18.17（用到了内置 `fetch` / `AbortSignal.timeout`）
- **YAML 解析器（`js-yaml`）**：由宿主 profile 的依赖链提供（通常随主包自带）。解析不到时 ②④
  两类会显式显示「不可解析」，其它四类不受影响
- 可选的三个/四个外部脚本（解耦检查、档位 CLI、跨表校验器、适配层一致性校验器）——**没有也能跑**，
  对应类目会降级；本仓不附带这些脚本（它们属于你自己的体检体系）

## 3. 安装三步

```bash
# ① 把包放进 profile 的 node_modules（本仓 clone 到任意位置后拷进去，或直接 clone 到该目录）
#    <数据根>/profiles/<profile>/node_modules/dsh-ecosystem-panel/
git clone <本仓地址> "<数据根>/profiles/web/node_modules/dsh-ecosystem-panel"

# ② 注册：profile 的 package.json 里
#      "dependencies": 加一条  "dsh-ecosystem-panel": "0.4.0"
#      "dsh.profile.bundles": 数组里加 "dsh-ecosystem-panel"

# ③ 重启 DSH（本插件没有热加载），然后打开 GUI：侧边栏齿轮上方应出现面板按钮
```

验证（不依赖 GUI）：

```bash
node "<数据根>/profiles/web/node_modules/dsh-ecosystem-panel/scripts/verify-state.mjs"
# 终端里应打印六类结果 + 配置来源自证
```

> 本仓**只发 Release，不发 npm**：把目录放进 profile 即可，不需要 `npm install`（`dependencies` 为空）。

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
- 点「刷新」会重新取数；`GET /state?refresh=1` 强制重查 npm 最新版（否则 24h 缓存）
- 颜色：🟢 正常 / 🟡 风险或不可判定 / 🔴 异常（比如 patch insert 的实体缺失）
- 面板底部说明与标题可由配置覆盖（`text.title` / `text.note` / `text.tabs`，服务端经 `meta.ui` 下发）

## 6. 兼容性

| 宿主主包线 | 状态 | 依据 |
|---|---|---|
| `0.1.1-rc.2` | ✅ 已实测 | 同源代码在一个**隔离实例**（独立数据根 + 独立端口）上只读核对通过；另与带内嵌清单的旧版逐条比对判定一致（51 条零差异） |
| `0.1.5` 线（静态核对 `0.1.5-rc.1` / `0.1.5-rc.2`，2026-09-21） | ✅ **宿主面单一且已取证** | 唯一宿主符号是服务名 `webServer`（0.1.5 仍在，且可用 `DSH_ECOSYSTEM_PANEL_WEBSERVER_SERVICE` 覆盖）；客户端半**零 require**（不依赖任何包）。静态审计报告：见 2026-09-21 的《兼容性静态审计》 |
| ⚠️ 升级体检 / 解耦健康 两卡的**读数** | ⚠️ **未在 0.1.5 实例上校准** | 0.1.5 把客户端资源改成"名册制 + 合并 URL"（`dsh-client-modules`、`cordis.patch.yml` 68 条名册），两卡是否读全未验证 —— **最可能的表现是读数偏保守，不是崩溃** |
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
lib/index.js          服务端：注册只读 route
lib/state.js          六类聚合逻辑（每个数据源都走配置层 + 显式降级）
lib/upgrade.js        ⑤ 升级体检（本地事实 + npm 缓存 → 外部只读 CLI → 渲染）
lib/config.js         配置层（优先级解析 + 占位符展开 + 来源自证）
lib/host-protocol.js  宿主协议常量（本插件只用 webServer 一个服务名）
lib/client.js         浏览器端：侧边栏按钮 + 面板（零 import）
cordis.patch.yml      bundle patch（把插件挂到宿主）
scripts/verify-source.mjs  发布前静态验证（语法 + 配置层行为 + 脱敏扫描）
scripts/test-fixture.mjs   干净临时路径上的端到端夹具（含缺数据降级断言）
scripts/verify-state.mjs   只读状态验证器（不依赖 GUI）
examples/                  五份配置示例
docs/RELEASING.md          发版规范与检查单
```

## 9. 自测

```bash
node scripts/verify-source.mjs .    # 语法 + 配置层行为 + 脱敏扫描（发布前必跑）
node scripts/test-fixture.mjs       # 端到端夹具：不需要任何真实安装，全在临时目录里造
node scripts/verify-state.mjs       # 对当前实例只读体检（打印六类 + 配置来源）
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

**AGPL-3.0-only**（见 `LICENSE` 全文；`package.json` 的 `license` 字段同值）。
以 AGPL 发布意味着：你可以自由使用、修改、再分发，但**通过网络向他人提供本软件的修改版时，
必须按 AGPL 一并提供对应源码**。
