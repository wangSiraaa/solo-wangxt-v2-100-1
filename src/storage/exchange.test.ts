import { describe, it, expect } from "vitest";
import { buildExport, parseImport } from "./exchange";
import { analyzeFormula } from "../engine/math";
import type { Formula } from "../engine/types";
import { newId } from "./db";

const f = (p: Partial<Formula> = {}): Formula => ({
  id: newId(),
  latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
  note: "n",
  variables: { v: { value: "2", unit: "m/s" }, t: { value: "3", unit: "s" }, a: { value: "4", unit: "m/s^2" } },
  targetUnit: "m",
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
