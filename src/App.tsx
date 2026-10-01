import { useCallback, useEffect, useRef, useState } from "react";
import type { Formula } from "./engine/types";
import { db, newId } from "./storage/db";
import { buildExport, downloadJSON, parseImport } from "./storage/exchange";
import FormulaCard from "./components/FormulaCard";

function makeFormula(partial?: Partial<Formula>): Formula {
  return {
    id: newId(),
    latex: "",
    note: "",
    variables: {},
    targetUnit: "",
    createdAt: Date.now(),
    ...partial,
  };
}

export default function App() {
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 启动时读取 IndexedDB
  useEffect(() => {
    db.all()
      .then((rows) => setFormulas(rows))
      .catch((e) => setNotice(`读取本地存储失败：${(e as Error).message}`))
      .finally(() => setLoaded(true));
  }, []);

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
    setFormulas((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const remove = useCallback(async (id: string) => {
    setFormulas((fs) => fs.filter((f) => f.id !== id));
    await db.delete(id).catch(() => undefined);
  }, []);

  const add = () => setFormulas((fs) => [...fs, makeFormula()]);

  const addExample = (kind: "unit" | "degC" | "angle" | "dimErr" | "divZero") => {
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
    downloadJSON(buildExport(formulas));
  };

  const onImportFile = async (file: File) => {
    const text = await file.text();
    const { formulas: imported, errors } = parseImport(text, new Set(formulas.map((f) => f.id)));
    if (imported.length === 0) {
      setNotice(errors[0] ?? "文件中没有可导入的公式");
      return;
    }
    setFormulas((fs) => [...fs, ...imported]);
    setNotice(`已导入 ${imported.length} 条公式${errors.length ? `；${errors.length} 条被跳过（${errors[0]}）` : ""}`);
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>量纲检查笔记本</h1>
        <p className="subtitle">
          本地运行 · 数据仅保存在本浏览器（IndexedDB）· 首版支持 + − × ÷、幂与常用单位换算
        </p>
        <div className="actions">
          <button type="button" onClick={add}>＋ 新建公式</button>
          <span className="sep" />
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
            </p>
          </div>
        ) : (
          formulas.map((f, i) => (
            <FormulaCard
              key={f.id}
              formula={f}
              index={i}
              onChange={(patch) => update(f.id, patch)}
              onDelete={() => void remove(f.id)}
            />
          ))
        )}
      </main>

      <footer className="footer">
        <p>
          红色 = 明确错误（量纲不兼容、未赋值、除零、语法错误）；橙色 = 超出首版支持范围，结果未验证。
          公式之间完全独立，一条出错不会影响其他公式。
        </p>
      </footer>
    </div>
  );
}
