import { describe, it, expect } from "vitest";
import {
  addReference, findCycle, formatCyclePath, normalizeFormula,
  removeReference, resolveGraph, usedSymbols,
} from "./graph";
import { analyzeFormula } from "./math";
import { bumpVersion } from "./graph";
import type { Formula, VariableDef } from "./types";
import { newId } from "../storage/db";

const V = (value: string, unit = ""): VariableDef => ({ value, unit });

function make(p: Partial<Formula> = {}): Formula {
  return normalizeFormula({
    id: newId(),
    latex: "",
    note: "",
    variables: {},
    targetUnit: "",
    createdAt: Date.now(),
    ...p,
  } as Formula);
}

/** 长度公式 L = x，x=100 m（已验证） */
function lengthFormula(): Formula {
  return make({ note: "长度 L", latex: "x", variables: { x: V("100", "m") } });
}
/** 时间公式 T = t，t=10 s（已验证） */
function timeFormula(): Formula {
  return make({ note: "时间 T", latex: "t", variables: { t: V("10", "s") }, targetUnit: "" });
}

describe("引用基础：长度与时间发布速度，再换算 km/h", () => {
  it("长度和时间公式发布速度后被另一公式引用并换算为 km/h", () => {
    const L = lengthFormula();
    const T = timeFormula();
    let formulas = [L, T];

    // 速度公式 v = L_ref / T_ref，目标单位 km/h
    const speed = make({ note: "速度 v", latex: "L_ref/T_ref", targetUnit: "km/h" });
    formulas = [...formulas, speed];

    let r = addReference(formulas, { targetId: speed.id, sourceId: L.id, alias: "L_ref" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    formulas = r.formulas;
    r = addReference(formulas, { targetId: speed.id, sourceId: T.id, alias: "T_ref" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    formulas = r.formulas;

    const g = resolveGraph(formulas);
    const rt = g.runtimes.get(speed.id)!;
    expect(rt.status).toBe("ok");
    // 100 m / 10 s = 10 m/s = 36 km/h
    expect(rt.analysis.value).toBeCloseTo(10, 10);
    expect(rt.analysis.resultUnit).toBe("m / s");
    expect(rt.analysis.targetValue).toBeCloseTo(36, 10);
    expect(rt.analysis.targetUnit).toBe("km / h");
    // 追溯信息
    expect(rt.refs.L_ref.sourceVersion).toBe(L.version);
    expect(rt.refs.L_ref.value).toBeCloseTo(100, 10);
    expect(rt.refs.L_ref.unit).toBe("m");
    // 引用别名不进手工变量表
    expect(rt.analysis.variables).not.toContain("L_ref");
    // 原式/代入式带引用标注
    expect(rt.analysis.originalTex).toContain("underline");
    expect(rt.analysis.substituted).toContain("m");
  });
});

describe("阻塞 / 过期 / 快照 / 隔离", () => {
  it("上游改成量纲错误时下游被阻塞，无关公式仍正常计算，历史快照可查看", () => {
    const L = lengthFormula();
    const T = timeFormula();
    const speed = make({ note: "速度 v", latex: "L_ref/T_ref", targetUnit: "km/h" });
    // 无关的普通公式
    const independent = make({
      note: "无关公式", latex: "a+b",
      variables: { a: V("1", "m"), b: V("2", "m") }, targetUnit: "",
    });
    let formulas = [L, T, speed, independent];
    for (const [sid, alias] of [[L.id, "L_ref"], [T.id, "T_ref"]] as const) {
      const r = addReference(formulas, { targetId: speed.id, sourceId: sid, alias });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
      formulas = r.formulas;
    }

    let g = resolveGraph(formulas);
    expect(g.runtimes.get(speed.id)!.status).toBe("ok");
    // 快照已刷新到 refs 上
    const speedWithSnap = formulas.find((f) => f.id === speed.id)!;
    const beforeSnap = g.snapshotPatches.get(speed.id) ?? speedWithSnap.refs!;
    const applyPatches = (fs: Formula[]) =>
      fs.map((f) => (g.snapshotPatches.has(f.id) ? { ...f, refs: g.snapshotPatches.get(f.id)! } : f));
    formulas = applyPatches(formulas);
    expect(beforeSnap.L_ref!.lastSnapshot!.value).toBeCloseTo(100, 10);
    expect(beforeSnap.L_ref!.lastSnapshot!.unit).toBe("m");

    // 上游长度公式改成量纲错误：x 变量给成 m + kg 的相加
    formulas = formulas.map((f) =>
      f.id === L.id
        ? { ...f, latex: "p+q", variables: { p: V("1", "m"), q: V("2", "kg") }, version: f.version + 1 }
        : f,
    );
    g = resolveGraph(formulas);
    const rt = g.runtimes.get(speed.id)!;
    expect(rt.status).toBe("error");
    expect(Object.keys(rt.blockers)).toContain("L_ref");
    expect(rt.blockers.L_ref.reason).toContain("错误");
    // 绝不拿旧值冒充：published 不存在
    expect(rt.published).toBeUndefined();

    // 历史快照仍在（保留在引用定义上），且仍是旧版本 v1 的 100 m
    const speedNow = formulas.find((f) => f.id === speed.id)!;
    const snap = speedNow.refs!.L_ref.lastSnapshot!;
    expect(snap.value).toBeCloseTo(100, 10);
    expect(snap.unit).toBe("m");
    expect(snap.sourceVersion).toBe(1);
    // 当前状态结果值不可用，但快照可展示
    expect(rt.refs.L_ref.snapshot!.value).toBeCloseTo(100, 10);

    // 无关公式仍正常
    const ind = g.runtimes.get(independent.id)!;
    expect(ind.status).toBe("ok");
    expect(ind.analysis.value).toBeCloseTo(3, 10);

    // 时间公式本身也正常
    expect(g.runtimes.get(T.id)!.status).toBe("ok");
  });

  it("上游未验证时下游阻塞（不允许引用 unverified）", () => {
    const upstream = make({
      note: "摄氏相加",
      latex: "T_1+T_2",
      variables: { T_1: V("10", "degC"), T_2: V("5", "degC") },
    });
    const down = make({ note: "下游", latex: "u" });
    let formulas = [upstream, down];
    // 直接建立即被拒绝
    const r = addReference(formulas, { targetId: down.id, sourceId: upstream.id, alias: "u" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("未验证");

    // 先建立对一个已验证公式的引用，再把上游改成未验证 → 阻塞
    const good = make({ note: "好上游", latex: "z", variables: { z: V("2", "m") } });
    formulas = [good, down];
    const r2 = addReference(formulas, { targetId: down.id, sourceId: good.id, alias: "u" });
    expect(r2.ok).toBe(true);
    if (r2.ok) formulas = r2.formulas;
    formulas = formulas.map((f) =>
      f.id === good.id
        ? { ...f, latex: "a+b", variables: { a: V("1", "degC"), b: V("2", "degC") }, version: f.version + 1 }
        : f,
    );
    const g = resolveGraph(formulas);
    expect(g.runtimes.get(down.id)!.blockers.u.reason).toContain("未验证");
  });

  it("上游被删除后下游阻塞并保留快照，重新添加同 id 无关公式不会误重连", () => {
    const up = make({ note: "上游", latex: "x", variables: { x: V("7", "m/s") } });
    const down = make({ note: "下游", latex: "v" });
    let formulas = [up, down];
    const r = addReference(formulas, { targetId: down.id, sourceId: up.id, alias: "v" });
    expect(r.ok).toBe(true);
    if (r.ok) formulas = r.formulas;
    let g = resolveGraph(formulas);
    formulas = formulas.map((f) => (g.snapshotPatches.has(f.id) ? { ...f, refs: g.snapshotPatches.get(f.id)! } : f));

    formulas = formulas.filter((f) => f.id !== up.id);
    g = resolveGraph(formulas);
    const rt = g.runtimes.get(down.id)!;
    expect(rt.status).toBe("error");
    expect(rt.blockers.v.reason).toContain("删除");
    expect(rt.refs.v.snapshot!.value).toBeCloseTo(7, 10);
  });

  it("阻塞沿链路传播：A→B→C，C 出错时 A、B 都阻塞", () => {
    const C = make({ note: "C", latex: "c", variables: { c: V("1", "m") } });
    const B = make({ note: "B", latex: "bc" });
    const A = make({ note: "A", latex: "ab" });
    let formulas = [C, B, A];
    let r = addReference(formulas, { targetId: B.id, sourceId: C.id, alias: "bc" });
    expect(r.ok).toBe(true); if (r.ok) formulas = r.formulas;
    r = addReference(formulas, { targetId: A.id, sourceId: B.id, alias: "ab" });
    expect(r.ok).toBe(true); if (r.ok) formulas = r.formulas;

    formulas = formulas.map((f) =>
      f.id === C.id ? { ...f, latex: "x+y", variables: { x: V("1", "m"), y: V("1", "kg") }, version: f.version + 1 } : f,
    );
    const g = resolveGraph(formulas);
    expect(g.runtimes.get(B.id)!.status).toBe("error");
    expect(g.runtimes.get(A.id)!.status).toBe("error");
    expect(Object.keys(g.runtimes.get(A.id)!.blockers)).toContain("ab");
    // 传播原因里应说明上游本身被阻塞
    expect(g.runtimes.get(A.id)!.blockers.ab.reason).toContain("阻塞");
  });

  it("引用别名未在表达式中出现时不阻塞（unused），引用变量不出现在手工变量表", () => {
    const up = make({ note: "up", latex: "x", variables: { x: V("3", "s") } });
    const down = make({ note: "down", latex: "1+1" });
    let formulas = [up, down];
    const r = addReference(formulas, { targetId: down.id, sourceId: up.id, alias: "w" });
    expect(r.ok).toBe(true); if (r.ok) formulas = r.formulas;
    const g = resolveGraph(formulas);
    const rt = g.runtimes.get(down.id)!;
    expect(rt.status).toBe("ok");
    expect(rt.refs.w.status).toBe("unused");
  });

  it("沿链路重新计算：上游值改变后下游自动跟随，不手工抄数", () => {
    const up = make({ note: "up", latex: "x", variables: { x: V("4", "m") } });
    const down = make({ note: "down", latex: "u*2" });
    let formulas = [up, down];
    const r = addReference(formulas, { targetId: down.id, sourceId: up.id, alias: "u" });
    expect(r.ok).toBe(true); if (r.ok) formulas = r.formulas;
    let g = resolveGraph(formulas);
    expect(g.runtimes.get(down.id)!.analysis.value).toBeCloseTo(8, 10);

    formulas = formulas.map((f) =>
      f.id === up.id ? { ...f, variables: { x: V("5", "m") }, version: f.version + 1 } : f,
    );
    g = resolveGraph(formulas);
    expect(g.runtimes.get(down.id)!.analysis.value).toBeCloseTo(10, 10);
    expect(g.runtimes.get(down.id)!.refs.u.sourceVersion).toBe(2);
  });
});

describe("循环依赖：保存前拒绝且不留半条引用", () => {
  it("A→B→A 间接循环被拒绝，两条既有公式不被改写", () => {
    // 两条独立可发布公式，通过引用把符号串成链；建立引用后表达式仍只含引用别名
    const A = make({ note: "A", latex: "1", version: 3 });
    const B = make({ note: "B", latex: "2", version: 5 });
    let formulas = [A, B];
    // A 先引用 B（成功）
    const r1 = addReference(formulas, { targetId: A.id, sourceId: B.id, alias: "ab" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error(r1.error);
    formulas = r1.formulas;
    const aAfterFirst = formulas.find((f) => f.id === A.id)!;
    expect(aAfterFirst.version).toBe(4); // 第一次引用建立成功，版本 +1
    expect(Object.keys(aAfterFirst.refs!)).toEqual(["ab"]);

    // B 再引用 A → 应检测出 A→B→A 完整环路并拒绝
    const before = JSON.stringify(formulas);
    const r2 = addReference(formulas, { targetId: B.id, sourceId: A.id, alias: "ba" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error).toContain("循环依赖");
      // 完整环路：公式 A → 公式 B → 公式 A
      expect(r2.error).toContain("公式 1");
      expect(r2.error).toContain("公式 2");
    }
    // 两条既有公式完全不被改写（无半条引用）
    expect(JSON.stringify(formulas)).toBe(before);
    const Bafter = formulas.find((f) => f.id === B.id)!;
    expect(Bafter.refs).toEqual({});
    expect(Bafter.version).toBe(5);

    // findCycle 直接给出完整路径（target 发起引用：target → source → … → target）
    const cyc = findCycle(formulas, B.id, A.id);
    expect(cyc).not.toBeNull();
    expect(cyc).toEqual([B.id, A.id, B.id]);
    const text = formatCyclePath(formulas, cyc!);
    expect(text).toBe("公式 2（B） → 公式 1（A） → 公式 2（B）");
    if (!r2.ok) {
      expect(r2.error).toContain(text);
      expect(r2.error).toContain("循环依赖");
    }
  });

  it("自引用被拒绝", () => {
    const A = make({ note: "A", latex: "x" });
    const r = addReference([A], { targetId: A.id, sourceId: A.id, alias: "x" });
    expect(r.ok).toBe(false);
  });

  it("运行时防护：若数据中已存在循环（如手工改库），环上节点全部阻塞且原因给出完整环路", () => {
    const A = make({ note: "A", latex: "b_r" });
    const B = make({ note: "B", latex: "a_r" });
    A.refs!["b_r"] = { alias: "b_r", sourceId: B.id, pinnedSourceVersion: 1, lastSnapshot: null };
    B.refs!["a_r"] = { alias: "a_r", sourceId: A.id, pinnedSourceVersion: 1, lastSnapshot: null };
    const g = resolveGraph([A, B]);
    const rtA = g.runtimes.get(A.id)!;
    const rtB = g.runtimes.get(B.id)!;
    expect(rtA.status).toBe("error");
    expect(rtB.status).toBe("error");
    expect(rtA.blockers.b_r.reason).toContain("循环依赖");
    // 完整环路包含两条公式
    expect(rtA.blockers.b_r.reason).toContain("公式 1");
    expect(rtA.blockers.b_r.reason).toContain("公式 2");
    expect(rtA.published).toBeUndefined();
  });

  it("别名非法 / 重名 / 与手工变量冲突被拒绝", () => {
    const A = make({ note: "A", latex: "x", variables: { q: V("1", "m") } });
    const B = make({ note: "B", latex: "y", variables: { y: V("2", "s") } });
    let r = addReference([A, B], { targetId: A.id, sourceId: B.id, alias: "pi" });
    expect(r.ok).toBe(false);
    r = addReference([A, B], { targetId: A.id, sourceId: B.id, alias: "1abc" });
    expect(r.ok).toBe(false);
    r = addReference([A, B], { targetId: A.id, sourceId: B.id, alias: "q" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("手工赋值变量");
  });

  it("删除引用后版本增加，公式重新可算", () => {
    const up = make({ note: "up", latex: "x", variables: { x: V("1", "m") } });
    const down = make({ note: "down", latex: "u" });
    let formulas = [up, down];
    const r = addReference(formulas, { targetId: down.id, sourceId: up.id, alias: "u" });
    expect(r.ok).toBe(true); if (r.ok) formulas = r.formulas;
    const v = formulas.find((f) => f.id === down.id)!.version;
    formulas = removeReference(formulas, down.id, "u");
    expect(formulas.find((f) => f.id === down.id)!.refs).toEqual({});
    expect(formulas.find((f) => f.id === down.id)!.version).toBe(v + 1);
  });
});

describe("版本与普通公式隔离", () => {
  it("普通公式（无引用）的分析结果与单条 analyzeFormula 一致", () => {
    const f1 = make({ latex: "x/t", variables: { x: V("100", "m"), t: V("10", "s") } });
    const f2 = make({ latex: "(a+b)*c", variables: { a: V("1", "m"), b: V("2", "kg"), c: V("3", "") } });
    const g = resolveGraph([f1, f2]);
    const direct1 = analyzeFormula(f1.latex, f1.variables, f1.targetUnit);
    const direct2 = analyzeFormula(f2.latex, f2.variables, f2.targetUnit);
    expect(g.runtimes.get(f1.id)!.status).toBe(direct1.status);
    expect(g.runtimes.get(f1.id)!.analysis.value).toBe(direct1.value);
    expect(g.runtimes.get(f2.id)!.status).toBe(direct2.status);
  });

  it("bumpVersion 仅升版本号", () => {
    const f = make({ version: 1 });
    const [b] = bumpVersion([f], f.id);
    expect(b.version).toBe(2);
  });

  it("usedSymbols 正确收集下标与希腊字母", () => {
    expect([...usedSymbols("v\\cdot t+T_{out}")].sort()).toEqual(["T_out", "t", "v"]);
    expect(usedSymbols("")).toEqual(new Set());
  });

  it("引用别名两种 LaTeX 写法（L_ref 与 L_{ref}）都整体识别为符号", () => {
    // 无别名知识时 L_ref 被拆成 L_r·e·f（旧行为）
    expect(usedSymbols("L_ref").has("L_ref")).toBe(false);
    // 有别名知识时两种写法都正确
    expect(usedSymbols("L_ref", new Set(["L_ref"])).has("L_ref")).toBe(true);
    expect(usedSymbols("L_{ref}", new Set(["L_ref"])).has("L_ref")).toBe(true);
    // 通过引擎代入：100 m / 10 s = 10 m/s
    const r = analyzeFormula(
      "\\dfrac{L_{ref}}{T_{ref}}",
      {},
      "km/h",
      [
        { alias: "L_ref", status: "ok", value: 100, unit: "m" },
        { alias: "T_ref", status: "ok", value: 10, unit: "s" },
      ],
    );
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(36, 10);
    expect(r.variables).not.toContain("L_ref");
  });
});
