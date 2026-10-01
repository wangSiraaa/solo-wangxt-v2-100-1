import { describe, it, expect } from "vitest";
import { buildExport, parseImport } from "./exchange";
import { analyzeFormula } from "../engine/math";
import { analyzeNotebook } from "../engine/graph";
import type { Formula } from "../engine/types";
import { newId } from "./db";

const f = (p: Partial<Formula> = {}): Formula => ({
  id: newId(),
  latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
  note: "n",
  variables: { v: { value: "2", unit: "m/s" }, t: { value: "3", unit: "s" }, a: { value: "4", unit: "m/s^2" } },
  targetUnit: "m",
  createdAt: 1,
  revision: 1,
  refs: [],
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
  const chain = (): Formula[] => {
    const src = f({
      id: "src-1", latex: "s", note: "长度", targetUnit: "",
      variables: { s: { value: "100", unit: "m" } }, revision: 2,
    });
    const speed = f({
      id: "spd-1", latex: "L/T", note: "速度", targetUnit: "",
      variables: { T: { value: "4", unit: "s" } },
      refs: [{
        name: "L", sourceId: "src-1", sourceRevision: 2,
        snapshot: { value: 100, unit: "m", sourceRevision: 2, capturedAt: 555 },
      }],
      revision: 3,
    });
    const kmh = f({
      id: "kmh-1", latex: "v", note: "km/h", targetUnit: "km/h",
      refs: [{
        name: "v", sourceId: "spd-1", sourceRevision: 3,
        snapshot: { value: 25, unit: "m / s", sourceRevision: 3, capturedAt: 556 },
      }],
    });
    return [src, speed, kmh];
  };

  it("导出保留 revision、refs 与最后有效快照", () => {
    const data = buildExport(chain());
    expect(data.version).toBe(2);
    const [src, speed, kmh] = data.formulas;
    expect(src.revision).toBe(2);
    expect(speed.refs[0]).toMatchObject({ name: "L", sourceId: "src-1", sourceRevision: 2 });
    expect(speed.refs[0].snapshot?.value).toBe(100);
    expect(kmh.refs[0].snapshot?.unit).toBe("m / s");
  });

  it("导入到空笔记本：引用重映射到新副本，刷新后沿链重算且版本对齐", () => {
    const text = JSON.stringify(buildExport(chain()));
    const r = parseImport(text, new Set());
    expect(r.errors).toEqual([]);
    expect(r.unresolvedRefs).toEqual([]);
    expect(r.reconnectedImported).toBe(2);
    const ids = r.formulas.map((x) => x.id);
    // 原 id 无冲突 → 保留稳定 id，引用按 id 直接重连
    expect(ids).toEqual(["src-1", "spd-1", "kmh-1"]);
    expect(r.formulas[1].refs[0].sourceId).toBe("src-1");
    expect(r.formulas[2].refs[0].sourceId).toBe("spd-1");

    // “刷新后”重新分析：状态与来源版本一致，结果可复现
    const a = analyzeNotebook(r.formulas, () => "x");
    const kmh = a.entries[2];
    expect(kmh.result.status).toBe("ok");
    expect(kmh.result.targetValue).toBeCloseTo(90, 10);
    expect(kmh.formula.refs[0].sourceRevision).toBe(3);
    expect(kmh.formula.refs[0].snapshot?.value).toBeCloseTo(25, 10);
  });

  it("导入到已有同名公式的笔记本：id 冲突时换副本 id，引用重连到导入的新副本而非旧公式", () => {
    // 笔记本里已有一条 id=src-1 但内容完全不同的公式（同名标识冲突）
    const existingSrc: Formula = f({
      id: "src-1", latex: "z", note: "笔记本里的旧来源",
      variables: { z: { value: "1", unit: "kg" } },
    });
    const text = JSON.stringify(buildExport(chain()));
    const existing = new Set(["src-1"]);
    const r = parseImport(text, existing);
    const imported = r.formulas;
    const newSrc = imported[0];
    expect(newSrc.id).not.toBe("src-1"); // 冲突 → 生成新 id
    // speed 引用必须重连到新副本，而不是笔记本里的旧 src-1
    expect(imported[1].refs[0].sourceId).toBe(newSrc.id);
    expect(imported[1].refs[0].sourceId).not.toBe("src-1");
    // kmh → speed（无冲突，保留原 id）
    expect(imported[2].refs[0].sourceId).toBe("spd-1");

    // 用新副本分析：取到的是导入文件里的 100 m，不是旧公式的 1 kg
    const a = analyzeNotebook([existingSrc, ...imported], () => "x");
    const speedEntry = a.byId.get("spd-1")!;
    expect(speedEntry.result.status).toBe("ok");
    expect(speedEntry.result.value).toBeCloseTo(25, 10);
    expect(speedEntry.result.resultUnit).toBe("m / s");
  });

  it("导入时来源不在文件中、但笔记本内存在同名公式 → 重连到该正确副本", () => {
    // 只导出下游 kmh（其来源 spd-1 不在文件中）
    const kmh = chain()[2];
    const text = JSON.stringify(buildExport([kmh]));
    // 笔记本里已有 id=spd-1 的已验证速度公式
    const existingSpeed: Formula = f({
      id: "spd-1", latex: "L/T", targetUnit: "",
      variables: { L: { value: "100", unit: "m" }, T: { value: "4", unit: "s" } },
    });
    const r = parseImport(text, new Set(["spd-1"]));
    expect(r.unresolvedRefs).toEqual([]);
    expect(r.reconnectedExisting).toBe(1);
    expect(r.formulas[0].refs[0].sourceId).toBe("spd-1");
    const a = analyzeNotebook([existingSpeed, r.formulas[0]], () => "x");
    expect(a.entries[1].result.status).toBe("ok");
    expect(a.entries[1].result.targetValue).toBeCloseTo(90, 10);
  });

  it("导入时来源既不在文件中、笔记本里也没有 → 明确未解析，刷新后下游 blocked 且快照保留", () => {
    const kmh = chain()[2]; // 引用 spd-1
    const text = JSON.stringify(buildExport([kmh]));
    const r = parseImport(text, new Set());
    expect(r.unresolvedRefs).toHaveLength(1);
    expect(r.unresolvedRefs[0]).toMatchObject({ name: "v", missingSourceId: "spd-1" });
    // 绑定仍保留（原始 sourceId 与快照），不丢引用
    expect(r.formulas[0].refs[0].sourceId).toBe("spd-1");
    expect(r.formulas[0].refs[0].snapshot?.value).toBe(25);

    const a = analyzeNotebook(r.formulas, () => "x");
    const e = a.entries[0];
    expect(e.result.status).toBe("blocked");
    expect(e.traces[0].reasonCode).toBe("missing");
    expect(e.traces[0].snapshot?.value).toBe(25); // 历史快照仍可查看
  });

  it("重复导入幂等：第二次导入再次换 id，不覆盖第一次的副本，引用仍各自重连", () => {
    const text = JSON.stringify(buildExport(chain()));
    const first = parseImport(text, new Set());
    const second = parseImport(text, new Set(first.formulas.map((x) => x.id)));
    // 第一次占用了 src-1/spd-1/kmh-1 → 第二次全部换新 id
    expect(second.formulas.every((x) => !first.formulas.some((y) => y.id === x.id))).toBe(true);
    // 第二次内部引用仍重连到第二次自己的副本
    expect(second.formulas[1].refs[0].sourceId).toBe(second.formulas[0].id);
    expect(second.formulas[2].refs[0].sourceId).toBe(second.formulas[1].id);
  });

  it("旧版 v1 导出（无 revision/refs）仍可导入，补齐默认值后照常分析", () => {
    const v1 = JSON.stringify({
      app: "dimension-notebook",
      version: 1,
      exportedAt: new Date().toISOString(),
      formulas: [{
        id: "old-1",
        latex: "a+b",
        note: "",
        variables: { a: { value: "1", unit: "m" }, b: { value: "2", unit: "m" } },
        targetUnit: "",
        createdAt: 1,
      }],
    });
    const r = parseImport(v1, new Set());
    expect(r.formulas).toHaveLength(1);
    expect(r.formulas[0].revision).toBe(1);
    expect(r.formulas[0].refs).toEqual([]);
    const a = analyzeNotebook(r.formulas, () => "x");
    expect(a.entries[0].result.status).toBe("ok");
    expect(a.entries[0].result.value).toBe(3);
  });
});
