import { describe, it, expect } from "vitest";
import { buildExport, parseImport } from "./exchange";
import { analyzeFormula } from "../engine/math";
import { resolveGraph } from "../engine/graph";
import type { Formula } from "../engine/types";
import { newId } from "./db";

const f = (p: Partial<Formula> = {}): Formula => ({
  id: newId(),
  latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
  note: "n",
  variables: { v: { value: "2", unit: "m/s" }, t: { value: "3", unit: "s" }, a: { value: "4", unit: "m/s^2" } },
  targetUnit: "m",
  version: 1,
  refs: {},
  createdAt: 1,
  ...p,
});

describe("导出 / 导入", () => {
  it("导出保留可编辑 LaTeX 与变量赋值", () => {
    const data = buildExport([f()]);
    expect(data.app).toBe("dimension-notebook");
    expect(data.formulas[0].latex).toContain("\\frac");
    expect(data.formulas[0].source).toContain("v");
    expect(data.formulas[0].variables.a.unit).toBe("m/s^2");
  });

  it("导入后公式可重新分析，结果一致", () => {
    const original = f();
    const before = analyzeFormula(original.latex, original.variables, original.targetUnit);
    const text = JSON.stringify(buildExport([original]));
    const { formulas, errors } = parseImport(text, new Set());
    expect(errors).toEqual([]);
    expect(formulas).toHaveLength(1);
    const after = analyzeFormula(formulas[0].latex, formulas[0].variables, formulas[0].targetUnit);
    expect(after.status).toBe(before.status);
    expect(after.value).toBe(before.value);
    // LaTeX 原样保留，可再次用 MathLive 编辑
    expect(formulas[0].latex).toBe(original.latex);
  });

  it("id 冲突时重新生成，不覆盖现有笔记", () => {
    const original = f();
    const text = JSON.stringify(buildExport([original]));
    const { formulas } = parseImport(text, new Set([original.id]));
    expect(formulas[0].id).not.toBe(original.id);
  });

  it("非法文件给出错误", () => {
    expect(parseImport("not json", new Set()).errors.length).toBeGreaterThan(0);
    expect(parseImport(JSON.stringify({ app: "x" }), new Set()).errors.length).toBeGreaterThan(0);
  });

  it("缺少字段的记录被跳过并报错", () => {
    const text = JSON.stringify({ app: "dimension-notebook", version: 1, formulas: [{ note: "no latex" }] });
    const r = parseImport(text, new Set());
    expect(r.formulas).toHaveLength(0);
    expect(r.errors.length).toBe(1);
  });
});

describe("引用 / 版本 / 快照的导出导入", () => {
  const mk = (p: Partial<Formula> = {}): Formula => ({
    id: newId(),
    latex: "x",
    note: "",
    variables: {},
    targetUnit: "",
    refs: {},
    version: 1,
    createdAt: 1,
    ...p,
  });

  it("导出包含版本、引用与最后有效快照", () => {
    const up = mk({ latex: "x", note: "上游", variables: { x: { value: "100", unit: "m" } }, version: 3 });
    const down = mk({
      latex: "L_ref", note: "下游", version: 2,
      refs: {
        L_ref: {
          alias: "L_ref", sourceId: up.id, pinnedSourceVersion: 2,
          lastSnapshot: { sourceVersion: 3, sourceNote: "上游", value: 100, unit: "m", capturedAt: 42 },
        },
      },
    });
    const data = buildExport([up, down]);
    expect(data.version).toBe(2);
    expect(data.formulas[1].version).toBe(2);
    expect(data.formulas[1].refs!.L_ref.sourceId).toBe(up.id);
    expect(data.formulas[1].refs!.L_ref.lastSnapshot!.value).toBe(100);
  });

  it("往返导入后引用重连到正确副本，状态与来源版本一致", () => {
    const up = mk({ latex: "x", note: "上游", variables: { x: { value: "100", unit: "m" } }, version: 3 });
    const down = mk({
      latex: "L_ref", note: "下游", version: 2,
      refs: {
        L_ref: {
          alias: "L_ref", sourceId: up.id, pinnedSourceVersion: 1,
          lastSnapshot: { sourceVersion: 3, sourceNote: "上游", value: 100, unit: "m", capturedAt: 42 },
        },
      },
    });
    const text = JSON.stringify(buildExport([up, down]));
    const r = parseImport(text, new Set());
    expect(r.errors).toEqual([]);
    expect(r.notices).toEqual([]);
    const [impUp, impDown] = r.formulas;
    expect(impDown.refs!.L_ref.sourceId).toBe(impUp.id);
    expect(impDown.refs!.L_ref.lastSnapshot!.sourceVersion).toBe(3);
    // 刷新（重新解析依赖图）后状态仍为已验证、取来源最新版本
    const g = resolveGraph(r.formulas);
    const rt = g.runtimes.get(impDown.id)!;
    expect(rt.status).toBe("ok");
    expect(rt.refs.L_ref.status).toBe("ok");
    expect(rt.refs.L_ref.sourceVersion).toBe(3);
    expect(rt.refs.L_ref.value).toBeCloseTo(100, 10);
    expect(rt.refs.L_ref.unit).toBe("m");
  });

  it("导入到已有同 id 公式的笔记本：id 冲突重生成，文件内引用自动重连到正确副本", () => {
    const up = mk({ latex: "x", note: "文件内上游", variables: { x: { value: "5", unit: "s" } } });
    const down = mk({
      latex: "t_r", note: "文件内下游",
      refs: { t_r: { alias: "t_r", sourceId: up.id, pinnedSourceVersion: 1, lastSnapshot: { sourceVersion: 1, sourceNote: "", value: 5, unit: "s", capturedAt: 1 } } },
    });
    const text = JSON.stringify(buildExport([up, down]));
    // 笔记本里已有同 id 的“别的”公式（同名标识冲突）
    const existing = new Set([up.id, down.id]);
    const r = parseImport(text, existing);
    expect(r.formulas).toHaveLength(2);
    const [impUp, impDown] = r.formulas;
    expect(impUp.id).not.toBe(up.id);
    expect(impDown.id).not.toBe(down.id);
    // 引用重连到导入的新副本，而不是误连到同名旧公式
    expect(impDown.refs!.t_r.sourceId).toBe(impUp.id);
    expect(r.notices.join("；")).toContain("重连");
    const g = resolveGraph(r.formulas);
    expect(g.runtimes.get(impDown.id)!.status).toBe("ok");
  });

  it("引用指向文件外且笔记本中没有来源：明确未解析，保留快照，刷新后进入阻塞", () => {
    const ghostId = newId();
    const down = mk({
      latex: "u", note: "下游",
      refs: { u: { alias: "u", sourceId: ghostId, pinnedSourceVersion: 1, lastSnapshot: { sourceVersion: 1, sourceNote: "旧上游", value: 9, unit: "m", capturedAt: 1 } } },
    });
    const text = JSON.stringify(buildExport([down]));
    const r = parseImport(text, new Set());
    expect(r.formulas).toHaveLength(1);
    const impDown = r.formulas[0];
    // 未解析：sourceId 原样保留、快照保留
    expect(impDown.refs!.u.sourceId).toBe(ghostId);
    expect(impDown.refs!.u.lastSnapshot!.value).toBe(9);
    expect(r.notices.join("")).toContain("未解析");
    const g = resolveGraph(r.formulas);
    const rt = g.runtimes.get(impDown.id)!;
    expect(rt.status).toBe("error");
    expect(rt.blockers.u.reason).toContain("删除");
    // 绝不拿旧值冒充
    expect(rt.published).toBeUndefined();
    // 历史快照仍可查看
    expect(rt.refs.u.snapshot!.value).toBe(9);
    expect(rt.refs.u.snapshot!.sourceNote).toBe("旧上游");
  });

  it("重复导入：两条副本都能独立解析，互不串线", () => {
    const up = mk({ latex: "x", variables: { x: { value: "1", unit: "m" } } });
    const down = mk({
      latex: "u",
      refs: { u: { alias: "u", sourceId: up.id, pinnedSourceVersion: 1, lastSnapshot: { sourceVersion: 1, sourceNote: "", value: 1, unit: "m", capturedAt: 1 } } },
    });
    const text = JSON.stringify(buildExport([up, down]));
    const first = parseImport(text, new Set());
    const ids = new Set(first.formulas.map((f) => f.id));
    const second = parseImport(text, ids);
    expect(second.formulas).toHaveLength(2);
    // 第二次的两条 id 均为新值，引用仍指向第二次导入的上游
    const [u2, d2] = second.formulas;
    expect(d2.refs!.u.sourceId).toBe(u2.id);
    expect(ids.has(u2.id)).toBe(false);
    const all = [...first.formulas, ...second.formulas];
    const g = resolveGraph(all);
    for (const f of all) expect(g.runtimes.get(f.id)!.status).toBe("ok");
  });

  it("v1 旧格式（无 version/refs）仍可导入", () => {
    const v1 = JSON.stringify({
      app: "dimension-notebook", version: 1,
      formulas: [{ id: newId(), latex: "x", note: "", variables: { x: { value: "1", unit: "m" } }, targetUnit: "", createdAt: 1 }],
    });
    const r = parseImport(v1, new Set());
    expect(r.formulas).toHaveLength(1);
    expect(r.formulas[0].version).toBe(1);
    expect(r.formulas[0].refs).toEqual({});
    const g = resolveGraph(r.formulas);
    expect(g.list[0].status).toBe("ok");
  });

  it("导入数据若被手工改成循环：成环引用被断开并明确报告，公式保留", () => {
    const a = mk({ latex: "b_ref", note: "A" });
    const b = mk({ latex: "a_ref", note: "B" });
    a.refs!["b_ref"] = { alias: "b_ref", sourceId: b.id, pinnedSourceVersion: 1, lastSnapshot: null };
    b.refs!["a_ref"] = { alias: "a_ref", sourceId: a.id, pinnedSourceVersion: 1, lastSnapshot: null };
    const text = JSON.stringify(buildExport([a, b]));
    const r = parseImport(text, new Set());
    expect(r.formulas).toHaveLength(2);
    const refCount = r.formulas.reduce((n, f) => n + Object.keys(f.refs!).length, 0);
    expect(refCount).toBe(1);
    expect(r.notices.join("")).toContain("循环依赖");
  });
});
