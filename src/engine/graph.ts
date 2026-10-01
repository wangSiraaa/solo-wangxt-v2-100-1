// 引用依赖图与整笔记级分析：
// - 维护 “下游公式 → 它引用的来源公式” 依赖图
// - 保存前循环检测：返回完整环路，拒绝任何会成环的引用（不留下半条引用）
// - 拓扑顺序沿链路逐层重新计算；上游错误/未验证/删除/未解析 → 下游进入 blocked，绝不拿旧值冒充
// - 维护每个引用绑定的 sourceRevision 对齐与最后一次有效快照
// 普通公式（refs 为空）的分析路径与原来完全一致，彼此独立。

import { analyzeFormula } from "./math";
import type {
  AnalysisResult, Formula, RefBinding, RefTraceEntry,
} from "./types";

/** 一条公式在一次整笔记分析中的结果 */
export interface NotebookEntry {
  formula: Formula;
  result: AnalysisResult;
  /** 该公式作为“引用来源”时可发布的值；只有已验证（status === "ok"）才可被引用。
   *  revision 为本轮分析的“有效版本号”：当来源沿链变化时会在存储版本之上虚拟 +1，
   *  保证同一轮拓扑计算里深层下游能立即看到变化。 */
  published?: { value: number; unit: string; revision: number };
  /** 每个引用绑定的可追溯状态（原式/代入式/问题列表之外的溯源信息） */
  traces: RefTraceEntry[];
  /** 来源沿链发生变化：调用方（持久化层）应把存储的 revision 递增一次（每轮仅一次） */
  revisionBump: boolean;
}

export interface NotebookAnalysis {
  /** 按公式输入顺序排列 */
  entries: NotebookEntry[];
  byId: Map<string, NotebookEntry>;
}

/** 图中的循环：完整环路（首尾相同），如 ["A","B","A"] */
export type Cycle = string[];

/** 构造下游 → 上游集合的邻接表（只包含图内存在的公式） */
export function dependencyGraph(formulas: Formula[]): Map<string, Set<string>> {
  const ids = new Set(formulas.map((f) => f.id));
  const g = new Map<string, Set<string>>();
  for (const f of formulas) {
    const deps = new Set<string>();
    for (const r of f.refs) if (ids.has(r.sourceId)) deps.add(r.sourceId);
    g.set(f.id, deps);
  }
  return g;
}

/** 该公式直接引用了哪些来源 id */
export function directDependencies(formula: Formula): string[] {
  return [...new Set(formula.refs.map((r) => r.sourceId))];
}

/**
 * 检测在 `formulas` 上“把 downstreamId 的引用改成 nextRefs”是否会产生环。
 * 返回所有完整环路（首尾 id 相同）；无环返回 []。
 * 使用暂存视图，不修改任何既有公式——保存前校验失败时任何公式都不被改写。
 */
export function findCycles(
  formulas: Formula[],
  downstreamId: string,
  nextRefs: Pick<RefBinding, "sourceId">[],
): Cycle[] {
  const byId = new Map(formulas.map((f) => [f.id, f]));
  const depsOf = (id: string): string[] => {
    if (id === downstreamId) return [...new Set(nextRefs.map((r) => r.sourceId))];
    return [...new Set(byId.get(id)?.refs.map((r) => r.sourceId) ?? [])];
  };

  const cycles: Cycle[] = [];
  const seenCycle = new Set<string>();
  const register = (stack: string[], backTo: string) => {
    const at = stack.indexOf(backTo);
    const ring = stack.slice(at);
    // 以最小 id 为起点旋转归一化，去重同一条环
    const minIdx = ring.reduce((mi, v, i) => (v < ring[mi] ? i : mi), 0);
    const norm = ring.map((_, i) => ring[(minIdx + i) % ring.length]);
    const key = norm.join("→");
    if (!seenCycle.has(key)) {
      seenCycle.add(key);
      cycles.push([...norm, norm[0]]);
    }
  };

  // 任何新环必然经过被改动的公式：只从它出发做 DFS
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const dfs = (id: string) => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of depsOf(id)) {
      if (!byId.has(dep)) continue; // 指向已删除/未解析来源不是环
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) register(stack, dep);
      else if (c === WHITE) dfs(dep);
    }
    stack.pop();
    color.set(id, BLACK);
  };
  dfs(downstreamId);
  return cycles;
}

/** 把环路渲染成教师可读文本，如 “#1（速度） → #2（换算） → #1（速度）” */
export function formatCycle(cycles: Cycle[], labelOf: (id: string) => string): string {
  return cycles.map((c) => c.map((id) => labelOf(id)).join(" → ")).join("；");
}

/** 合法派生变量名：字母/希腊字母开头，可含数字与下划线（如 v、v_in、θ_1） */
const REF_NAME_RE = /^[A-Za-zα-ωΑ-Ω][A-Za-z0-9_α-ωΑ-Ω]*$/;
const RESERVED_NAMES = new Set(["pi", "e", "PI", "E"]);

export interface RefValidation {
  ok: boolean;
  errors: string[];
  cycles: Cycle[];
}

/**
 * 保存前校验“把 downstream 的引用整体替换为 nextRefs”：
 * 名称合法且不重复、来源存在且不是自己、不产生任何环。
 * 校验完全基于暂存数据，不修改任何公式——失败时不会留下半条引用。
 */
export function validateRefs(
  formulas: Formula[],
  downstreamId: string,
  nextRefs: RefBinding[],
): RefValidation {
  const errors: string[] = [];
  const ids = new Set(formulas.map((f) => f.id));
  const nameCount = new Map<string, number>();

  nextRefs.forEach((r) => {
    nameCount.set(r.name, (nameCount.get(r.name) ?? 0) + 1);
    if (!REF_NAME_RE.test(r.name)) {
      errors.push(`派生变量名“${r.name}”不合法：需以字母或希腊字母开头，只能含字母、数字、下划线`);
    } else if (RESERVED_NAMES.has(r.name)) {
      errors.push(`派生变量名“${r.name}”是内置常量（π/e），请换一个名字`);
    }
    if (!ids.has(r.sourceId)) {
      errors.push(`派生变量 ${r.name} 的来源公式不存在（可能已被删除），引用无法建立`);
    }
  });
  for (const [name, n] of nameCount) {
    if (n > 1) errors.push(`派生变量名“${name}”在本公式中重复使用，请保证每个引用变量名唯一`);
  }

  const cycles = findCycles(formulas, downstreamId, nextRefs);
  if (cycles.length) {
    errors.push(`会形成循环引用：${cycles.map((c) => c.join(" → ")).join("；")}。引用未保存，两条公式均未改写。`);
  }
  return { ok: errors.length === 0, errors, cycles };
}

// ---------- 拓扑分层 ----------

/** Kahn 拓扑排序：返回有序层；相互成环（含自环）的公式进入 cyclic 集合 */
function topoLayers(formulas: Formula[]): { order: string[]; cyclic: Set<string> } {
  const ids = new Set(formulas.map((f) => f.id));
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const f of formulas) {
    const ds = new Set<string>();
    for (const r of f.refs) if (ids.has(r.sourceId) && r.sourceId !== f.id) ds.add(r.sourceId);
    deps.set(f.id, ds);
    for (const d of ds) {
      if (!dependents.has(d)) dependents.set(d, new Set());
      dependents.get(d)!.add(f.id);
    }
  }
  const indegree = new Map<string, number>();
  for (const f of formulas) indegree.set(f.id, deps.get(f.id)!.size);

  const order: string[] = [];
  let frontier = formulas.filter((f) => (indegree.get(f.id) ?? 0) === 0).map((f) => f.id);
  while (frontier.length) {
    order.push(...frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dn of dependents.get(id) ?? []) {
        indegree.set(dn, (indegree.get(dn) ?? 1) - 1);
        if (indegree.get(dn) === 0) next.push(dn);
      }
    }
    frontier = next;
  }
  const cyclic = new Set<string>();
  for (const f of formulas) if (!order.includes(f.id)) cyclic.add(f.id);
  return { order, cyclic };
}

// ---------- 快照与绑定维护 ----------

/** live 引用对齐来源版本号并刷新快照；blocked 引用原样保留最后快照。
 *  返回新 refs（无变化时为原数组）以及是否有“已对齐过的来源发生版本变化”
 *  （调用方据此对本公式做一次版本递增，向更深下游传播） */
function syncBindings(
  formula: Formula,
  traces: RefTraceEntry[],
  now: number,
): { refs: RefBinding[]; upstreamChanged: boolean } {
  let changed = false;
  let upstreamChanged = false;
  const refs = formula.refs.map((b) => {
    const tr = traces.find((t) => t.name === b.name);
    if (tr?.state === "live" && tr.value !== undefined && tr.unit !== undefined && tr.sourceRevision !== undefined) {
      const sameSnap = b.snapshot
        && b.snapshot.value === tr.value
        && b.snapshot.unit === tr.unit
        && b.snapshot.sourceRevision === tr.sourceRevision;
      // 已对齐过的来源（sourceRevision 非 0）发生版本变化 → 沿链路向上传播
      if (b.sourceRevision !== 0 && b.sourceRevision !== tr.sourceRevision) upstreamChanged = true;
      if (b.sourceRevision !== tr.sourceRevision || !sameSnap) {
        changed = true;
        return {
          ...b,
          sourceRevision: tr.sourceRevision,
          snapshot: { value: tr.value, unit: tr.unit, sourceRevision: tr.sourceRevision, capturedAt: now },
        };
      }
    }
    return b;
  });
  return { refs: changed ? refs : formula.refs, upstreamChanged };
}

const snapshotText = (s: RefTraceEntry["snapshot"]): string =>
  s
    ? `最后一次有效值（仅供历史查看，未参与本次计算）：${numText(s.value)} ${s.unit || "（无量纲）"}，来源版本 v${s.sourceRevision}`
    : "从无有效快照";

const numText = (n: number): string => {
  if (!Number.isFinite(n)) return String(n);
  return String(n);
};

// ---------- 整笔记分析入口 ----------

/**
 * 沿引用依赖图重新计算整本笔记。
 * @param formulas 当前公式列表（revision 由调用方在内容变更时维护）
 * @param labelOf 公式 id → 展示标签（含序号/备注），用于问题列表与溯源文案
 * @param now 注入时间，便于测试
 */
export function analyzeNotebook(
  formulas: Formula[],
  labelOf: (id: string) => string = (id) => id,
  now: number = Date.now(),
): NotebookAnalysis {
  const byId = new Map(formulas.map((f) => [f.id, f]));
  const { order, cyclic } = topoLayers(formulas);
  const entries = new Map<string, NotebookEntry>();

  const analyzeOne = (f: Formula): NotebookEntry => {
    const inCycle = cyclic.has(f.id);

    // 基础分析（无派生变量注入）：只为拿到表达式中实际出现的变量集合
    const base = analyzeFormula(f.latex, f.variables, f.targetUnit);
    const usedNames = new Set(base.variables);

    const traces: RefTraceEntry[] = [];
    const liveDerived: Record<string, { value: string; unit: string }> = {};
    const liveSet = new Set<string>();
    const blockedMessages: Record<string, string> = {};

    const label = (sourceId: string) =>
      byId.has(sourceId) ? labelOf(sourceId) : "（已删除/未找到的来源）";

    for (const b of f.refs) {
      const used = usedNames.has(b.name);
      const upstream = entries.get(b.sourceId);
      let trace: RefTraceEntry;

      if (inCycle && used) {
        const msg =
          `派生变量 ${b.name} 位于循环引用环中：循环引用无法确定计算顺序，已停止使用该值（不会用旧值冒充）。${snapshotText(b.snapshot)}`;
        blockedMessages[b.name] = msg;
        trace = {
          name: b.name, sourceId: b.sourceId, sourceLabel: label(b.sourceId),
          state: "blocked", reasonCode: "circular", reason: msg, snapshot: b.snapshot,
        };
      } else if (!byId.has(b.sourceId)) {
        const msg =
          `派生变量 ${b.name} 引用的来源公式已被删除或在导入后未能解析（来源 id：${b.sourceId}），当前没有可用结果。${snapshotText(b.snapshot)}`;
        if (used) blockedMessages[b.name] = msg;
        trace = {
          name: b.name, sourceId: b.sourceId, sourceLabel: label(b.sourceId),
          state: used ? "blocked" : "unused", reasonCode: "missing", reason: msg, snapshot: b.snapshot,
        };
      } else if (!upstream || !upstream.published) {
        const st = upstream?.result.status;
        const stText = st === "error" ? "存在错误"
          : st === "unverified" ? "结果未验证"
          : st === "blocked" ? "其上游被阻塞"
          : st === "empty" ? "还是空公式"
          : "当前不是已验证状态";
        const msg =
          `派生变量 ${b.name} 的来源 ${label(b.sourceId)} ${stText}。引用只能使用“已验证且量纲明确”的结果，请先修复来源公式。${snapshotText(b.snapshot)}`;
        if (used) blockedMessages[b.name] = msg;
        trace = {
          name: b.name, sourceId: b.sourceId, sourceLabel: label(b.sourceId),
          state: used ? "blocked" : "unused", reasonCode: "upstream-status", reason: msg, snapshot: b.snapshot,
        };
      } else {
        const pub0 = upstream.published;
        const stale = b.sourceRevision !== 0 && b.sourceRevision !== pub0.revision;
        trace = {
          name: b.name, sourceId: b.sourceId, sourceLabel: label(b.sourceId),
          state: used ? "live" : "unused", sourceRevision: pub0.revision,
          value: pub0.value, unit: pub0.unit, snapshot: b.snapshot,
          reason: stale
            ? `来源已更新（版本 v${b.sourceRevision} → v${pub0.revision}），本结果已沿链路重新计算。`
            : undefined,
        };
        if (used) {
          liveDerived[b.name] = { value: numText(pub0.value), unit: pub0.unit };
          liveSet.add(b.name);
        }
      }
      traces.push(trace);
    }

    // 正式分析：注入 live 派生变量与 blocked 说明，由引擎完成求值/量纲检查/染色
    const result = analyzeFormula(f.latex, f.variables, f.targetUnit, {
      derived: liveDerived,
      liveDerived: liveSet,
      blockedMessages,
    });

    // unused 绑定也保留在 traces 中（state 已在上面置为 unused）
    // 沿链路传播：只有“此前已对齐、来源版本随后变化”才需要传播性升版；
    // 新建引用（sourceRevision 0→N）的版本递增已由用户编辑触发，不在这里重复。
    const synced = syncBindings(f, traces, now);
    const revisionBump = synced.upstreamChanged;
    const effectiveRevision = revisionBump ? f.revision + 1 : f.revision;
    let published: NotebookEntry["published"];
    if (result.status === "ok" && result.value !== undefined) {
      published = { value: result.value, unit: result.resultUnit ?? "", revision: effectiveRevision };
    }

    // entry.formula 保留存储版本（不在这里直接改写 revision，避免与 UI 的内容版本递增叠加）
    const entry: NotebookEntry = {
      formula: synced.refs !== f.refs ? { ...f, refs: synced.refs } : f,
      result, published, traces, revisionBump,
    };
    return entry;
  };

  // 非环节点按拓扑顺序计算；环上节点最后统一按 blocked 处理
  for (const id of order) entries.set(id, analyzeOne(byId.get(id)!));
  for (const f of formulas) if (cyclic.has(f.id)) entries.set(f.id, analyzeOne(f));

  return {
    entries: formulas.map((f) => entries.get(f.id)!),
    byId: entries,
  };
}
