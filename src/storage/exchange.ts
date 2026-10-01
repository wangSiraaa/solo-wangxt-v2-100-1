// 笔记导出 / 导入：JSON 文件，保留可编辑的 LaTeX 表达式（重新导入后仍可用 MathLive 编辑）
// v2 起额外保留公式版本号（revision）、已发布结果引用（refs）与最后有效快照（snapshot）。
// 导入到含同名（同 id）公式的笔记本时：
//   - 同批导入内部的引用按重映射后的新 id 重连；
//   - 指向笔记本内既有公式的引用重连到该既有副本；
//   - 仍找不到来源的引用保留为“未解析”（绑定与快照不丢），由分析层标记 blocked。
// 重复导入幂等：同一文件导入两次，第二次仍重新生成 id，不会覆盖或合并已有副本。
import { latexToSource, LatexConvertError } from "../engine/latex";
import type { Formula, RefBinding, ResultSnapshot, VariableDef } from "../engine/types";
import { newId, normalizeFormula } from "./db";

export interface ExportFile {
  app: "dimension-notebook";
  version: 2;
  exportedAt: string;
  formulas: ExportFormula[];
}

export interface ExportFormula {
  id: string;
  /** MathLive LaTeX：可编辑表达式本体 */
  latex: string;
  note: string;
  /** 由 LaTeX 转换出的中缀表达式，便于跨工具查看/备份 */
  source?: string;
  variables: Record<string, VariableDef>;
  targetUnit: string;
  createdAt: number;
  /** 内容版本号；导入后下游引用据此对齐来源版本 */
  revision: number;
  /** 已发布结果引用（含最后一次有效快照） */
  refs: ExportRef[];
}

export interface ExportRef {
  name: string;
  sourceId: string;
  sourceRevision: number;
  snapshot?: ResultSnapshot;
}

export function buildExport(formulas: Formula[]): ExportFile {
  return {
    app: "dimension-notebook",
    version: 2,
    exportedAt: new Date().toISOString(),
    formulas: formulas.map((f) => {
      let source: string | undefined;
      try {
        source = latexToSource(f.latex).source;
      } catch (e) {
        if (e instanceof LatexConvertError) source = undefined;
      }
      const refs: ExportRef[] = f.refs.map((r) => ({
        name: r.name,
        sourceId: r.sourceId,
        sourceRevision: r.sourceRevision,
        snapshot: r.snapshot,
      }));
      return {
        id: f.id, latex: f.latex, note: f.note, source,
        variables: f.variables, targetUnit: f.targetUnit, createdAt: f.createdAt,
        revision: f.revision, refs,
      };
    }),
  };
}

export function downloadJSON(data: ExportFile): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `量纲笔记_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ImportResult {
  formulas: Formula[];
  errors: string[];
  /** 导出 id → 导入后实际 id（便于调用方/测试核对重连情况） */
  idMap: Record<string, string>;
  /** 未解析的引用：[公式实际 id, 派生变量名, 原始来源 id] */
  unresolvedRefs: { formulaId: string; name: string; missingSourceId: string }[];
  /** 重连到笔记本内既有公式副本的引用数 */
  reconnectedExisting: number;
  /** 重连到同批导入其他公式副本的引用数 */
  reconnectedImported: number;
}

/**
 * 解析并校验导入文件。
 * id 冲突自动重新生成，不覆盖现有笔记；引用按 idMap/既有 id 重连，找不到则标记未解析。
 */
export function parseImport(text: string, existingIds: Set<string>): ImportResult {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { formulas: [], errors: ["文件不是合法的 JSON"], idMap: {}, unresolvedRefs: [], reconnectedExisting: 0, reconnectedImported: 0 };
  }
  const obj = raw as Partial<ExportFile>;
  if (!obj || obj.app !== "dimension-notebook" || !Array.isArray(obj.formulas)) {
    return { formulas: [], errors: ["不是本工具导出的笔记文件（缺少 app/formulas 字段）"], idMap: {}, unresolvedRefs: [], reconnectedExisting: 0, reconnectedImported: 0 };
  }

  // 第一遍：为每条记录确定实际 id（冲突时重生成），建立 导出id → 实际id 映射
  const idMap: Record<string, string> = {};
  const planned: { exportId: string; formula: Formula; rawRefs: ExportRef[] }[] = [];

  obj.formulas.forEach((f, i) => {
    const label = `第 ${i + 1} 条`;
    if (!f || typeof f !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
    if (typeof f.latex !== "string") { errors.push(`${label}：缺少 latex 表达式，已跳过`); return; }

    const exportId = typeof f.id === "string" ? f.id : newId();
    // 与既有笔记冲突 → 生成全新副本 id；同批内冲突也重新生成
    let actualId = exportId;
    if (existingIds.has(actualId) || new Set(Object.values(idMap)).has(actualId)) {
      do { actualId = newId(); } while (existingIds.has(actualId) || new Set(Object.values(idMap)).has(actualId));
    }
    idMap[exportId] = actualId;

    const vars: Record<string, VariableDef> = {};
    if (f.variables && typeof f.variables === "object") {
      for (const [k, v] of Object.entries(f.variables as Record<string, unknown>)) {
        const vv = v as Partial<VariableDef>;
        if (vv && typeof vv === "object") {
          vars[k] = { value: String(vv.value ?? ""), unit: String(vv.unit ?? "") };
        }
      }
    }
    const normRefs: ExportRef[] = Array.isArray(f.refs)
      ? f.refs.filter((r) => r && typeof r.name === "string" && typeof r.sourceId === "string")
      : [];

    // 先借用 normalize 规整，再覆盖 id（normalize 要求 id/latex 为字符串）
    const base = normalizeFormula({
      id: actualId,
      latex: f.latex,
      note: f.note,
      variables: vars,
      targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
      createdAt: typeof f.createdAt === "number" ? f.createdAt : Date.now(),
      revision: typeof f.revision === "number" ? f.revision : undefined,
      refs: [],
    })!;
    planned.push({ exportId, formula: base, rawRefs: normRefs });
  });

  // 第二遍：引用重连
  const unresolvedRefs: ImportResult["unresolvedRefs"] = [];
  let reconnectedExisting = 0;
  let reconnectedImported = 0;

  const formulas: Formula[] = planned.map(({ formula, rawRefs }) => {
    const seenNames = new Set<string>();
    const refs: RefBinding[] = [];
    for (const r of rawRefs) {
      if (seenNames.has(r.name)) continue; // 同一变量名重复绑定：保留第一条
      seenNames.add(r.name);

      let targetId: string | undefined;
      if (idMap[r.sourceId]) {
        // 来源在同批导入中：idMap 已处理冲突换 id；即使 id 未变也指向本次导入的副本
        targetId = idMap[r.sourceId];
        reconnectedImported++;
      } else if (existingIds.has(r.sourceId)) {
        // 来源不在导入文件中，但笔记本里已有同名（同 id）公式 → 重连到该正确副本
        targetId = r.sourceId;
        reconnectedExisting++;
      }

      const snap: ResultSnapshot | undefined = r.snapshot && typeof r.snapshot === "object"
        ? {
            value: Number(r.snapshot.value),
            unit: String(r.snapshot.unit ?? ""),
            sourceRevision: Number(r.snapshot.sourceRevision ?? 0),
            capturedAt: Number(r.snapshot.capturedAt ?? 0),
          }
        : undefined;

      if (!targetId) {
        // 明确未解析：保留原始 sourceId 与快照，分析层会把下游置为 blocked
        targetId = r.sourceId;
        unresolvedRefs.push({ formulaId: formula.id, name: r.name, missingSourceId: r.sourceId });
      }

      refs.push({
        name: r.name,
        sourceId: targetId,
        sourceRevision: typeof r.sourceRevision === "number" ? r.sourceRevision : 0,
        snapshot: snap,
      });
    }
    // 未解析引用保留原始 sourceId 与快照（分析层会把下游置为 blocked）。
    return { ...formula, refs };
  });

  return { formulas, errors, idMap, unresolvedRefs, reconnectedExisting, reconnectedImported };
}
