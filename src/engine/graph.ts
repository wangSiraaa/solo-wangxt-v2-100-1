// 已发布结果引用：依赖图、链路重算、阻塞/过期、快照、循环校验
// 纯函数模块，不直接持久化；调用方负责把快照补丁写回 IndexedDB。
// 普通公式（无 refs）的分析路径与单条 analyzeFormula 完全一致，互不影响。

import { create, all, type MathJsInstance, type MathNode } from "mathjs";
import { analyzeFormula } from "./math";
import { latexToSource } from "./latex";
import type { AnalysisResult, ExternalBinding, Formula, PublishedSnapshot, ResultRef } from "./types";

const math: MathJsInstance = create(all);

type AnyNode = MathNode & { isSymbolNode?: boolean; name?: string };

/** 兼容旧数据：补齐 version / refs 字段 */
export function normalizeFormula(f: Formula): Formula {
  return {
    ...f,
    version: typeof f.version === "number" && f.version > 0 ? f.version : 1,
    refs: f.refs ?? {},
  };
}

export function normalizeFormulas(formulas: Formula[]): Formula[] {
  return formulas.map(normalizeFormula);
}

/** 公式在界面中的可追溯名称：公式序号（创建顺序）+ 备注 */
export function formulaLabel(formulas: Formula[], id: string, note?: string): string {
  const idx = formulas.findIndex((f) => f.id === id);
  const n = note ?? formulas.find((f) => f.id === id)?.note ?? "";
  const base = idx >= 0 ? `公式 ${idx + 1}` : "已删除的公式";
  return n.trim() ? `${base}（${n.trim()}）` : base;
}

/** 解析 LaTeX 得到其中真正使用到的变量符号 */
export function usedSymbols(latex: string, aliases?: Set<string>): Set<string> {
  const out = new Set<string>();
  const trimmed = latex.trim();
  if (!trimmed) return out;
  let source: string;
  try {
    source = latexToSource(trimmed, aliases).source;
  } catch {
    return out;
  }
  try {
    const node = math.parse(source) as AnyNode;
    node.traverse((n0) => {
      const n = n0 as AnyNode;
      if (n.isSymbolNode && n.name !== "pi" && n.name !== "e" && n.name !== "PI" && n.name !== "E") {
        out.add(n.name!);
      }
    });
  } catch {
    return out;
  }
  return out;
}

/** 结果是否可发布为引用来源：已验证（ok）且数值有限；量纲明确（无量纲纯数也算） */
export function isPublishable(analysis: AnalysisResult): boolean {
  return analysis.status === "ok" && analysis.value !== undefined && Number.isFinite(analysis.value);
}

// ---------- 依赖图 ----------

/** 结构边：id → 该公式引用的所有来源 id（含尚未在表达式中使用的引用） */
function structuralEdges(formulas: Formula[]): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const f of formulas) {
    edges.set(f.id, Object.values(f.refs ?? {}).map((r) => r.sourceId));
  }
  return edges;
}

/**
 * 在“target 引用 source”这条边成立后，检查是否产生循环。
 * 现有图始终是无环的（建立引用时强制校验），所以只需查 source 沿现有边能否回到 target。
 * 返回完整环路（target → source → … → target），无环返回 null。
 */
export function findCycle(formulas: Formula[], targetId: string, sourceId: string): string[] | null {
  const edges = structuralEdges(formulas);
  // BFS 记录前驱，找到 source → target 的路径
  const prev = new Map<string, string | null>();
  prev.set(sourceId, null);
  const queue = [sourceId];
  let hit = false;
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === targetId) { hit = true; break; }
    for (const next of edges.get(cur) ?? []) {
      if (!prev.has(next)) { prev.set(next, cur); queue.push(next); }
    }
  }
  if (!hit) return null;
  // BFS 树中从 source 到 target 的路径（source 在前）：沿 prev 反向收集再反向前插
  const pathST = [targetId];
  let cur: string | null = targetId;
  while (cur !== sourceId) {
    cur = prev.get(cur) ?? null;
    if (!cur) break;
    pathST.unshift(cur);
  }
  // 完整环路：target → source → … → target（pathST 已以 target 结尾）
  return [targetId, ...pathST];
}

/** 把 id 环路格式化为中文说明（完整环路，箭头首尾一致） */
export function formatCyclePath(formulas: Formula[], cycle: string[]): string {
  return cycle.map((id) => formulaLabel(formulas, id)).join(" → ");
}

// ---------- 引用的建立 / 删除（保存前校验，拒绝半条引用） ----------

const ALIAS_RE = /^[A-Za-zα-ωΑ-Ω][A-Za-z0-9_α-ωΑ-Ω]*$/;
const RESERVED_ALIASES = new Set(["pi", "e", "PI", "E"]);

export interface AddRefInput {
  targetId: string;
  sourceId: string;
  alias: string;
}

export type AddRefResult =
  | { ok: true; formulas: Formula[] }
  | { ok: false; error: string };

/** 建立引用。任何一项校验失败都返回错误且不修改任何公式（原子保存）。 */
export function addReference(formulas: Formula[], input: AddRefInput, at: number = Date.now()): AddRefResult {
  const alias = input.alias.trim();
  const target = formulas.find((f) => f.id === input.targetId);
  const source = formulas.find((f) => f.id === input.sourceId);
  if (!target) return { ok: false, error: "找不到要添加引用的公式" };
  if (!source) return { ok: false, error: "来源公式不存在" };
  if (target.id === source.id) return { ok: false, error: "公式不能引用自身" };
  if (!ALIAS_RE.test(alias) || RESERVED_ALIASES.has(alias)) {
    return { ok: false, error: `引用变量名“${alias}”无效：请使用字母/希腊字母开头，可含数字与下划线（不能是 π、e）` };
  }
  if (target.refs?.[alias]) {
    return { ok: false, error: `本公式已存在同名引用变量“${alias}”，请换一个名字` };
  }
  if (Object.prototype.hasOwnProperty.call(target.variables ?? {}, alias)) {
    return { ok: false, error: `“${alias}”已是手工赋值变量，不能同时作为引用变量` };
  }

  // 来源必须当前已验证、量纲明确（沿其自身引用链解析，支持多级发布）
  const graphNow = resolveGraph(formulas, at);
  const sourceRuntime = graphNow.runtimes.get(source.id);
  if (!sourceRuntime?.published) {
    const sourceAnalysis = sourceRuntime?.analysis;
    const why = !sourceAnalysis || sourceAnalysis.status === "empty" ? "来源公式还是空的"
      : sourceAnalysis.status === "error" ? "来源公式存在错误或其引用被阻塞"
      : "来源公式结果未验证";
    return { ok: false, error: `${why}：只有“已验证”且量纲明确的结果才能被引用` };
  }

  // 循环检查：完整环路必须在保存前指出，且不留半条引用
  const cycle = findCycle(formulas, target.id, source.id);
  if (cycle) {
    return {
      ok: false,
      error: `拒绝建立引用 ${formulaLabel(formulas, target.id)} → ${formulaLabel(formulas, source.id)}：会形成循环依赖：${formatCyclePath(formulas, cycle)}。任何公式均未改动，请先断开环路中的某条引用后重试`,
    };
  }

  const snapshot: PublishedSnapshot = {
    sourceVersion: source.version,
    sourceNote: source.note,
    value: sourceRuntime.published.value,
    unit: sourceRuntime.published.unit,
    capturedAt: at,
  };
  const ref: ResultRef = {
    alias,
    sourceId: source.id,
    pinnedSourceVersion: source.version,
    lastSnapshot: snapshot,
  };

  const next = formulas.map((f) =>
    f.id === target.id
      ? { ...f, refs: { ...(f.refs ?? {}), [alias]: ref }, version: f.version + 1 }
      : f,
  );
  return { ok: true, formulas: next };
}

/** 删除引用（总是安全：只删边，不可能产生循环） */
export function removeReference(formulas: Formula[], targetId: string, alias: string): Formula[] {
  return formulas.map((f) => {
    if (f.id !== targetId || !f.refs?.[alias]) return f;
    const refs = { ...f.refs };
    delete refs[alias];
    return { ...f, refs, version: f.version + 1 };
  });
}

/** 内容编辑后升版本（LaTeX / 变量 / 目标单位变化时）；备注变化不应调用 */
export function bumpVersion(formulas: Formula[], id: string): Formula[] {
  return formulas.map((f) => (f.id === id ? { ...f, version: f.version + 1 } : f));
}

// ---------- 链路解析 / 沿链路重算 ----------

export interface RefState {
  alias: string;
  sourceId: string;
  /** used = 别名当前出现在表达式中；unused 的引用不参与计算、不阻塞 */
  used: boolean;
  status: "ok" | "blocked" | "unused";
  value?: number;
  unit?: string;
  /** 当前绑定的来源版本（ok 时） */
  sourceVersion?: number;
  /** 建立引用时固定的来源版本 */
  pinnedSourceVersion: number;
  /** 阻塞原因（blocked 时） */
  reason?: string;
  /** 最后一次有效快照（blocked 时供历史查看；ok 时即当前值快照） */
  snapshot: PublishedSnapshot | null;
}

export interface FormulaRuntime {
  id: string;
  analysis: AnalysisResult;
  status: AnalysisResult["status"];
  /** 该公式全部引用的当前状态（含未使用的） */
  refs: Record<string, RefState>;
  /** 当前实际造成阻塞的引用（别名 → 状态） */
  blockers: Record<string, RefState>;
  /** 可发布结果（ok 时） */
  published?: { value: number; unit: string; version: number };
}

export interface GraphResult {
  runtimes: Map<string, FormulaRuntime>;
  /** 顺序与入参一致 */
  list: FormulaRuntime[];
  /** 需要持久化的引用快照补丁（仅在快照变化时产生） */
  snapshotPatches: Map<string, Record<string, ResultRef>>;
}

/** 用“使用中”的引用构成依赖边（未在表达式里出现的引用不阻塞计算） */
function usedEdges(formulas: Formula[], used: Map<string, Set<string>>): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const f of formulas) {
    const symbols = used.get(f.id) ?? new Set<string>();
    edges.set(
      f.id,
      Object.values(f.refs ?? {})
        .filter((r) => symbols.has(r.alias))
        .map((r) => r.sourceId),
    );
  }
  return edges;
}

/**
 * 解析整张笔记：按依赖关系分析每条公式。
 * 上游错误/未验证/删除/循环 → 下游绑定 blocked，分析时注入结构化错误，
 * 绝不拿 lastSnapshot 冒充当前结果；快照只在来源 ok 时刷新。
 * 无引用的普通公式走与原来完全相同的分析路径。
 */
export function resolveGraph(rawFormulas: Formula[], at: number = Date.now()): GraphResult {
  const formulas = rawFormulas.map(normalizeFormula);
  const usedMap = new Map<string, Set<string>>();
  for (const f of formulas) {
    usedMap.set(f.id, usedSymbols(f.latex, new Set(Object.keys(f.refs ?? {}))));
  }
  const edges = usedEdges(formulas, usedMap);

  // Kahn 拓扑排序：边 source → target（依赖者），target 必须在其来源之后求值；
  // 处在循环上的节点无法取得零入度，留在 cyclicIds 中。
  const indeg = new Map<string, number>(formulas.map((f) => [f.id, 0]));
  for (const [targetId, deps] of edges) {
    // 仅统计指向存在节点的使用中边
    indeg.set(targetId, deps.filter((d) => usedMap.has(d)).length);
  }
  const queue = formulas.filter((f) => (indeg.get(f.id) ?? 0) === 0).map((f) => f.id);
  const order: string[] = [];
  const enqueued = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (enqueued.has(id)) continue;
    enqueued.add(id);
    order.push(id);
    // id 作为来源：减少所有引用了 id 的公式的入度
    for (const [targetId, deps] of edges) {
      if (enqueued.has(targetId)) continue;
      if (deps.includes(id)) {
        const d = (indeg.get(targetId) ?? 0) - 1;
        indeg.set(targetId, d);
        if (d === 0) queue.push(targetId);
      }
    }
  }
  const cyclicIds = new Set(formulas.map((f) => f.id).filter((id) => !enqueued.has(id)));

  /** 在使用边上找 from → to 的简单路径（用于把循环原因说完整） */
  const findPath = (from: string, to: string): string[] | null => {
    const dfs = (cur: string, seen: Set<string>): string[] | null => {
      if (cur === to) return [cur];
      for (const next of edges.get(cur) ?? []) {
        if (seen.has(next)) continue;
        const sub = dfs(next, new Set(seen).add(next));
        if (sub) return [cur, ...sub];
      }
      return null;
    };
    return dfs(from, new Set([from]));
  };

  const runtimes = new Map<string, FormulaRuntime>();
  const byId = new Map(formulas.map((f) => [f.id, f]));

  const sourceBlockedReason = (srcRt: FormulaRuntime | undefined, srcId: string): string => {
    const label = formulaLabel(formulas, srcId);
    if (!srcRt) {
      return `来源公式已被删除（${label}），引用无法解析；下游已阻塞，不会使用历史快照冒充当前结果`;
    }
    if (Object.keys(srcRt.blockers).length > 0) {
      const first = Object.values(srcRt.blockers)[0];
      return `上游 ${label} 本身被引用“${first.alias}”阻塞（${first.reason}），阻塞沿链路传播`;
    }
    if (srcRt.status === "error") return `上游 ${label} 当前存在计算错误，其结果不可引用，下游已阻塞`;
    if (srcRt.status === "unverified") return `上游 ${label} 当前为“未验证”结果，只有已验证结果可被引用，下游已阻塞`;
    if (srcRt.status === "empty") return `上游 ${label} 当前为空公式，没有可引用的结果，下游已阻塞`;
    return `上游 ${label} 当前不可引用，下游已阻塞`;
  };

  const buildRuntime = (f: Formula): FormulaRuntime => {
    const symbols = usedMap.get(f.id) ?? new Set<string>();
    const refs: Record<string, RefState> = {};
    const blockers: Record<string, RefState> = {};
    const externals: ExternalBinding[] = [];
    const isCyclicNode = cyclicIds.has(f.id);

    for (const ref of Object.values(f.refs ?? {})) {
      const used = symbols.has(ref.alias);
      const baseState: RefState = {
        alias: ref.alias,
        sourceId: ref.sourceId,
        used,
        status: "unused",
        pinnedSourceVersion: ref.pinnedSourceVersion,
        snapshot: ref.lastSnapshot,
      };

      if (!used) {
        refs[ref.alias] = baseState;
        continue;
      }

      const srcRt = runtimes.get(ref.sourceId);
      let state: RefState;
      if (isCyclicNode) {
        // 处于循环上的公式：给出完整环路（f → source → … → f）
        const back = findPath(ref.sourceId, f.id);
        const cyc = [f.id, ...(back ?? [ref.sourceId])];
        state = {
          ...baseState,
          status: "blocked",
          reason: `引用形成循环依赖：${formatCyclePath(formulas, cyc)}，循环无法求值，已阻塞`,
        };
      } else if (!srcRt || !srcRt.published) {
        state = { ...baseState, status: "blocked", reason: sourceBlockedReason(srcRt, ref.sourceId) };
      } else {
        state = {
          ...baseState,
          status: "ok",
          value: srcRt.published.value,
          unit: srcRt.published.unit,
          sourceVersion: srcRt.published.version,
        };
      }
      refs[ref.alias] = state;
      if (state.status === "blocked") blockers[ref.alias] = state;
      externals.push({
        alias: ref.alias,
        status: state.status === "unused" ? "blocked" : state.status,
        value: state.value,
        unit: state.unit,
        reason: state.reason,
        sourceId: ref.sourceId,
        sourceVersion: state.sourceVersion,
        pinnedSourceVersion: ref.pinnedSourceVersion,
        snapshot: ref.lastSnapshot,
      });
    }

    const analysis = analyzeFormula(f.latex, f.variables, f.targetUnit, externals);
    const rt: FormulaRuntime = {
      id: f.id,
      analysis,
      status: analysis.status,
      refs,
      blockers,
    };
    if (isPublishable(analysis)) {
      rt.published = { value: analysis.value!, unit: analysis.resultUnit ?? "", version: f.version };
    }
    return rt;
  };

  // 拓扑顺序求值：普通无依赖公式也按统一路径分析，结果与单条 analyzeFormula 一致
  for (const id of order) runtimes.set(id, buildRuntime(byId.get(id)!));
  // 循环上的节点最后处理（它们的依赖一定拿不到 published，全部阻塞）
  for (const f of formulas) if (cyclicIds.has(f.id)) runtimes.set(f.id, buildRuntime(f));

  // 快照补丁：数值/单位/来源版本变化时刷新（含新抓取时间）；仅来源备注变化时只更新备注
  const snapshotPatches = new Map<string, Record<string, ResultRef>>();
  for (const f of formulas) {
    const rt = runtimes.get(f.id)!;
    let changed = false;
    const patched: Record<string, ResultRef> = {};
    for (const ref of Object.values(f.refs ?? {})) {
      const st = rt.refs[ref.alias];
      let next = ref;
      if (st?.status === "ok" && st.value !== undefined) {
        const old = ref.lastSnapshot;
        const sourceNote = byId.get(ref.sourceId)?.note ?? "";
        const valueChanged = !old
          || old.sourceVersion !== (st.sourceVersion ?? 0)
          || old.value !== st.value
          || old.unit !== (st.unit ?? "");
        if (valueChanged) {
          next = {
            ...ref,
            lastSnapshot: {
              sourceVersion: st.sourceVersion!,
              sourceNote,
              value: st.value,
              unit: st.unit ?? "",
              capturedAt: at,
            },
          };
          changed = true;
        } else if (old!.sourceNote !== sourceNote) {
          next = { ...ref, lastSnapshot: { ...old!, sourceNote } };
          changed = true;
        }
      }
      patched[ref.alias] = next;
    }
    if (changed) snapshotPatches.set(f.id, patched);
  }

  return { runtimes, list: formulas.map((f) => runtimes.get(f.id)!), snapshotPatches };
}
