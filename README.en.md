# dsh-ecosystem-panel

> **Status**: published on npm as `@kira905/dsh-ecosystem-panel` (repository Releases remain available)
> **Repository**: <https://github.com/kira905/dsh-ecosystem-panel> ｜ <https://gitee.com/kira905/dsh-ecosystem-panel>
> **License**: AGPL-3.0-only — see [`LICENSE`](./LICENSE)
> **中文**: [README.md](./README.md)

> A **read-only** ecosystem overview panel for a DSH instance: did the plugins load, are the patches
> still in place, is any skill frontmatter broken, do the dependencies carry an upgrade risk — all on
> one screen, in three colours (green / yellow / red).
>
> It **only diagnoses, it never acts**: it installs nothing, removes nothing, upgrades nothing,
> changes no configuration, and writes to none of the objects it inspects.

A new icon button appears in the sidebar above the settings gear; clicking it opens the panel.
The server side exposes exactly one read-only endpoint:

```
GET /api/dsh-ecosystem-panel/state
```

## Design basis

This component is one implementation of the operational system described in
[ops-handoff-design](https://github.com/kira905/ops-handoff-design), with the design basis
(the fixed four questions that documentation repository defines):

- **Why it exists and where its boundary is** → see *Design Discipline for a Read-Only Monitoring Panel* **§1 the questions the panel must answer**, **§2 display discipline (not probeable + reason)**; this component's six checks are one landing of that discipline
- **Its compatibility window with the host** → see *Multi-machine Handoff and Cloud Relay* **§4.5 "compatibility requirements"** (see also §6 "Compatibility" in this README)
- **This component's own pitfalls and measurements** → the "Known limitations" section of this README; see also *Design Discipline for a Read-Only Monitoring Panel* **§7 summary of design lessons** (where the three cases of "silently not reporting" came from)
- **Documentation repository** → Gitee (mirror) <https://gitee.com/kira905/ops-handoff-design>
  ｜ GitHub (primary) <https://github.com/kira905/ops-handoff-design>
  (the documentation repository's component index points back to this repository; the two repositories link to each other and version independently)

> Design documents carry no concrete repository addresses (a hard-coded address becomes a dead link);
> the implementation list is kept in the documentation repository's component index — this repository
> only links back to the sections.

---

## 1. What it looks at (six classes plus one optional one)

| Class | Data source | Judgement | When data is missing |
|---|---|---|---|
| ① **bundle plugins** | the profile's `package.json` (`dsh.profile.bundles` + `dependencies`) + each package entity's `package.json` + the boot manifest of the host home page | whether the entity exists / whether the declared version drifts from the entity version / client capability declared but not loaded in boot = red | boot cannot be fetched ⇒ shows "load state unknown" (yellow), **not treated as loaded** |
| ② **patch insert plugins** | the `insert` entries in the profile's `cordis.patch.yml` | whether the entity directory can be resolved (profile layer → shared fallback layer); entries under `disabled` are marked yellow | the YAML parser is unavailable ⇒ says "not parseable" explicitly instead of treating it as an empty list |
| ③ **patch health** | **the patch manifest you supply** (an external JSON) | a marker-string scan, entry by entry: a missing `contains` = a customisation was overwritten (yellow); the target file is gone = red; a `notContains` hit = leftovers | the manifest is not configured ⇒ shows "not configured ⇒ cannot be judged" (yellow), **never "0 patches"** |
| ④ **skills** | the frontmatter of `skills/*/SKILL.md` under the data root | missing `name` / `description`, frontmatter parse failure | the directory does not exist ⇒ reports `skillsDirOk=false` |
| ⑤ **upgrade check** | local entity versions + the latest npm registry version (24 h file cache) + the wording of your rule table | the colour is decided by an **external read-only CLI**; this panel only renders it (when that is unavailable it shows "tier unavailable" + the reason, and **never guesses a colour**) | no CLI configured ⇒ `unknown` on every row + the reason |
| ⑥ **decoupling health** | **the external check script you supply** (reused by dynamic `import` of its exported function — the judgement is not copied) | R1 static import of a host symbol = red; dynamic import / dependencies not driven to zero = yellow | no script configured ⇒ one yellow row + configuration guidance |
| ⑦ **cross-table admission consistency** (optional) | **the external validator you supply** | three states, explicitly enumerated: `ok / fail / unavailable`; a missing `asOf` is judged `unavailable` | not configured ⇒ `unavailable` (**not** a green 0/0/0) |

**Design red line (throughout the repository)**: anything that cannot be read is shown as "not probeable + reason" — **never 0, never a pretend all-green**.
The panel meta also carries a **self-attestation of configuration provenance** (which layer each configuration key was actually read from: CLI / environment variable / config file / auto-detection / built-in default). Look at it first when troubleshooting on a different machine.

## 2. Prerequisites

- A DSH instance (web profile); for the host package line see the compatibility table in §6
- Node ≥ 18.17 (it uses the built-in `fetch` / `AbortSignal.timeout`)
- **A YAML parser (`js-yaml`)**: provided by the host profile's dependency chain (normally shipped with the host package). When it cannot be resolved, classes ② and ④ say "not parseable" explicitly; the other four are unaffected
- The optional three or four external scripts (decoupling check, tier CLI, cross-table validator, adapter-layer consistency checker) — **it runs without them**; the corresponding classes degrade. This repository does not ship these scripts (they belong to your own check system)

## 3. Installing in three steps

```bash
# 1. Install it into the profile (npm package name: @kira905/dsh-ecosystem-panel)
npm install @kira905/dsh-ecosystem-panel --prefix "<data root>/profiles/web"
#   offline / editing the source: clone this repository to
#   "<data root>/profiles/web/node_modules/@kira905/dsh-ecosystem-panel"

# 2. Register it in the profile's package.json:
#      "dependencies": add  "@kira905/dsh-ecosystem-panel": "0.4.4"
#      "dsh.profile.bundles": add "@kira905/dsh-ecosystem-panel" to the array

# 3. Restart DSH (this plugin has no hot reload), then open the GUI: the panel button should appear
#    above the settings gear in the sidebar
```

Verification (no GUI needed):

```bash
node "<data root>/profiles/web/node_modules/@kira905/dsh-ecosystem-panel/scripts/verify-state.mjs"
# the terminal should print the six classes plus the configuration-provenance self-attestation
```

> The package is published on npm (`@kira905/dsh-ecosystem-panel`): `npm install` only fetches the
> package itself (`dependencies` is empty; `js-yaml` comes from the host profile). Earlier releases
> shipped Releases only; this version (`0.4.4`) is the first to ship under the scoped npm name.

## 4. Configuration

Precedence (**per key, independently**): `explicit input (plugin config / call argument)` > `environment variable` > `config file` > `auto-detection` > `built-in default`.

### 4.1 Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `DSH_ECOSYSTEM_PANEL_HOME` | DSH data root | `os.homedir()/.dsh` (`DSH_HOME` has the same effect, at lower precedence) |
| `DSH_ECOSYSTEM_PANEL_PROFILE` | profile name | `web` |
| `DSH_ECOSYSTEM_PANEL_WEB_URL` | base URL of this instance (used to fetch the boot manifest) | `DSH_WEB_URL`, otherwise `http://127.0.0.1:3080` |
| `DSH_ECOSYSTEM_PANEL_TOOLS_DIR` | external tools directory (**never auto-detected**) | empty ⇒ the classes that depend on it degrade |
| `DSH_ECOSYSTEM_PANEL_MAIN_NM` | host package `node_modules` | detected from the global npm layout; unusable when detection fails |
| `DSH_ECOSYSTEM_PANEL_CONFIG` | path to the JSON configuration file | empty |
| `DSH_ECOSYSTEM_PANEL_CACHE_FILE` | upgrade-check cache file | `<data root>/ecosystem-panel-upgrade-cache.json` |
| `DSH_ECOSYSTEM_PANEL_DECOUPLING_SCRIPT` | decoupling check script | `<toolsDir>/check-decoupling.mjs` |
| `DSH_ECOSYSTEM_PANEL_TRIAGE_CLI` | read-only upgrade tier CLI | `<toolsDir>/upgrade-triage-cli.mjs` |
| `DSH_ECOSYSTEM_PANEL_REGISTRY_AUDIT_LIB` | cross-table admission validator | `<toolsDir>/registry-audit.mjs` |
| `DSH_ECOSYSTEM_PANEL_HOST_ADAPTER_SYNC` | adapter-layer consistency checker (optional) | `<toolsDir>/sync-host-adapter.mjs` |
| `DSH_ECOSYSTEM_PANEL_PATCH_MANIFEST_FILE` | patch manifest JSON | empty ⇒ ③ shows "not configured" |
| `DSH_ECOSYSTEM_PANEL_UPGRADE_RULES_FILE` | upgrade rule table JSON | empty |
| `DSH_ECOSYSTEM_PANEL_BREAKING_SYMBOLS_FILE` | breaking-symbol table JSON | empty |
| `DSH_ECOSYSTEM_PANEL_LABELS_FILE` | package name → one-line description, JSON | empty (an unregistered package simply has no description) |
| `DSH_ECOSYSTEM_PANEL_DISABLED_GROUPS` | classes disabled as a whole (comma-separated) | all enabled |
| `DSH_ECOSYSTEM_PANEL_WEBSERVER_SERVICE` | host web server service name | `webServer` |

### 4.2 Configuration file and examples

`examples/` holds five samples you can copy directly:

| File | Configuration it covers |
|---|---|
| `ecosystem-panel.config.example.json` | overview (where each key lives and what shape it takes) |
| `patch-manifest.example.json` | ③ patch manifest (all three shapes — `checks` / `special` / `retired` — have examples; `${HOME}` can be used as a placeholder inside strings) |
| `upgrade-rules.example.json` | ⑤ rule-table wording (`verdict` is only a wording category, it does not decide the colour) |
| `breaking-symbols.example.json` | reference table of breaking symbols in the host package |
| `labels.example.json` | package name → one-line description |

Usage:

```bash
DSH_ECOSYSTEM_PANEL_CONFIG=/path/to/my.config.json   # points at the copy you edited
```

### 4.3 Degradation semantics (important)

- **Not configured ≠ absent**: with no manifest configured, ③ shows "not configured ⇒ cannot be judged" and never "0 patches, all green"; ⑥⑦ and ⑤ work the same way (each carries configuration guidance).
- **Cannot be fetched**: when the boot manifest cannot be fetched from the host home page, ① marks only the "unknown" as yellow and puts the raw fetch error into `meta.bootError`.
- **Disabled**: if a class is genuinely not needed, put it into `disabledGroups` — the panel then shows a "disabled by configuration" notice (clearer than silently disappearing, and not counted in the summary).
- A configuration parse failure (a broken manifest JSON, say) does not crash the panel: `meta.configErrors` carries the reason and that key falls back to its default.

## 5. Interface

- Each of the six classes has its own tab; the small dot on a tab = the worst state of that class (red > yellow > green)
- Clicking "refresh" fetches the data again; `GET /state?refresh=1` forces a fresh lookup of the npm latest version (otherwise the 24 h cache is used)
- Colours: green = healthy / yellow = at risk or not judgeable / red = abnormal (a missing patch insert entity, for instance)
- The panel's title and footer note can be overridden by configuration (`text.title` / `text.note` / `text.tabs`, delivered by the server through `meta.ui`)

## 6. Compatibility

| Host package line | Status | Basis |
|---|---|---|
| **`0.2.0-rc.2`** | ✅ **Measured end-to-end (2026-10-16)** | **The baseline of the range this version declares in `peerDependencies`**: installed and exercised for real on an isolated instance (separate data root + port 3090) — `scripts/verify-state.mjs` (read-only, six check classes) **completed with rc=0**, reading that instance's data root and configuration provenance; the client half `client.js` appears in the plugin resource list of the instance's startup HTML |
| later `0.2.x` | ⚠️ **Not measured; no promise** (declared upper bound `<0.3.0`) | — |
| the `0.1.1-rc.2` / `0.1.5` lines | ⚠️ Historical static check (**this version no longer declares a 0.1.x range**) | see this section in `v0.4.3` and earlier |
| the **readings** of the upgrade-check / decoupling-health cards | ⚠️ **Not calibrated on a 0.2.0 instance** | Since 0.1.5, client resources use a "roster + merged URL" scheme; whether these two cards read it completely is unverified — **the most likely symptom is conservative readings, not a crash** |
| other | Unknown | self-test required |

## 7. Known limitations

1. **`js-yaml` is provided by the host** — when it cannot be resolved, classes ② and ④ show "not parseable" (no false green), but that also means they cannot be checked.
2. **The boot manifest is fetched from the host home page**, from the inline `__DSH_BOOT__` block — if the host changes that projection, ①'s "load state" becomes unknown (yellow).
3. **③'s verdict depends entirely on the manifest you supply**: this repository **embeds no patch manifest** for any environment, so a wrong manifest produces wrong reports.
4. **⑤'s colour does not come from this panel**: it comes from the tier CLI you configure (the single source of judgement). The panel only renders it and never guesses a colour.
5. **⑥⑦ depend on external scripts**, which this repository does not ship; when they are not configured the corresponding classes only show a degradation notice.
6. **The upgrade check reaches the npm registry** (`registry.npmjs.org`) and caches its result for 24 h; when offline it shows "remote lookup failed" and keeps using the cache.
7. **Read-only**: the panel has no write entry point at all (the only file it writes is the upgrade check's own cache).
8. **The front end supports the web platform only** (`dsh.client.inject` is empty; it depends on no client package).
9. **The interface copy is Chinese**, overridable through the `text` configuration; there is no built-in language switch.
10. **No dedicated mobile optimisation** (the panel width adapts, but buttons and touch interaction have not been tested specifically).

## 8. Repository layout

```
lib/index.js          server side: registers the read-only route
lib/state.js          the six-class aggregation logic (every data source goes through the config layer and degrades explicitly)
lib/upgrade.js        ⑤ the upgrade check (local facts + npm cache → external read-only CLI → rendering)
lib/config.js         the config layer (precedence resolution + placeholder expansion + provenance self-attestation)
lib/host-protocol.js  host protocol constants (this plugin uses only the single service name webServer)
lib/client.js         browser side: sidebar button + panel (zero imports)
cordis.patch.yml      bundle patch (mounts the plugin into the host)
scripts/verify-source.mjs   pre-release static verification (syntax + config-layer behaviour + sanitization scan)
scripts/test-fixture.mjs    end-to-end fixture on a clean temporary path (with assertions for degradation on missing data)
scripts/verify-state.mjs    read-only state verifier (no GUI needed)
examples/                   five configuration examples
docs/RELEASING.md           release conventions and checklist
```

## 9. Self-checks

```bash
node scripts/verify-source.mjs .    # syntax + config-layer behaviour + sanitization scan (must be run before a release)
node scripts/test-fixture.mjs       # end-to-end fixture: needs no real installation, everything is built in a temporary directory
node scripts/verify-state.mjs       # read-only health check of the current instance (prints the six classes + configuration provenance)
```

`test-fixture.mjs` builds a minimal data root on the spot (a fake profile / fake plugin entities / fake skills / four external tool stubs), asserts that all six classes produce a result, and specifically verifies that "missing data always degrades explicitly".

## 10. Related components

Sibling components in the same DSH ecosystem — separate repositories, separate versions and separate licenses. They all link back to the same documentation repository,
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
(Gitee mirror: <https://gitee.com/kira905/ops-handoff-design>):

| Repository | What it does | How it relates to this one |
|---|---|---|
| `dsh-ecosystem-panel` | Read-only ecosystem overview panel | **this repo** |
| [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) | Session archiving (list / preview / restore / delete, plus optional auto-archive) | It is **one of the objects class ③ observes**: it registers through an `insert` in `cordis.patch.yml`, and this panel reports red when its entity is missing |
| [`dsh-session-title-live`](https://github.com/kira905/dsh-session-title-live) | Session titles that track the conversation live | It also registers through an `insert` in `cordis.patch.yml` (no client half); "did the plugin actually load" is answered by class ① of this panel |
| [`dsh-diagnostic-tools`](https://github.com/kira905/dsh-diagnostic-tools) | Diagnostic forensics toolkit: dependency-closure check + session image attachment reconciliation | Complementary division of labour: this panel answers **"how is it today"** (continuous, read-only, three colours) while that one answers **"what exactly is broken, and how do I fix it"** (offline, re-runnable, with fixes and a rollback list) — both only diagnose |
| [`dsh-task-board-local`](https://github.com/kira905/dsh-task-board-local) | Self-maintained task board (a card = a real session + a human acceptance gate) | It is a **typical subject of classes ① / ③**: built in-house and registered through an `insert` in `cordis.patch.yml` — the two silent failure modes, plugin load state and patch health, are visible at a glance on this panel |
| [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) | Zero-dependency incident toolkit: will not start / hangs / a change to undo / deleted data — four on-site scenarios behind one entry point | The contingency plan: **this panel may itself be the broken one** (if the panel will not start, or cannot fetch its data, you cannot use it to diagnose itself), and that is when the other one takes over |

> There are **no code dependencies** between the components and they share no runtime — they point at each other because they answer the same class of question for the same kind of person (running an agent on your own machine over the long term: install it, find it, see it, diagnose it). Installing one does not affect the others.

## 11. License

**AGPL-3.0-only plus a commercial license** (dual licensing; see the full text in `LICENSE`; the `license` field in `package.json` carries `AGPL-3.0-only`).

- ⚠️ **The AGPL does not forbid commercial use by itself**: you may use, modify and redistribute it freely (commercial use included), but **if you make a modified version available to others over a network, you must offer the corresponding source under the AGPL as well**;
- "+ a commercial license" = **dual licensing**: obtain a **commercial license** if you need it in a **closed-source** or **commercial** setting (where AGPL's copyleft obligations do not apply) — there is no public contact address yet, so **please reach out by opening an issue**.
