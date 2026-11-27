#!/usr/bin/env node
// check-arch.mjs — 模块边界防回归检查（ADR-0001：docs/adr/0001-module-dependency-rules.md）。
//
// 零依赖：解析相对 import/export 语句建图，断言分层规则。只做边界断言，
// 不做风格检查。CI 与本地均可跑：node scripts/check-arch.mjs（违规 exit 1）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      walk(full, out);
    } else if (/\.(mjs|ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

// 相对 import 提取：static import / dynamic import / export-from
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.[^"']+)["']/g;

function resolveImport(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, join(base, "index.mjs"), join(base, "index.ts")]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch { /* next */ }
  }
  return null;
}

function buildGraph(dir) {
  const files = walk(dir);
  const edges = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(IMPORT_RE)) {
      const target = resolveImport(file, match[1]);
      if (target) edges.push([file, target]);
    }
  }
  return { files: new Set(files), edges };
}

// ---- 规则 -------------------------------------------------------------------

const violations = [];

function rel(p) { return relative(ROOT, p); }

function layerOfServer(file) {
  const r = relative(join(ROOT, "server/src"), file);
  if (r.startsWith("api" + "/")) return "api";
  if (r.startsWith("core" + "/")) return "core";
  return "root"; // index.mjs / version.mjs — 组合根，可依赖一切
}

function categoryOfWeb(file) {
  const r = relative(join(ROOT, "web/src"), file);
  const top = r.split("/")[0];
  return top; // pages | components | contexts | api | i18n | layouts | utils | types | ...
}

// server：core 禁止依赖 api（ADR-0001 §1）
{
  const { files, edges } = buildGraph(join(ROOT, "server/src"));
  for (const [from, to] of edges) {
    if (!files.has(to)) continue;
    if (layerOfServer(from) === "core" && layerOfServer(to) === "api") {
      violations.push(`server: core 不应依赖 api —— ${rel(from)} → ${rel(to)}`);
    }
  }
  // core 内部禁止环（文件级 DFS）
  const coreFiles = [...files].filter((f) => layerOfServer(f) === "core");
  const adj = new Map(coreFiles.map((f) => [f, []]));
  for (const [from, to] of edges) {
    if (adj.has(from) && adj.has(to) && from !== to) adj.get(from).push(to);
  }
  const color = new Map(); // 1=visiting 2=done
  const stack = [];
  function dfs(node) {
    color.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) || []) {
      const c = color.get(next);
      if (c === 1) {
        const cycle = stack.slice(stack.indexOf(next)).concat(next);
        violations.push(`server: core 依赖环 —— ${cycle.map(rel).join(" → ")}`);
      } else if (!c) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, 2);
  }
  for (const f of coreFiles) if (!color.has(f)) dfs(f);
}

// web：pages 互引禁止；components 不碰 pages；contexts 不碰 pages/components（ADR-0001 §2）
{
  const { files, edges } = buildGraph(join(ROOT, "web/src"));
  const FORBIDDEN = {
    pages: { pages: "pages 之间不得互相 import（共享逻辑下沉 components/contexts/utils）" },
    components: { pages: "components 不得 import pages" },
    layouts: { pages: "layouts 不得 import pages" },
    contexts: { pages: "contexts 不得 import pages", components: "contexts 不得 import components" },
  };
  for (const [from, to] of edges) {
    if (!files.has(to)) continue;
    const fromCat = categoryOfWeb(from);
    const toCat = categoryOfWeb(to);
    const why = FORBIDDEN[fromCat]?.[toCat];
    if (why) violations.push(`web: ${why} —— ${rel(from)} → ${rel(to)}`);
  }
}

if (violations.length) {
  process.stderr.write(`✗ 架构边界违规 ${violations.length} 处（见 docs/adr/0001）:\n${violations.map((v) => `  - ${v}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("✓ 架构边界检查通过（server core↛api · 无环 · web 分层）\n");
