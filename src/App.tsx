import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Formula, RefBinding } from "./engine/types";
import { analyzeNotebook, validateRefs } from "./engine/graph";
import { db, newId } from "./storage/db";
import { buildExport, downloadJSON, parseImport } from "./storage/exchange";
import FormulaCard from "./components/FormulaCard";
import { formatNumber } from "./engine/math";

function makeFormula(partial?: Partial<Formula>): Formula {
  return {
    id: newId(),
    latex: "",
    note: "",
    variables: {},
    targetUnit: "",
    createdAt: Date.now(),
    revision: 1,
    refs: [],
    ...partial,
  };
}

/** 影响计算结果的字段；这些字段变更要递增 revision */
const CONTENT_KEYS = ["latex", "variables", "targetUnit", "refs"] as const;

export default function App() {
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 启动时读取 IndexedDB（db.all 会规整旧版本数据，补齐 revision/refs）
  useEffect(() => {
    db.all()
      .then((rows) => setFormulas(rows))
      .catch((e) => setNotice(`读取本地存储失败：${(e as Error).message}`))
      .finally(() => setLoaded(true));
  }, []);

  // 沿引用依赖图整笔记重算；分析结果同时回写引用版本对齐与最后有效快照
  const analysis = useMemo(
    () => analyzeNotebook(formulas, (id) => {
      const i = formulas.findIndex((f) => f.id === id);
      if (i < 0) return id;
      const f = formulas[i];
      return `#${i + 1}${f.note ? `（${f.note}）` : ""}`;
    }),
    [formulas],
  );

  // 分析产生的引用对齐/快照回写 + 沿链版本传播，合并回状态（不在这里再做内容版本递增）
  const syncTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    let changed = false;
    const merged = formulas.map((f, i) => {
      const e = analysis.entries[i];
      if (!e) return f;
      const refsChanged = e.formula !== f && e.formula.refs !== f.refs;
      if (e.revisionBump || refsChanged) {
        changed = true;
        return {
          ...f,
          refs: e.formula.refs,
          // 来源沿链变化导致的传播性升版（与用户编辑造成的内容升版互斥，每轮仅一次）
          revision: e.revisionBump ? f.revision + 1 : f.revision,
        };
      }
      return f;
    });
    if (!changed) return;
    window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => setFormulas(merged), 0);
  }, [analysis, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // 变更防抖写入（每条公式独立持久化，互不影响）
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      db.bulkPut(formulas).catch((e) => setNotice(`保存失败：${(e as Error).message}`));
    }, 300);
  }, [formulas, loaded]);

  const update = useCallback((id: string, patch: Partial<Formula>) => {
    setFormulas((fs) => fs.map((f) => {
      if (f.id !== id) return f;
      const bumpsRevision = (Object.keys(patch) as (keyof Formula)[]).some((k) =>
        (CONTENT_KEYS as readonly string[]).includes(k));
      return { ...f, ...patch, revision: bumpsRevision ? f.revision + 1 : f.revision };
    }));
  }, []);

  // 引用保存前校验（名称/来源/完整环路）；不通过则拒绝，任何公式都不改写
  const validateFor = useCallback((id: string, nextRefs: RefBinding[]): string[] => {
    const v = validateRefs(formulas, id, nextRefs);
    return v.errors;
  }, [formulas]);

  const setRefs = useCallback((id: string, refs: RefBinding[]) => {
    // validateRefs 已在 RefEditor 交互时通过；这里再兜底一次，避免绕过 UI 的调用留下半条引用
    if (!validateRefs(formulas, id, refs).ok) return;
    update(id, { refs });
  }, [formulas, update]);

  const remove = useCallback(async (id: string) => {
    // 删除来源不破坏下游绑定：引用变为“未解析/阻塞”，最后有效快照保留可查
    setFormulas((fs) => fs.filter((f) => f.id !== id));
    await db.delete(id).catch(() => undefined);
  }, []);

  const add = () => setFormulas((fs) => [...fs, makeFormula()]);

  const addExample = (kind: "unit" | "degC" | "angle" | "dimErr" | "divZero" | "speedRef") => {
    if (kind === "speedRef") {
      // 验收示例 1：长度/时间公式发布速度 → 另一公式引用并换算为 km/h
      const length = makeFormula({
        latex: "s",
        note: "路程（发布长度）",
        variables: { s: { value: "100", unit: "m" } },
        targetUnit: "",
      });
      const time = makeFormula({
        latex: "t",
        note: "耗时（发布时间）",
        variables: { t: { value: "4", unit: "s" } },
        targetUnit: "",
      });
      const speed = makeFormula({
        latex: "\\frac{L}{T}",
        note: "速度（引用长度/时间）",
        variables: {},
        targetUnit: "",
        refs: [
          { name: "L", sourceId: length.id, sourceRevision: 1 },
          { name: "T", sourceId: time.id, sourceRevision: 1 },
        ],
      });
      const converted = makeFormula({
        latex: "v",
        note: "速度换算 km/h（引用上一条）",
        variables: {},
        targetUnit: "km/h",
        refs: [{ name: "v", sourceId: speed.id, sourceRevision: 1 }],
      });
      setFormulas((fs) => [...fs, length, time, speed, converted]);
      return;
    }
    const presets: Record<string, Formula> = {
      unit: makeFormula({
        latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
        note: "匀变速直线运动位移",
        variables: {
          v: { value: "2", unit: "m/s" },
          t: { value: "3", unit: "s" },
          a: { value: "4", unit: "m/s^2" },
        },
        targetUnit: "m",
      }),
      degC: makeFormula({
        latex: "T_1+T_2",
        note: "摄氏度直接相加 —— 应提示偏移温标歧义并标记未验证",
        variables: {
          T_1: { value: "10", unit: "degC" },
          T_2: { value: "5", unit: "degC" },
        },
        targetUnit: "",
      }),
      angle: makeFormula({
        latex: "\\theta+\\alpha",
        note: "度与弧度相加 —— 量纲兼容，自动换算",
        variables: {
          theta: { value: "1", unit: "rad" },
          alpha: { value: "180", unit: "deg" },
        },
        targetUnit: "deg",
      }),
      dimErr: makeFormula({
        latex: "(a+b)\\cdot c",
        note: "m 与 kg 相加 —— 应定位到括号内的 + 节点",
        variables: {
          a: { value: "1", unit: "m" },
          b: { value: "2", unit: "kg" },
          c: { value: "3", unit: "" },
        },
        targetUnit: "",
      }),
      divZero: makeFormula({
        latex: "x/y",
        note: "除零 —— 必须明确报错，不产生 Infinity",
        variables: {
          x: { value: "10", unit: "m" },
          y: { value: "0", unit: "s" },
        },
        targetUnit: "",
      }),
    };
    setFormulas((fs) => [...fs, presets[kind]]);
  };

  const onExport = () => {
    if (formulas.length === 0) { setNotice("当前没有可导出的公式"); return; }
    // 导出使用分析后（已对齐版本/快照）的公式
    downloadJSON(buildExport(analysis.entries.map((e) => e.formula)));
  };

  const onImportFile = async (file: File) => {
    const text = await file.text();
    const { formulas: imported, errors, unresolvedRefs, reconnectedExisting, reconnectedImported } =
      parseImport(text, new Set(formulas.map((f) => f.id)));
    if (imported.length === 0) {
      setNotice(errors[0] ?? "文件中没有可导入的公式");
      return;
    }
    setFormulas((fs) => [...fs, ...imported]);
    const parts = [`已导入 ${imported.length} 条公式`];
    if (reconnectedImported) parts.push(`${reconnectedImported} 条引用已重连到导入副本`);
    if (reconnectedExisting) parts.push(`${reconnectedExisting} 条引用已重连到笔记本内同名公式`);
    if (unresolvedRefs.length) parts.push(`${unresolvedRefs.length} 条引用未解析（下游将标记阻塞，不影响其他公式）`);
    if (errors.length) parts.push(`${errors.length} 条记录被跳过（${errors[0]}）`);
    setNotice(parts.join("；"));
  };

  // 可作为引用来源的已验证公式（量纲明确），含当前结果摘要
  const sources = useMemo(() => analysis.entries
    .filter((e) => e.published)
    .map((e) => {
      const idx = formulas.findIndex((f) => f.id === e.formula.id);
      const f = e.formula;
      return {
        id: f.id,
        label: `#${idx + 1}${f.note ? `（${f.note}）` : ""}`,
        resultText: e.published
          ? `${formatNumber(e.published.value)} ${e.published.unit || "无量纲"} · v${e.published.revision}`
          : "",
      };
    }), [analysis, formulas]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>量纲检查笔记本</h1>
        <p className="subtitle">
          本地运行 · 数据仅保存在本浏览器（IndexedDB）· 支持 + − × ÷、幂、常用单位换算与“已发布结果引用”
        </p>
        <div className="actions">
          <button type="button" onClick={add}>＋ 新建公式</button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={() => addExample("speedRef")}>示例：引用发布速度→km/h</button>
          <button type="button" className="ghost" onClick={() => addExample("unit")}>示例：单位运算</button>
          <button type="button" className="ghost" onClick={() => addExample("degC")}>示例：摄氏温标</button>
          <button type="button" className="ghost" onClick={() => addExample("angle")}>示例：角度弧度</button>
          <button type="button" className="ghost" onClick={() => addExample("dimErr")}>示例：量纲错误</button>
          <button type="button" className="ghost" onClick={() => addExample("divZero")}>示例：除零</button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={onExport}>导出 JSON</button>
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>导入 JSON</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              e.target.value = "";
            }}
          />
        </div>
        {notice && <div className="notice">{notice}</div>}
      </header>

      <main>
        {!loaded ? (
          <p className="muted">正在加载本地笔记…</p>
        ) : formulas.length === 0 ? (
          <div className="empty-state">
            <p>还没有公式。点击「新建公式」或加载一个示例开始。</p>
            <p className="muted small">
              规则：未赋值变量与除零都会明确报错（不会自动取零）；
              摄氏/华氏温标的四则运算、未列出的函数等会标记为「未验证」，需要人工确认。
              一条「已验证」公式的结果可以被其他公式引用为派生变量，上游出错或删除时下游进入阻塞而非使用旧值。
            </p>
          </div>
        ) : (
          analysis.entries.map((entry, i) => (
            <FormulaCard
              key={entry.formula.id}
              formula={entry.formula}
              entry={entry}
              index={i}
              sources={sources}
              validateRefs={(next) => validateFor(entry.formula.id, next)}
              onChange={(patch) => update(entry.formula.id, patch)}
              onRefsChange={(refs) => setRefs(entry.formula.id, refs)}
              onDelete={() => void remove(entry.formula.id)}
            />
          ))
        )}
      </main>

      <footer className="footer">
        <p>
          红色 = 明确错误（量纲不兼容、未赋值、除零、语法错误）；橙色 = 超出首版支持范围，结果未验证；
          紫色 = 引用阻塞（上游错误/未验证/删除/循环，不使用旧值）；蓝色 = 已对齐来源版本的派生变量。
          普通公式彼此独立；引用沿依赖图逐层重算，历史快照仅供查看。
        </p>
      </footer>
    </div>
  );
}
