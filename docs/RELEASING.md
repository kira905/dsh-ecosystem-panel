# 发版与发布规范（RELEASING）

本仓只发 **Release**（clone 手工装），**不发 npm**。

## 1. 版本号怎么定（SemVer）

判据是**使用者可见的行为**，不是代码改动量。

| 改动类型 | 版本位 | 例子 |
|---|---|---|
| 六类体检的判定口径变化、接口字段增删、必需的新配置项、环境变量改名 | **major** | 把「未配置」从 🟡 改成 🟢（判定语义变了） |
| 新增类目 / 新增可选配置项 / 新增脚本 / 新增面板元素 | **minor** | 加一类体检、加 `disabledGroups` |
| 修 bug、文案、注释、内部重构、性能 | **patch** | boot 抓不到时的颜色修正 |

配置层**新增键**永远是向后兼容的（不设就走默认），可以走 minor。

## 2. 变更记录规范

- 一律写进 `CHANGELOG.md`，按 `Added / Changed / Fixed / Breaking / Security` 分组（没内容的分组不写）。
- 涉及使用者动作的（要改配置、要重命名、要重装）必须在 `Breaking` 里写清**迁移动作**。
- 每条尽量写"为什么"，而不是"改了哪个函数"。

## 3. 发布前检查单（逐条打勾）

1. `node scripts/verify-source.mjs .` → `ALL CHECKS PASSED`（含语法 + 配置层断言 + 脱敏扫描）
2. 脱敏扫描**必须带全注入变量**再跑一遍（未注入时是空判）：
   ```
   DSH 侧示例（发布环境自己给值，别把真实值写进仓）：
     BUILD_MACHINE_NAMES=<主机名列表>
     BUILD_USER_NAMES=<用户名列表>
     BUILD_LAYOUT_ROOTS=<本机关键目录名列表>
     BUILD_SYNC_PRODUCTS=<同步/备份产品目录名列表>
     BUILD_INTERNAL_TERMS=<内部项目代号 / 体系名列表>   ← 形态上枚举不出，只能注入
     BUILD_PERSONAL_TERMS=<私人称呼列表>                 ← 扫描器源码里一个字都不许有
   ```
   注入值为 0 时脚本会明确提示"仅通用形态规则生效"——**不要**把这种运行当成通过。
   ⚠️ 脚本自身的规则表里**不许**出现私人称呼或内部专有名（它会进公开仓）；本脚本末尾有
   自检段：把**注入规则**再跑一遍脚本自身，命中数必须为 0。
3. `node scripts/test-fixture.mjs` → `FIXTURE PASSED`（含「缺数据必显式降级」断言）
4. 在一个**隔离实例**上跑一次 `node scripts/verify-state.mjs --home <隔离数据根> --tools <工具目录>`，
   确认六类都能出结果、降级项都带原因
5. 与上一个版本的判定做等价性比对（同一数据根、同一清单）：**逐条 status 必须零差异**；
   有差异就说明判定逻辑被动过，要么补进 CHANGELOG 的 `Breaking`，要么退回去查
6. `package.json` 的 `version` 与 `CHANGELOG.md` 顶部条目一致；`license` 三处一致
   （`LICENSE` 文件 / `package.json` / `README` §10）
7. `README.md` 的配置表与 `lib/config.js` 里的 `ENV_PREFIX` 键**逐个对照**（加了键必须补表）
8. `examples/` 下所有 JSON 能被 `JSON.parse`（`npm test` 里不含这条，发布前手工过一遍）
9. 公开仓里没有 `node_modules/`、没有生成物、没有日志；`.gitignore` 覆盖这些
10. 提交信息用中性身份（不要带本机用户名与邮箱）

## 4. 发布步骤

1. 打出干净的发布目录（`package.json` 的 `files` 白名单已在位：`lib/` + `cordis.patch.yml` +
   `scripts/` + `examples/` + `docs/` + 三个文档）
2. 建 tag（`vX.Y.Z`）并从该 tag 生成 Release，正文 = `CHANGELOG.md` 对应条目
3. Release 附件里附上本仓目录的归档（若发布渠道支持），或明确写"clone 后按 README §3 装入"
4. 发布后在本机/隔离实例各装一次，跑 `scripts/verify-state.mjs` 复核一次

## 5. 兼容性回归纪律

本插件与宿主只有**一个**耦合点：宿主 web server 的服务名（`lib/host-protocol.js`）。

- 升级宿主主包后，若面板按钮不出现（插件未激活），第一件事看这个服务名是否被改名；
  改名**不用改代码**：设 `DSH_ECOSYSTEM_PANEL_WEBSERVER_SERVICE=<新名>` 即可。
- 其余所有外部依赖（解耦脚本 / 档位 CLI / 跨表校验器 / 适配层一致性校验器）都在**进程边界之外**，
  宿主升级不会连带改变它们的判定；它们各自不可用时本插件只降级、不崩。
- **纪律**：任何一次"升级宿主后判定变化"的排查结论，都要写进 `CHANGELOG.md` 的 `Changed`（口径面）
  或本文件 §3 第 5 条（回归面），别只留在会话里。
