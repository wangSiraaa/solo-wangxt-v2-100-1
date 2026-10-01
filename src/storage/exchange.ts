// 笔记导出 / 导入：JSON 文件，保留可编辑的 LaTeX 表达式（重新导入后仍可用 MathLive 编辑）
import { latexToSource, LatexConvertError } from "../engine/latex";
import type { Formula, VariableDef } from "../engine/types";
import { newId } from "./db";

export interface ExportFile {
  app: "dimension-notebook";
  version: 1;
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
}

export function buildExport(formulas: Formula[]): ExportFile {
  return {
    app: "dimension-notebook",
    version: 1,
    exportedAt: new Date().toISOString(),
    formulas: formulas.map((f) => {
      let source: string | undefined;
      try {
        source = latexToSource(f.latex).source;
      } catch (e) {
        if (e instanceof LatexConvertError) source = undefined;
      }
      return {
        id: f.id, latex: f.latex, note: f.note, source,
        variables: f.variables, targetUnit: f.targetUnit, createdAt: f.createdAt,
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
}

/** 解析并校验导入文件；id 冲突自动重新生成，不覆盖现有笔记 */
export function parseImport(text: string, existingIds: Set<string>): ImportResult {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { formulas: [], errors: ["文件不是合法的 JSON"] };
  }
  const obj = raw as Partial<ExportFile>;
  if (!obj || obj.app !== "dimension-notebook" || !Array.isArray(obj.formulas)) {
    return { formulas: [], errors: ["不是本工具导出的笔记文件（缺少 app/formulas 字段）"] };
  }

  const formulas: Formula[] = [];
  obj.formulas.forEach((f, i) => {
    const label = `第 ${i + 1} 条`;
    if (!f || typeof f !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
    if (typeof f.latex !== "string") { errors.push(`${label}：缺少 latex 表达式，已跳过`); return; }

    let id = typeof f.id === "string" ? f.id : newId();
    if (existingIds.has(id)) id = newId();
    const vars: Record<string, VariableDef> = {};
    if (f.variables && typeof f.variables === "object") {
      for (const [k, v] of Object.entries(f.variables as Record<string, unknown>)) {
        const vv = v as Partial<VariableDef>;
        if (vv && typeof vv === "object") {
          vars[k] = { value: String(vv.value ?? ""), unit: String(vv.unit ?? "") };
        }
      }
    }
    formulas.push({
      id,
      latex: f.latex,
      note: typeof f.note === "string" ? f.note : "",
      variables: vars,
      targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
      createdAt: typeof f.createdAt === "number" ? f.createdAt : Date.now(),
    });
  });

  return { formulas, errors };
}
