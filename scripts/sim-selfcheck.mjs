#!/usr/bin/env node
// scripts/sim-selfcheck.mjs —— 新文件「行级同源度」自查（本仓 K8 的硬约束判据）
//
// 干什么：对本仓**新增**的 .js/.mjs 逐个算「行级同源度」——
//   分子 = 这个新文件里有多少条非空行，能在参照件里找到（多重集扣减，重复行按次数算）
//   分母 = 这个新文件自己的非空行数
//   参照件 = ① 生产源里**同名**的文件（有就算，这是最直接的"近源"判据）
//            ② 本仓既有的**其它** .js/.mjs（本仓既有件本身就是生产件的近源副本 ⇒ 拿它当参照
//               是**更严**的口径：新文件连自家老件都不能像）
//   主结论 = 取所有参照件里最高的那个比值。**< 50% 才算通过**。
//
// 一键跑（示例）：
//   node scripts/sim-selfcheck.mjs --since d069a79          # 自某个 commit 起新增的文件
//   node scripts/sim-selfcheck.mjs --files lib/fetch-lane.js,lib/warmup.js
//   node scripts/sim-selfcheck.mjs --since d069a79 --json   # 机器可读
//
// 为什么不用"逐字节相同"：删几行注释就判"不同源"，会低估同源度 ⇒ 主结论用行级。
// 退出码：0 = 全部 < 50%；1 = 有文件 ≥ 50%（= 这条硬约束没过）；2 = 用法错误。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.argv.includes('--repo')
  ? process.argv[process.argv.indexOf('--repo') + 1]
  : path.join(HERE, '..'));

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const asJson = process.argv.includes('--json');
const since = arg('--since');
const filesArg = arg('--files');
const prodRoot = path.resolve(arg('--prod-root') ?? process.env.DSH_ROOT ?? path.join(os.homedir(), 'DSH'));
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts']);

if (!since && !filesArg) {
  console.error('用法：node scripts/sim-selfcheck.mjs --since <commit> | --files <a.js,b.js> [--repo <dir>] [--prod-root <dir>] [--json]');
  process.exit(2);
}

const kebab = (p) => p.replace(/\\/g, '/');

/** 取新增文件清单（相对仓根） */
function newFiles() {
  if (filesArg) {
    return filesArg.split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(REPO, p));
  }
  const r = spawnSync('git', ['-C', REPO, 'diff', '--name-only', '--diff-filter=A', `${since}..HEAD`, '--', '*.js', '*.mjs', '*.cjs'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('git diff 失败：' + (r.stderr || '').trim());
    process.exit(2);
  }
  return r.stdout.split(/\r?\n/).filter(Boolean).map((p) => path.join(REPO, p));
}

/** 非空行（去掉首尾空白；纯分隔符行不算内容 —— 否则 `}` / `);` 会把同源度凭空抬上去） */
function codeLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[{}()[\];,]+$/.test(l));
}

/** 多重集扣减：返回 ref 里有多少条能在 target 里找到 */
function matchedCount(refLines, targetCounts) {
  const pool = new Map(targetCounts);
  let hit = 0;
  for (const line of refLines) {
    const left = pool.get(line) ?? 0;
    if (left > 0) { pool.set(line, left - 1); hit += 1; }
  }
  return hit;
}

function countsOf(lines) {
  const m = new Map();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '_archive', 'logs', 'backups', 'snapshots', 'generated', '_tmp', 'docs', 'dist']);
/** 受限遍历：生产源只找同名件，所以按 basename 索引即可（跳过重目录） */
function indexByBasename(root, wantedNames) {
  const found = new Map();
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > 7) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push([full, depth + 1]);
      } else if (e.isFile() && wantedNames.has(e.name)) {
        if (!found.has(e.name)) found.set(e.name, []);
        found.get(e.name).push(full);
      }
    }
  }
  return found;
}

const targets = newFiles().filter((f) => fs.existsSync(f) && CODE_EXT.has(path.extname(f)));
if (targets.length === 0) {
  console.error('没有找到新增的代码文件（--since 给的 commit 之后没有新增 .js/.mjs？）');
  process.exit(2);
}

// 参照件：生产源同名件 + 本仓其它已有件
const wanted = new Set(targets.map((f) => path.basename(f)));
const prodIndex = fs.existsSync(prodRoot) ? indexByBasename(prodRoot, wanted) : new Map();
const repoRefs = [];
{
  const stack = [[REPO, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > 5) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', '_archive', '_tmp'].includes(e.name) || e.name.startsWith('.')) continue;
        stack.push([full, depth + 1]);
      } else if (e.isFile() && CODE_EXT.has(path.extname(e.name)) && !targets.includes(full)) {
        repoRefs.push(full);
      }
    }
  }
}

const refLinesCache = new Map();
const linesOf = (p) => {
  if (!refLinesCache.has(p)) refLinesCache.set(p, codeLines(p));
  return refLinesCache.get(p);
};

const results = targets.map((file) => {
  const lines = codeLines(file);
  const own = countsOf(lines);
  const candidates = [];
  for (const p of prodIndex.get(path.basename(file)) ?? []) {
    candidates.push({ file: p, kind: 'prod-same-name', label: kebab(path.relative(prodRoot, p)) });
  }
  for (const p of repoRefs) {
    candidates.push({ file: p, kind: 'repo-existing', label: kebab(path.relative(REPO, p)) });
  }
  let best = { file: null, kind: null, label: '-', ratio: 0, matched: 0 };
  for (const c of candidates) {
    const ref = linesOf(c.file);
    const matched = matchedCount(ref, own);
    const ratio = lines.length === 0 ? 0 : matched / lines.length;
    if (ratio > best.ratio) best = { ...c, ratio, matched };
  }
  return {
    file: kebab(path.relative(REPO, file)),
    lines: lines.length,
    matched: best.matched,
    ratio: Math.round(best.ratio * 1000) / 1000,
    percent: Math.round(best.ratio * 1000) / 10,
    bestRef: best.label,
    bestRefKind: best.kind,
    hasProdSameName: (prodIndex.get(path.basename(file)) ?? []).length > 0,
    pass: best.ratio < 0.5
  };
});

if (asJson) {
  console.log(JSON.stringify({ repo: REPO, prodRoot, caliber: '非空行多重集扣减 / 每文件取最高参照件', results }, null, 2));
} else {
  console.log('同源度自查（行级）：' + kebab(REPO));
  console.log('  口径：分子 = 新文件里能在参照件（生产同名件 ∪ 本仓既有件）找到的非空行数；分母 = 新文件非空行数');
  console.log('  判据：< 50% 通过（新文件不许拿本仓既有近源件当模板）\n');
  const pad = (s, n) => String(s).padEnd(n);
  console.log('  ' + pad('文件', 30) + pad('行数', 7) + pad('同源行', 8) + pad('同源度', 9) + pad('参照', 34) + '结论');
  for (const r of results) {
    console.log('  ' + pad(r.file, 30) + pad(r.lines, 7) + pad(r.matched, 8) + pad(r.percent + '%', 9)
      + pad((r.bestRefKind === 'prod-same-name' ? '[生产同名] ' : '[仓内既有] ') + (r.bestRef ?? '-'), 34)
      + (r.pass ? 'OK' : '🔴 超线'));
  }
  const bad = results.filter((r) => !r.pass);
  console.log('\n  主结论：' + results.length + ' 个新文件，' + (results.length - bad.length) + ' 个 < 50%'
    + (bad.length ? '，' + bad.length + ' 个 ≥ 50%（这条硬约束没过）' : '（全部通过）'));
}

process.exitCode = results.every((r) => r.pass) ? 0 : 1;
