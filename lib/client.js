// dsh-ecosystem-panel / lib/client.js（浏览器端）
// 侧边栏底部「设置」齿轮上方注入图标按钮；点击展开只读生态状态面板。
// 零 import（不 require react / primitives —— rc.2 主包没有拆分包，import 即崩）。
// 姿势：entry.className 复制宿主按钮 className（本按钮复制齿轮按钮），
// self-heal MutationObserver 抗前端重渲染；折叠态规则的选择器**不加前缀**
// （折叠属性挂在 frame div 上而不是 html 根，加前缀会失效）。
window.__ModuleLoader__.load({
	id: "dsh-ecosystem-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region consts
		const ENTRY_ATTR = "data-dsh-ecosystem-entry";
		const ENTRY_SELECTOR = "[" + ENTRY_ATTR + "]";
		const PANEL_ATTR = "data-dsh-ecosystem-panel";
		const API = "/api/dsh-ecosystem-panel/state";
		const inject = [];
		// 面板图标（grid 仪表盘，16px 描边风格，对齐 shell 18px 导航图标视觉）
		const ICON = "<svg viewBox=\"0 0 16 16\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"2\" y=\"2\" width=\"5.2\" height=\"5.2\" rx=\"1\"/><rect x=\"8.8\" y=\"2\" width=\"5.2\" height=\"5.2\" rx=\"1\"/><rect x=\"2\" y=\"8.8\" width=\"5.2\" height=\"5.2\" rx=\"1\"/><rect x=\"8.8\" y=\"8.8\" width=\"5.2\" height=\"5.2\" rx=\"1\"/></svg>";
		const CSS_ID = "dsh-ecosystem-panel-css";
		//#endregion
		//#region css
		const CSS = `
[${ENTRY_ATTR}]{flex:none}
[${ENTRY_ATTR}] .ep-ecosystem-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* svg 裸放时 block 化：消除行内 baseline 造成的视觉偏上（居中问题） */
[${ENTRY_ATTR}] svg{display:block}
/* 折叠态：data-sidebar-collapsed 挂在 AppFrame frame div（非 html！），
   必须无前缀匹配（加 html[...] 前缀会失效、折叠时文字仍然显示） */
[data-sidebar-collapsed] [${ENTRY_ATTR}] .ep-ecosystem-label{display:none}
/* 下区按钮跟「设置」齿轮一样：打开面板不给按钮加高亮（齿轮开设置也无高亮）。
   data-active 属性保留（语义/未来用）但不给视觉，避免出现不居中的选中圈 */
[${PANEL_ATTR}]{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32);backdrop-filter:blur(2px);font-size:14px;line-height:1.5;color:var(--dsw-alias-label-primary,#e6e6e6)}
[${PANEL_ATTR}] .ep-card{box-sizing:border-box;width:min(780px,calc(100vw - 48px));max-height:min(84vh,900px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-3,#1d1f24);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.45);overflow:hidden}
[${PANEL_ATTR}] .ep-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}
[${PANEL_ATTR}] .ep-title{font-size:15px;font-weight:600;flex:1;min-width:0}
[${PANEL_ATTR}] .ep-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
[${PANEL_ATTR}] .ep-btn{appearance:none;cursor:pointer;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16));color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;padding:4px 12px;font:inherit;font-size:13px}
[${PANEL_ATTR}] .ep-btn:hover{background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.28))}
[${PANEL_ATTR}] .ep-tabs{display:flex;gap:2px;padding:8px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));overflow-x:auto;overflow-y:hidden;flex:none}
[${PANEL_ATTR}] .ep-tab{appearance:none;cursor:pointer;background:none;border:none;color:var(--dsw-alias-label-tertiary,#9aa0a8);font:inherit;font-size:12.5px;padding:5px 9px 8px;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;white-space:nowrap;display:flex;align-items:center;gap:5px}
[${PANEL_ATTR}] .ep-tab:hover{color:var(--dsw-alias-label-primary,#e6e6e6);background:rgba(128,128,128,.08)}
[${PANEL_ATTR}] .ep-tab.ep-on{color:var(--dsw-alias-label-primary,#e6e6e6);border-bottom-color:var(--dsw-alias-accent,#5b9dff);font-weight:600}
[${PANEL_ATTR}] .ep-tdot{flex:none;width:6px;height:6px;border-radius:50%}
[${PANEL_ATTR}] .ep-body{overflow:auto;padding:12px 18px 16px}
[${PANEL_ATTR}] .ep-summary{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 10px}
[${PANEL_ATTR}] .ep-chip{font-size:12px;border-radius:999px;padding:2px 10px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14))}
[${PANEL_ATTR}] .ep-group{margin:10px 0 2px;font-size:12px;font-weight:600;letter-spacing:.05em;color:var(--dsw-alias-label-tertiary,#9aa0a8);text-transform:uppercase}
[${PANEL_ATTR}] .ep-row{display:flex;align-items:flex-start;gap:8px;padding:5px 4px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
[${PANEL_ATTR}] .ep-row:last-child{border-bottom:none}
[${PANEL_ATTR}] .ep-dot{flex:none;width:10px;height:10px;border-radius:50%;margin-top:5px}
[${PANEL_ATTR}] .ep-main{flex:1;min-width:0}
[${PANEL_ATTR}] .ep-name{font-weight:500;word-break:break-all}
[${PANEL_ATTR}] .ep-desc{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a8);margin-top:1px}
[${PANEL_ATTR}] .ep-meta{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
[${PANEL_ATTR}] .ep-badge{font-size:10.5px;border-radius:5px;padding:0 6px;margin-left:6px;vertical-align:1px;background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,.18))}
[${PANEL_ATTR}] .ep-prob{font-size:12px;color:var(--dsw-alias-state-warn-primary,#e5b35c);margin-top:2px;word-break:break-all}
[${PANEL_ATTR}] .ep-note{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a8);margin-top:8px}
[${PANEL_ATTR}] .ep-err{color:var(--dsw-alias-label-error,#e06c6c);font-size:13px;padding:10px 0}
.dot-green{background:#3ecf6e}.dot-yellow{background:#e5b35c}.dot-red{background:#e5484d}.dot-unknown{background:#8a8a8a}`;
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]") !== null) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CSS_ID);
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region 侧边栏按钮（self-heal 注入）
		function sidebarRoot() {
			const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
			if (column === null) return void 0;
			return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
		}
		/** 底部「设置」齿轮按钮（trigger）所在容器 + 按钮本身。 */
		function settingsAnchor(root) {
			if (!root) return { area: void 0, button: void 0 };
			const foot = root.querySelector("[class*=\"footArea\"]");
			const holder = foot !== null ? foot : root;
			const area = holder.querySelector("[class*=\"settingsArea\"]");
			if (area === null) return { area: void 0, button: void 0 };
			const button = area.querySelector("button");
			return { area, button };
		}
		function buildEntry(onToggle) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.setAttribute(ENTRY_ATTR, "");
			entry.setAttribute("aria-label", "生态面板（插件·技能状态）");
			entry.setAttribute("title", "生态面板（插件·技能状态）");
			// 图标直接平铺（与齿轮按钮同构：svg 裸放 + label span）——不要给 svg 套 span，
			// 行内 span 会让 svg 走 baseline 对齐，图标在按钮里视觉偏上（实测 logo 会对不准
			// 圆心）。若要 aria-hidden 用 svg 自带属性。
			entry.innerHTML = ICON + "<span class=\"ep-ecosystem-label\">生态面板</span>";
			entry.addEventListener("click", (e) => {
				// 点完立刻 blur：否则 focus 残留，宿主按钮样式会持续画圆形选中标记
				// （实测：面板关了标记还在，要再点一次才消）
				entry.blur();
				onToggle(e);
			});
			return entry;
		}
		/**
		 * 把按钮插到 settingsArea 之前（= 齿轮正上方），视觉完全复制齿轮按钮
		 * className（展开=行按钮带文字，折叠=纯图标小方块——随宿主渲染自愈）。
		 */
		function placeEntry(root, entry, opts) {
			if (root === null || typeof root.isConnected === "boolean" && !root.isConnected) return false;
			const { area, button } = settingsAnchor(root);
			if (button === void 0 || area === void 0) return false;
			entry.className = button.className;
			if (entry.parentElement !== area.parentElement) {
				area.parentElement.insertBefore(entry, area);
			}
			if (opts.onPlaced) opts.onPlaced();
			return true;
		}
		function mountEntry(onToggle, setActive) {
			if (document.querySelector(ENTRY_SELECTOR) !== null) return () => {};
			const entry = buildEntry(onToggle);
			let root = void 0;
			let placed = false;
			let rootObserver = void 0;
			const tryPlace = () => {
				if (root !== void 0 && !root.isConnected) {
					rootObserver?.disconnect();
					root = void 0;
					rootObserver = void 0;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entry)) return;
					rootObserver?.disconnect();
					root = void 0;
					rootObserver = void 0;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === void 0) return;
				if (placeEntry(root, entry, {})) {
					placed = true;
					if (rootObserver === void 0 && typeof MutationObserver !== "undefined") {
						rootObserver = new MutationObserver(() => {
							// shell 重渲染/折叠切换 → 重新对齐 className 与位置
							if (root === void 0 || !root.isConnected) { placed = false; tryPlace(); return; }
							if (!root.contains(entry)) placed = false;
							if (!placed) tryPlace();
							else placeEntry(root, entry, {});
						});
						rootObserver.observe(root, { childList: true, subtree: true });
					}
				}
			};
			const waitObserver = new MutationObserver(() => { tryPlace(); });
			waitObserver.observe(document.body, { childList: true, subtree: true });
			tryPlace();
			return () => {
				waitObserver.disconnect();
				rootObserver?.disconnect();
				entry.remove();
			};
		}
		//#endregion
		//#region 面板
		const MARK = { green: "🟢", yellow: "🟡", red: "🔴" };
		/** 内置中性说明文案（服务端 meta.ui.note 可覆盖；见 lib/config.js 的 text 配置） */
		const DEFAULT_NOTE = "只读总览（静态判定）：bundle 加载看 boot client 条目；服务端 patch insert 插件实体在即绿。补丁健康 = 特征串扫描（清单由配置提供）。升级体检 = 本地实体版本 vs npm latest（24h 缓存）+ 规则表文案；本面板**只诊断不升级**，升级永远由人决定。解耦健康 = 本地包 R1（禁运行时静态 import 宿主主包符号）/ R2（dependencies · client.inject 归零）扫描（脚本路径由配置提供）。🔴 = 静态 import，宿主主包删符号时会启动崩。";
		const KIND_LABEL = {
			bundle: "npm/GitHub 插件", bundles: "npm/GitHub 插件",
			insert: "patch insert", inserts: "patch insert",
			patch: "补丁健康", patches: "补丁健康",
			skill: "技能", skills: "技能",
			decoupling: "解耦健康",
			upgrade: "升级体检", upgrades: "升级体检"
		};
		// 文案可覆盖：服务端 meta.ui.tabs 可整体替换上表（见 lib/config.js 的 text 配置）
		let TAB_LABELS = { ...KIND_LABEL };
		
		/** 应用服务端下发的文案覆盖（没有下发就用内置中性文案） */
		function applyUiText(st, refs) {
			const ui = st && st.meta ? st.meta.ui : null;
			if (!ui || typeof ui !== "object") return;
			if (typeof ui.title === "string" && ui.title) refs.title.textContent = ui.title;
			if (typeof ui.note === "string" && ui.note) refs.note.textContent = ui.note;
			if (ui.tabs && typeof ui.tabs === "object") TAB_LABELS = { ...KIND_LABEL, ...ui.tabs };
		}
		function el(tag, className, text) {
			const node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== void 0) node.textContent = text;
			return node;
		}
		function groupTitle(text) {
			return el("div", "ep-group", text);
		}
		/** 渲染一个 item 行。中文简介：patch 用 title（=中文名）；其余用服务端 description。 */
		function renderRow(item) {
			const row = el("div", "ep-row");
			row.appendChild(el("span", "ep-dot dot-" + item.status));
			const main = el("div", "ep-main");
			const nameLine = el("div");
			const displayName = item.title ?? item.name ?? item.id ?? "(unnamed)";
			const name = el("span", "ep-name", displayName);
			nameLine.appendChild(name);
			if (item.source && !item.title) nameLine.appendChild(el("span", "ep-badge", item.source));
			if (item.isCore) nameLine.appendChild(el("span", "ep-badge", "内置"));
			main.appendChild(nameLine);
			// 一句话中文简介（bundle/insert/skill = description；patch = title 已作名称，附 id 小注）
			if (item.description) main.appendChild(el("div", "ep-desc", item.description));
			const metas = [];
			if (item.kind === "upgrade") {
				if (item.local) metas.push("本地 " + item.local + (item.latest ? " → " + item.latest : ""));
				if (item.verdictLabel) metas.push(item.verdictLabel);
				if (item.patchCount > 0) metas.push("补丁 ×" + item.patchCount);
			}
			if (item.kind === "decoupling") {
				metas.push("R1 静态 " + (item.r1Hard ?? 0) + " · 动态 " + (item.r1Soft ?? 0));
				metas.push("deps " + (item.depCount ?? 0) + " · inject " + (item.injectCount ?? 0));
				if (item.scope) metas.push("范围 " + item.scope);
				if (item.version && item.version !== "n/a") metas.push("v" + item.version);
			}
			if (item.kind === "patch" && item.id) metas.push(item.id);
			if (item.entityVersion) metas.push("实体 v" + item.entityVersion);
			if (item.declared && typeof item.declared === "string") metas.push("声明 " + item.declared);
			if (item.script) metas.push(item.script);
			if (item.bootLoaded === true) metas.push("boot 已加载");
			else if (item.bootLoaded === false) metas.push("boot 无 client 条目");
			if (item.healthy === false) metas.push("特征丢失");
			if (metas.length > 0) main.appendChild(el("div", "ep-meta", metas.join(" · ")));
			for (const p of item.problems ?? []) main.appendChild(el("div", "ep-prob", "⚠ " + p));
			row.appendChild(main);
			return row;
		}
		function appendGroup(container, title, items) {
			if (items.length === 0) return;
			container.appendChild(groupTitle(title));
			for (const it of items) container.appendChild(renderRow(it));
		}
		/** 面板主体。返回 { root, refresh, close } */
		function mountPanel(onDismiss) {
			const overlay = el("div");
			overlay.setAttribute(PANEL_ATTR, "");
			const card = el("div", "ep-card");
			const head = el("div", "ep-head");
			const titleEl = el("div", "ep-title", "插件 · 技能生态状态"); head.appendChild(titleEl);
			const refreshBtn = el("button", "ep-btn", "刷新");
			const closeBtn = el("button", "ep-btn", "关闭");
			head.appendChild(refreshBtn);
			head.appendChild(closeBtn);
			card.appendChild(head);
			const body = el("div", "ep-body");
			card.appendChild(body);
			// Tab 栏：每类各占一张标签卡（内容多了以后全堆一列会很难找）
			const TAB_KEYS = ["bundles", "inserts", "patches", "skills", "decoupling", "upgrades"];
			const tabsRow = el("div", "ep-tabs");
			card.insertBefore(tabsRow, body);
			const tabBtns = {};
			let currentTab = TAB_KEYS[0];
			// 切换 Tab：所有页都已渲染，切 Tab 只切 display（DOM 量级 ~70 行，够轻，不必重渲染）
			function switchTab(key) {
				currentTab = key;
				for (const k of TAB_KEYS) {
					tabBtns[k].classList.toggle("ep-on", k === key);
					groups[k].style.display = k === key ? "" : "none";
				}
			}
			for (const key of TAB_KEYS) {
				const b = el("button", "ep-tab");
				b.type = "button";
				b.addEventListener("click", () => switchTab(key));
				tabBtns[key] = b;
				tabsRow.appendChild(b);
			}
			overlay.appendChild(card);
			// 状态子标题（异步更新）
			const summaryRow = el("div", "ep-summary");
			const errRow = el("div", "ep-err");
			errRow.style.display = "none";
			body.appendChild(summaryRow);
			body.appendChild(errRow);
			// 分组容器：每类一个面板页，由 switchTab 决定显示哪个
			const groups = {};
			for (const key of TAB_KEYS) {
				const g = el("div");
				g.style.display = "none";
				body.appendChild(g);
				groups[key] = g;
			}
			const note = el("div", "ep-note", DEFAULT_NOTE);
			body.appendChild(note);
			let lastState = null;
			const render = (st) => {
				const s = st?.summary;
				summaryRow.replaceChildren();
				if (!s) {
					summaryRow.appendChild(el("span", "ep-chip", "无数据"));
				} else {
					summaryRow.appendChild(el("span", "ep-chip", "🟢 " + s.green + " 正常"));
					summaryRow.appendChild(el("span", "ep-chip", "🟡 " + s.yellow + " 风险"));
					summaryRow.appendChild(el("span", "ep-chip", "🔴 " + s.red + " 异常"));
					summaryRow.appendChild(el("span", "ep-chip", "共 " + s.total + " 项"));
					const boot = st?.meta?.bootEntries;
					const up = st?.upgradesMeta?.summary;
					if (up && up.total > 0) summaryRow.appendChild(el("span", "ep-chip", "升级体检 🟢" + up.green + " 🟡" + up.yellow + " 🔴" + up.red + (up.unknown > 0 ? " ⬜" + up.unknown + "不可用" : "")));
					const dec = st?.decouplingMeta?.summary;
					if (dec && dec.total > 0) summaryRow.appendChild(el("span", "ep-chip", "解耦健康 🟢" + dec.green + " 🟡" + dec.yellow + " 🔴" + dec.red));
					if (typeof boot === "number") summaryRow.appendChild(el("span", "ep-chip", "boot client " + boot + " 个"));
					if (st?.meta?.generatedAt) summaryRow.appendChild(el("span", "ep-chip", "更新于 " + new Date(st.meta.generatedAt).toLocaleTimeString()));
				}
				errRow.style.display = "none";
				for (const key of TAB_KEYS) {
					const list = st?.groups?.[key];
					const n = Array.isArray(list) ? list.length : 0;
					// Tab 按钮：状态点（红>黄>绿）+ 类名 + 计数 —— 哪个类目有问题一眼可见
					const worst = n === 0 ? "" : (list.some((x) => x.status === "red") ? "red" : (list.some((x) => x.status === "yellow") ? "yellow" : "green"));
					const b = tabBtns[key];
					b.replaceChildren();
					if (worst) b.appendChild(el("span", "ep-tdot dot-" + worst));
					b.appendChild(el("span", undefined, TAB_LABELS[key] + (n > 0 ? " " + n : "")));
					// 面板页：照常渲染，显示与否交 switchTab
					const g = groups[key];
					g.replaceChildren();
					if (n > 0) appendGroup(g, TAB_LABELS[key] + "（" + n + "）", list);
				}
				switchTab(currentTab);
			};
			const refresh = async () => {
				refreshBtn.disabled = true;
				refreshBtn.textContent = "刷新中…";
				errRow.style.display = "none";
				try {
					const res = await fetch(API, { cache: "no-store" });
					const data = await res.json();
					if (!res.ok) throw new Error(data?.error ?? ("HTTP " + res.status));
					lastState = data;
					applyUiText(data, { title: titleEl, note }); render(data);
				} catch (e) {
					errRow.textContent = "加载失败：" + (e?.message ?? e);
					errRow.style.display = "";
				} finally {
					refreshBtn.disabled = false;
					refreshBtn.textContent = "刷新";
				}
			};
			/** 统一关闭：移除 overlay + 解绑键盘 + 通知 apply 清面板状态（data-active）。
			 *  2026-09-08 血泪：此前 ×/遮罩/Esc 只 overlay.remove()，apply 的 panel 与
			 *  data-active 不知情 → 关闭后按钮深色圆形选中标记残留，要点第二次按钮才清。 */
			const onKey = (e) => { if (e.key === "Escape") fireClose(); };
			const fireClose = () => {
				document.removeEventListener("keydown", onKey);
				overlay.remove();
				onDismiss?.();
			};
			refreshBtn.addEventListener("click", refresh);
			closeBtn.addEventListener("click", fireClose);
			overlay.addEventListener("click", (e) => { if (e.target === overlay) fireClose(); });
			document.addEventListener("keydown", onKey);
			refresh();
			const cleanup = () => {
				document.removeEventListener("keydown", onKey);
				overlay.remove();
			};
			return { root: overlay, refresh, close: fireClose, cleanup };
		}
		//#endregion
		//#region apply
		function apply(ctx) {
			ctx.effect(() => {
				injectCss();
				let panel = null;          // 当前面板实例（{root, close}）
				let active = false;
				const setActive = (v) => {
					active = v;
					const entry = document.querySelector(ENTRY_SELECTOR);
					if (entry) {
						if (v) entry.setAttribute("data-active", "true");
						else entry.removeAttribute("data-active");
					}
				};
				const onDismiss = () => {
					// 面板任何方式关闭（×/遮罩/Esc/按钮 toggle）都走这里清状态
					panel = null;
					setActive(false);
				};
				const close = () => {
					if (panel === null) return;
					const p = panel;
					p.close();      // fireClose → remove + onDismiss
					onDismiss();    // 保险（fireClose 已调，幂等）
				};
				const open = () => {
					if (panel !== null) return;
					const ui = mountPanel(onDismiss);
					document.body.appendChild(ui.root);
					panel = ui;
					setActive(true);
				};
				const toggle = () => { if (panel !== null) close(); else open(); };
				const disposers = [];
				disposers.push(mountEntry(toggle, setActive));
				return () => {
					for (const d of disposers.splice(0)) { try { d(); } catch {} }
					close();
				};
			}, "ecosystem-panel: ui");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
