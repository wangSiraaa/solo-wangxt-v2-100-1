// 已发布结果引用：依赖图、沿链重算、阻塞/过期、快照、循环拒绝 的验收测试
import { describe, it, expect } from "vitest";
import {
  analyzeNotebook, findCycles, formatCycle, validateRefs, dependencyGraph,
} from "./graph";
import type { Formula, RefBinding } from "./types";
import { newId } from "../storage/db";

const f = (p: Partial<Formula> = {}): Formula => ({
  id: newId(),
  latex: "",
  note: "",
  variables: {},
  targetUnit: "",
  createdAt: 0,
  revision: 1,
  refs: [],
  ...p,
});

const labeler = (fs: Formula[]) => (id: string) => {
  const i = fs.findIndex((x) => x.id === id);
  return i < 0 ? id : `#${i + 1}`;
};

describe("验收 1：长度/时间发布速度，再被引用并换算为 km/h", () => {
  it("长度与时间 → 速度 → km/h，数值、单位、来源版本均可追溯", () => {
    const length = f({ latex: "s", note: "长度", variables: { s: { value: "100", unit: "m" } } });
    const time = f({ latex: "t", note: "时间", variables: { t: { value: "4", unit: "s" } } });
    const speed = f({
      latex: "\\frac{L}{T}", note: "速度",
      refs: [
        { name: "L", sourceId: length.id, sourceRevision: 1 },
        { name: "T", sourceId: time.id, sourceRevision: 1 },
      ],
    });
    const toKmh = f({
      latex: "v", note: "换算", targetUnit: "km/h",
      refs: [{ name: "v", sourceId: speed.id, sourceRevision: 1 }],
    });
    const fs = [length, time, speed, toKmh];

    const a = analyzeNotebook(fs, labeler(fs), 1000);
    const eLen = a.byId.get(length.id)!;
    const eTime = a.byId.get(time.id)!;
    const eSpeed = a.byId.get(speed.id)!;
    const eKmh = a.byId.get(toKmh.id)!;

    expect(eLen.result.status).toBe("ok");
    expect(eTime.result.status).toBe("ok");
    // 速度 = 100 m / 4 s = 25 m/s
    expect(eSpeed.result.status).toBe("ok");
    expect(eSpeed.result.value).toBeCloseTo(25, 10);
    expect(eSpeed.result.resultUnit).toBe("m / s");
    // 下游换算为 km/h：25 m/s = 90 km/h
    expect(eKmh.result.status).toBe("ok");
    expect(eKmh.result.targetValue).toBeCloseTo(90, 10);
    expect(eKmh.result.targetUnit).toBe("km / h");

    // 引用 trace 可追溯：来源、版本、值、单位
    const vTrace = eKmh.traces[0];
    expect(vTrace.state).toBe("live");
    expect(vTrace.sourceId).toBe(speed.id);
    expect(vTrace.value).toBeCloseTo(25, 10);
    expect(vTrace.unit).toBe("m / s");
    expect(vTrace.sourceRevision).toBe(1);

    // 绑定被回写：版本对齐 + 最后有效快照
    const bound = eKmh.formula.refs[0];
    expect(bound.sourceRevision).toBe(1);
    expect(bound.snapshot?.value).toBeCloseTo(25, 10);
    expect(bound.snapshot?.unit).toBe("m / s");
    expect(bound.snapshot?.capturedAt).toBe(1000);

    // 原式中派生变量染蓝色溯源，问题列表无错误
    expect(eKmh.result.originalTex).toContain("#1f6feb");
    expect(eKmh.result.issues).toEqual([]);
    // 依赖图边正确
    expect([...(dependencyGraph(fs).get(speed.id) ?? [])].sort()).toEqual([length.id, time.id].sort());
  });

  it("来源改版后下游自动沿链路重新计算并对齐新版本", () => {
    const length = f({ latex: "s", variables: { s: { value: "100", unit: "m" } }, revision: 3 });
    const time = f({ latex: "t", variables: { t: { value: "4", unit: "s" } } });
    const speed = f({
      latex: "L/T",
      refs: [
        { name: "L", sourceId: length.id, sourceRevision: 3, snapshot: { value: 100, unit: "m", sourceRevision: 3, capturedAt: 1 } },
        { name: "T", sourceId: time.id, sourceRevision: 1, snapshot: { value: 4, unit: "s", sourceRevision: 1, capturedAt: 1 } },
      ],
    });
    const toKmh = f({
      latex: "v", targetUnit: "km/h",
      refs: [{ name: "v", sourceId: speed.id, sourceRevision: 1, snapshot: { value: 25, unit: "m / s", sourceRevision: 1, capturedAt: 1 } }],
    });
    // 长度改成 200 m（revision 升到 4）
    const length2 = { ...length, variables: { s: { value: "200", unit: "m" } }, revision: 4 };
    const fs = [length2, time, speed, toKmh];

    const a = analyzeNotebook(fs, labeler(fs), 2000);
    const eSpeed = a.byId.get(speed.id)!;
    const eKmh = a.byId.get(toKmh.id)!;

    expect(eSpeed.result.value).toBeCloseTo(50, 10); // 200/4
    expect(eKmh.result.targetValue).toBeCloseTo(180, 10); // 50 m/s = 180 km/h
    // 中间公式的“有效发布版本”沿链升版（存储版本由持久化层据 revisionBump 递增一次）
    expect(eSpeed.published?.revision).toBe(2);
    expect(eSpeed.revisionBump).toBe(true);
    // kmh 这轮看到的就是中间公式的新有效版本 v2
    expect(eKmh.formula.refs[0].sourceRevision).toBe(2);
    expect(eKmh.revisionBump).toBe(true);
    // trace 给出“来源已更新”的可解释说明
    expect(eKmh.traces[0].reason).toContain("来源已更新");
    // 快照刷新为新值
    expect(eKmh.formula.refs[0].snapshot?.value).toBeCloseTo(50, 10);
  });
});

describe("验收 2：上游量纲错误时下游阻塞，无关公式照常；快照仍可查看", () => {
  it("来源变成量纲错误 → 下游 blocked 且不使用旧值；普通公式仍已验证", () => {
    // 上游：m + kg 量纲错误
    const bad = f({
      latex: "a+b",
      variables: { a: { value: "1", unit: "m" }, b: { value: "2", unit: "kg" } },
    });
    // 此前下游已拿到过快照 3 m/s（历史有效值）
    const down = f({
      latex: "x*2",
      refs: [{
        name: "x", sourceId: bad.id, sourceRevision: 1,
        snapshot: { value: 3, unit: "m / s", sourceRevision: 1, capturedAt: 123 },
      }],
    });
    // 无关普通公式
    const plain = f({
      latex: "p+q",
      variables: { p: { value: "1", unit: "m" }, q: { value: "2", unit: "m" } },
    });
    const fs = [bad, down, plain];

    const a = analyzeNotebook(fs, labeler(fs), 3000);
    const eBad = a.byId.get(bad.id)!;
    const eDown = a.byId.get(down.id)!;
    const ePlain = a.byId.get(plain.id)!;

    expect(eBad.result.status).toBe("error");
    // 下游被阻塞
    expect(eDown.result.status).toBe("blocked");
    expect(eDown.result.value).toBeUndefined();
    expect(eDown.result.targetValue).toBeUndefined();
    expect(eDown.result.substituted).toBeUndefined(); // 不展示代入式，避免旧值冒充
    expect(eDown.result.blockedRefs).toEqual(["x"]);
    // 问题列表可解释：来源错误 + 保留快照信息
    const msg = eDown.result.issues[0].message;
    expect(msg).toContain("存在错误");
    expect(msg).toContain("3 m / s");
    expect(msg).toContain("来源版本 v1");
    // trace 保留最后有效快照供历史查看
    expect(eDown.traces[0].state).toBe("blocked");
    expect(eDown.traces[0].snapshot?.value).toBe(3);
    // 绑定上的旧快照未被覆盖
    expect(eDown.formula.refs[0].snapshot?.value).toBe(3);
    // 无关公式照常计算
    expect(ePlain.result.status).toBe("ok");
    expect(ePlain.result.value).toBe(3);
  });

  it("来源未验证（摄氏度相加）同样阻塞下游", () => {
    const warn = f({
      latex: "T_1+T_2",
      variables: { T_1: { value: "10", unit: "degC" }, T_2: { value: "5", unit: "degC" } },
    });
    const down = f({ latex: "u", refs: [{ name: "u", sourceId: warn.id, sourceRevision: 0 }] });
    const a = analyzeNotebook([warn, down], labeler([warn, down]));
    expect(a.byId.get(warn.id)!.result.status).toBe("unverified");
    expect(a.byId.get(down.id)!.result.status).toBe("blocked");
    expect(a.byId.get(down.id)!.traces[0].reasonCode).toBe("upstream-status");
  });

  it("来源被删除后下游阻塞为 missing，快照保留；恢复来源后自动解除", () => {
    const src = f({ latex: "a", variables: { a: { value: "7", unit: "m" } } });
    const down = f({
      latex: "x",
      refs: [{
        name: "x", sourceId: src.id, sourceRevision: 1,
        snapshot: { value: 7, unit: "m", sourceRevision: 1, capturedAt: 9 },
      }],
    });
    // 删除来源
    const deleted = analyzeNotebook([down], labeler([down]));
    const eDown = deleted.byId.get(down.id)!;
    expect(eDown.result.status).toBe("blocked");
    expect(eDown.traces[0].reasonCode).toBe("missing");
    expect(eDown.traces[0].snapshot?.value).toBe(7);
    expect(eDown.result.issues[0].message).toContain("已被删除或在导入后未能解析");

    // 来源恢复 → 自动重新变 live
    const restored = analyzeNotebook([src, down], labeler([src, down]));
    expect(restored.byId.get(down.id)!.result.status).toBe("ok");
    expect(restored.byId.get(down.id)!.result.value).toBe(7);
  });

  it("多级链路中上游错误沿链传播：两层下游都 blocked", () => {
    const bad = f({ latex: "a+b", variables: { a: { value: "1", unit: "m" }, b: { value: "2", unit: "kg" } } });
    const mid = f({ latex: "u", refs: [{ name: "u", sourceId: bad.id, sourceRevision: 0 }] });
    const leaf = f({ latex: "w", refs: [{ name: "w", sourceId: mid.id, sourceRevision: 0 }] });
    const a = analyzeNotebook([bad, mid, leaf], labeler([bad, mid, leaf]));
    expect(a.byId.get(mid.id)!.result.status).toBe("blocked");
    expect(a.byId.get(leaf.id)!.result.status).toBe("blocked");
    expect(a.byId.get(leaf.id)!.traces[0].reason).toContain("其上游被阻塞");
  });
});

describe("验收 3：A→B→A 间接循环保存前被拒绝，既有公式不被改写", () => {
  it("findCycles 返回完整环路 A→B→A", () => {
    const A = f();
    const B = f();
    // 现有：A 引用 B
    const A1 = { ...A, refs: [{ name: "x", sourceId: B.id, sourceRevision: 0 }] };
    const fs = [A1, B];
    // 试图让 B 引用 A
    const cycles = findCycles(fs, B.id, [{ sourceId: A.id }]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].length).toBe(3);
    expect(cycles[0][0]).toBe(cycles[0][2]);
    expect(new Set(cycles[0].slice(0, 2))).toEqual(new Set([A.id, B.id]));
    // 可读环路文本
    const text = formatCycle(cycles, labeler(fs));
    expect(text).toMatch(/^#1 → #2 → #1$|^#2 → #1 → #2$/);
  });

  it("validateRefs 拒绝循环且两条既有公式保持原样（不留半条引用）", () => {
    const A = f();
    const B = f();
    const A1: Formula = { ...A, refs: [{ name: "x", sourceId: B.id, sourceRevision: 5 }] };
    const fs = [A1, B];

    // 尝试在 B 上新增对 A 的引用
    const next: RefBinding[] = [{ name: "y", sourceId: A1.id, sourceRevision: 0 }];
    const v = validateRefs(fs, B.id, next);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("循环引用");

    // 关键：输入数据完全没有被修改
    expect(fs[0]).toBe(A1);
    expect(fs[1]).toBe(B);
    expect(A1.refs[0].sourceRevision).toBe(5);
    expect(B.refs).toEqual([]);
  });

  it("自引用 A→A 也被拒绝", () => {
    const A = f();
    const v = validateRefs([A], A.id, [{ name: "x", sourceId: A.id, sourceRevision: 0 }]);
    expect(v.ok).toBe(false);
    expect(findCycles([A], A.id, [{ sourceId: A.id }])).toHaveLength(1);
  });

  it("无环的合法引用通过校验", () => {
    const A = f();
    const B = f();
    const C = f();
    const fs = [A, B, C];
    // A→B, B→C
    const v1 = validateRefs(fs, A.id, [{ name: "x", sourceId: B.id, sourceRevision: 0 }]);
    expect(v1.ok).toBe(true);
    const fs2: Formula[] = [{ ...A, refs: [{ name: "x", sourceId: B.id, sourceRevision: 0 }] }, B, C];
    const v2 = validateRefs(fs2, B.id, [{ name: "y", sourceId: C.id, sourceRevision: 0 }]);
    expect(v2.ok).toBe(true);
  });

  it("重复变量名/非法名称/不存在来源被拒绝", () => {
    const A = f();
    const B = f();
    expect(validateRefs([A, B], A.id, [
      { name: "x", sourceId: B.id, sourceRevision: 0 },
      { name: "x", sourceId: B.id, sourceRevision: 0 },
    ]).ok).toBe(false);
    expect(validateRefs([A, B], A.id, [{ name: "1x", sourceId: B.id, sourceRevision: 0 }]).ok).toBe(false);
    expect(validateRefs([A, B], A.id, [{ name: "pi", sourceId: B.id, sourceRevision: 0 }]).ok).toBe(false);
    expect(validateRefs([A, B], A.id, [{ name: "x", sourceId: "nope", sourceRevision: 0 }]).ok).toBe(false);
  });

  it("已落库的环（如旧数据）在分析时所有环节点都 blocked，不用环内旧值", () => {
    const A = f({ latex: "y+1", refs: [{ name: "y", sourceId: "__B__", sourceRevision: 0 }] });
    const B = f({ id: "__B__", latex: "x+1", refs: [{ name: "x", sourceId: A.id, sourceRevision: 0 }] });
    const a = analyzeNotebook([A, B], labeler([A, B]));
    expect(a.byId.get(A.id)!.result.status).toBe("blocked");
    expect(a.byId.get(B.id)!.result.status).toBe("blocked");
  });
});

describe("普通公式隔离与沿链收敛", () => {
  it("没有 refs 的普通公式分析结果与独立引擎一致", async () => {
    const { analyzeFormula } = await import("./math");
    const plain = f({
      latex: "v t",
      variables: { v: { value: "2", unit: "m/s" }, t: { value: "3", unit: "s" } },
    });
    const a = analyzeNotebook([plain], labeler([plain]));
    const r = a.byId.get(plain.id)!.result;
    const direct = analyzeFormula(plain.latex, plain.variables, plain.targetUnit);
    expect(r.status).toBe(direct.status);
    expect(r.value).toBe(direct.value);
    expect(r.resultUnit).toBe(direct.resultUnit);
    expect(a.byId.get(plain.id)!.formula.refs).toEqual([]);
  });

  it("三级链路沿链升版后再次分析即收敛（不会无限升版），结果正确", () => {
    // A（原始来源）→ B → C；A 当前为 revision 3，但 B 仍对齐 A@v2，C 对齐 B@v1
    const A = f({ latex: "a", variables: { a: { value: "8", unit: "m" } }, revision: 3 });
    const B = f({
      latex: "x", revision: 1,
      refs: [{ name: "x", sourceId: A.id, sourceRevision: 2, snapshot: { value: 5, unit: "m", sourceRevision: 2, capturedAt: 1 } }],
    });
    const C = f({
      latex: "y", revision: 1,
      refs: [{ name: "y", sourceId: B.id, sourceRevision: 1, snapshot: { value: 5, unit: "m", sourceRevision: 1, capturedAt: 1 } }],
    });
    let fs = [A, B, C];
    // 第一轮：B 发现 A 变了（v2→v3），B 传播升版；C 在同一轮看到的是 B 的有效 v2
    let a = analyzeNotebook(fs, labeler(fs));
    expect(a.byId.get(B.id)!.revisionBump).toBe(true);
    expect(a.byId.get(C.id)!.revisionBump).toBe(true);
    // 模拟 App 应用回写（refs 对齐 + 传播性 revision +1）
    const apply = (list: Formula[]): Formula[] => list.map((x) => {
      const e = a.byId.get(x.id)!;
      return { ...x, refs: e.formula.refs, revision: e.revisionBump ? x.revision + 1 : x.revision };
    });
    fs = apply(fs);
    expect(fs[1].revision).toBe(2);
    expect(fs[2].revision).toBe(2);

    // 第二轮：全部已对齐，应完全收敛（不再有任何 bump）
    a = analyzeNotebook(fs, labeler(fs));
    expect(a.byId.get(A.id)!.revisionBump).toBe(false);
    expect(a.byId.get(B.id)!.revisionBump).toBe(false);
    expect(a.byId.get(C.id)!.revisionBump).toBe(false);
    expect(a.byId.get(C.id)!.result.value).toBe(8);
    // 第三轮幂等
    fs = fs.map((x) => { const e = a.byId.get(x.id)!; return { ...x, refs: e.formula.refs }; });
    const a3 = analyzeNotebook(fs, labeler(fs));
    expect(a3.entries.every((e) => !e.revisionBump)).toBe(true);
  });
});
