// 笔记导出 / 导入：JSON 文件，保留可编辑的 LaTeX 表达式（重新导入后仍可用 MathLive 编辑）
// v2 起包含公式版本、已发布结果引用与最后有效快照；v1 文件仍可导入（无引用）。
import { latexToSource, LatexConvertError } from "../engine/latex";
import type { Formula, ResultRef, VariableDef } from "../engine/types";
import { newId } from "./db";

export interface ExportFile {
  app: "dimension-notebook";
  version: 2;
  exportedAt: string;
  formulas: ExportFormula[];
}

export interface ExportSnapshot {
  sourceVersion: number;
  sourceNote: string;
  value: number;
  unit: string;
  capturedAt: number;
}

export interface ExportRef {
  alias: string;
  sourceId: string;
  pinnedSourceVersion: number;
  lastSnapshot: ExportSnapshot | null;
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
  refs?: Record<string, ExportRef>;
  version?: number;
  createdAt: number;
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
      return {
        id: f.id, latex: f.latex, note: f.note, source,
        variables: f.variables, targetUnit: f.targetUnit,
        refs: Object.keys(f.refs ?? {}).length ? f.refs : undefined,
        version: f.version,
        createdAt: f.createdAt,
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
  /** 非致命提示：重连/未解析的引用等 */
  notices: string[];
}

function sanitizeSnapshot(raw: unknown): ExportSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<ExportSnapshot>;
  if (typeof s.value !== "number" || !Number.isFinite(s.value)) return null;
  return {
    sourceVersion: typeof s.sourceVersion === "number" ? s.sourceVersion : 1,
    sourceNote: typeof s.sourceNote === "string" ? s.sourceNote : "",
    value: s.value,
    unit: typeof s.unit === "string" ? s.unit : "",
    capturedAt: typeof s.capturedAt === "number" ? s.capturedAt : Date.now(),
  };
}

function sanitizeRef(raw: unknown): ResultRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ExportRef>;
  if (typeof r.alias !== "string" || !r.alias) return null;
  if (typeof r.sourceId !== "string" || !r.sourceId) return null;
  return {
    alias: r.alias,
    sourceId: r.sourceId,
    pinnedSourceVersion: typeof r.pinnedSourceVersion === "number" && r.pinnedSourceVersion > 0 ? r.pinnedSourceVersion : 1,
    lastSnapshot: sanitizeSnapshot(r.lastSnapshot),
  };
}

/**
 * 解析并校验导入文件。
 * - id 冲突（与现有笔记或文件内重复）自动重新生成，不覆盖现有笔记；
 * - 文件内部引用随 id 重映射自动重连到正确副本；
 * - 指向文件外部且在现有笔记本中找不到的引用明确标记为未解析（保留快照，解析阶段进入阻塞）；
 * - 若结构上出现循环（例如手工改过文件），断开成环的引用边并报告，不留半条引用。
 */
export function parseImport(
  text: string,
  existingIds: Set<string>,
  options: { afterCreatedAt?: number } = {},
): ImportResult {
  const errors: string[] = [];
  const notices: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { formulas: [], errors: ["文件不是合法的 JSON"], notices: [] };
  }
  const obj = raw as Partial<ExportFile>;
  if (!obj || obj.app !== "dimension-notebook" || !Array.isArray(obj.formulas)) {
    return { formulas: [], errors: ["不是本工具导出的笔记文件（缺少 app/formulas 字段）"], notices: [] };
  }

  // 导入批次整体排在现有笔记之后（保持文件内相对顺序），避免刷新时与旧公式交错
  const baseCreatedAt = Math.max(Date.now(), (options.afterCreatedAt ?? 0) + 1);

  // 第一遍：记录每条的原始导出 id（含文件内重复检测）与初步公式对象
  const idMap = new Map<string, string>(); // 导出 id → 实际 id
  const rawRefs: { index: number; refs: Record<string, ResultRef> }[] = [];
  const formulas: Formula[] = [];

  obj.formulas.forEach((f, i) => {
    const label = `第 ${i + 1} 条`;
    if (!f || typeof f !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
    if (typeof f.latex !== "string") { errors.push(`${label}：缺少 latex 表达式，已跳过`); return; }

    let id = typeof f.id === "string" ? f.id : newId();
    const exportId = id;
    if (existingIds.has(id) || idMap.has(id)) id = newId();
    idMap.set(exportId, id);

    const vars: Record<string, VariableDef> = {};
    if (f.variables && typeof f.variables === "object") {
      for (const [k, v] of Object.entries(f.variables as Record<string, unknown>)) {
        const vv = v as Partial<VariableDef>;
        if (vv && typeof vv === "object") {
          vars[k] = { value: String(vv.value ?? ""), unit: String(vv.unit ?? "") };
        }
      }
    }

    let refs: Record<string, ResultRef> = {};
    if (f.refs && typeof f.refs === "object") {
      for (const [key, rawRef] of Object.entries(f.refs as Record<string, unknown>)) {
        const r = sanitizeRef(rawRef);
        if (!r) {
          errors.push(`${label}：引用“${key}”字段不完整，已丢弃该引用（公式本身保留）`);
          continue;
        }
        // 记录别名映射（JSON 中别名即 key）
        refs[r.alias] = r;
      }
    }
    rawRefs.push({ index: formulas.length, refs });

    formulas.push({
      id,
      latex: f.latex,
      note: typeof f.note === "string" ? f.note : "",
      variables: vars,
      targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
      refs: {},
      version: typeof f.version === "number" && f.version > 0 ? f.version : 1,
      // 保留批次内相对顺序，同时保证整体位于现有笔记之后（同毫秒重复导入也稳定）
      createdAt: baseCreatedAt + formulas.length,
    });
  });

  // 第二遍：按 idMap 重映射引用；解析不了的外部引用保留（明确标记未解析）
  const unresolved: string[] = [];
  const remapped: string[] = [];
  for (const { index, refs } of rawRefs) {
    const target = formulas[index];
    for (const ref of Object.values(refs)) {
      const mapped = idMap.get(ref.sourceId);
      if (mapped) {
        if (mapped !== ref.sourceId) remapped.push(ref.alias);
        target.refs![ref.alias] = { ...ref, sourceId: mapped };
      } else if (existingIds.has(ref.sourceId)) {
        // 引用指向文件外、但当前笔记本已有同 id 副本：重连
        target.refs![ref.alias] = ref;
      } else {
        // 未解析：保留原始 sourceId 与最后快照，resolveGraph 会给出可解释阻塞
        target.refs![ref.alias] = ref;
        unresolved.push(`${target.note || `导入第 ${index + 1} 条`}的“${ref.alias}”`);
      }
    }
  }

  if (remapped.length) notices.push(`有 ${new Set(remapped).size} 条引用因标识冲突重新生成了 id，已自动重连到导入的正确副本`);
  if (unresolved.length) {
    notices.push(`有 ${unresolved.length} 条引用未解析（来源不在导入文件或当前笔记本中）：${unresolved.join("、")}。已保留最后有效快照仅供历史查看，这些下游公式刷新后将处于“阻塞”状态，不会用旧值冒充当前结果`);
  }

  // 第三遍：防御性循环检查（正常保存路径不会产生循环）。若成环，逐条断开并报告。
  const broken = breakStructuralCycles(formulas);
  for (const b of broken) notices.push(b);

  return { formulas, errors, notices };
}

/** 若导入数据中存在结构环，删除导致成环的引用边（删边是安全操作），返回说明 */
function breakStructuralCycles(formulas: Formula[]): string[] {
  const notices: string[] = [];
  const byId = new Map(formulas.map((f) => [f.id, f]));

  // DFS 三色检测：每条“指向当前递归栈上节点”的边都是回边，删除它
  for (let guard = 0; guard < formulas.length + 1; guard++) {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>(formulas.map((f) => [f.id, WHITE]));
    let broke: { target: string; alias: string } | null = null;

    const dfs = (id: string): boolean => {
      color.set(id, GRAY);
      for (const ref of Object.values(byId.get(id)?.refs ?? {})) {
        if (ref.sourceId === id) { broke = { target: id, alias: ref.alias }; return true; }
        const c = color.get(ref.sourceId);
        if (c === GRAY) { broke = { target: id, alias: ref.alias }; return true; }
        if (c === WHITE && byId.has(ref.sourceId) && dfs(ref.sourceId)) return true;
      }
      color.set(id, BLACK);
      return false;
    };

    let found = false;
    for (const f of formulas) {
      if (color.get(f.id) === WHITE && dfs(f.id)) { found = true; break; }
    }
    if (!found) break;
    const b = broke!;
    const target = byId.get(b.target)!;
    delete target.refs![b.alias];
    notices.push(`导入数据中“${target.note || target.id}”的引用“${b.alias}”构成循环依赖，已断开该引用；请导入后在界面上重新选择来源建立引用`);
  }
  return notices;
}
