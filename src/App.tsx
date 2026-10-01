import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Formula } from "./engine/types";
import {
  addReference, normalizeFormulas, removeReference, resolveGraph,
} from "./engine/graph";
import { db, newId } from "./storage/db";
import { buildExport, downloadJSON, parseImport } from "./storage/exchange";
import FormulaCard from "./components/FormulaCard";

/** 会影响计算结果的字段：变化时内容版本 +1（备注变化不升版） */
const CONTENT_KEYS = ["latex", "variables", "targetUnit"] as const;

function makeFormula(partial?: Partial<Formula>): Formula {
  return {
    id: newId(),
    latex: "",
    note: "",
    variables: {},
    targetUnit: "",
    refs: {},
    version: 1,
    createdAt: Date.now(),
    ...partial,
  };
}

export default function App() {
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 启动时读取 IndexedDB（旧数据补齐 version/refs）
  useEffect(() => {
    db.all()
      .then((rows) => setFormulas(normalizeFormulas(rows)))
      .catch((e) => setNotice(`读取本地存储失败：${(e as Error).message}`))
      .finally(() => setLoaded(true));
  }, []);

  // 依赖图解析：沿链路重算、阻塞传播、刷新有效快照（纯计算，无副作用）
  const graph = useMemo(() => (loaded ? resolveGraph(formulas) : null), [formulas, loaded]);

  // 快照补丁回写状态（仅当引用的来源结果发生变化；不升版本，避免循环触发）
  useEffect(() => {
    if (!graph || graph.snapshotPatches.size === 0) return;
    setFormulas((fs) =>
      fs.map((f) => {
        const patched = graph.snapshotPatches.get(f.id);
        return patched ? { ...f, refs: patched } : f;
      }),
    );
  }, [graph]);

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
    setFormulas((fs) => {
      const prev = fs.find((f) => f.id === id);
      if (!prev) return fs;
      const bumps = CONTENT_KEYS.some(
        (k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(prev[k]),
      );
      // refs 只能通过专门的添加/删除操作改变，update 中忽略
      return fs.map((f) => {
        if (f.id !== id) return f;
        const next = { ...f, ...patch, refs: f.refs };
        return bumps ? { ...next, version: f.version + 1 } : next;
      });
    });
  }, []);

  const remove = useCallback(async (id: string) => {
    // 删除来源公式后，其下游在下一轮 resolveGraph 中进入“阻塞（来源已删除）”，快照仍保留
    setFormulas((fs) => fs.filter((f) => f.id !== id));
    await db.delete(id).catch(() => undefined);
  }, []);

  const add = () => setFormulas((fs) => [...fs, makeFormula()]);

  /** 建立已发布结果引用；保存前完成别名/来源/循环全部校验，失败时不改任何公式 */
  const onAddRef = useCallback((targetId: string, sourceId: string, alias: string) => {
    const res = addReference(formulas, { targetId, sourceId, alias });
    if (!res.ok) {
      setNotice(`引用未建立：${res.error}`);
      return;
    }
    setFormulas(res.formulas);
    setNotice("引用已建立：上游结果将作为派生变量沿链路自动重算");
  }, [formulas]);

  const onRemoveRef = useCallback((targetId: string, alias: string) => {
    setFormulas((fs) => removeReference(fs, targetId, alias));
  }, []);

  /** 把引用别名以安全 LaTeX 写法追加到表达式（含下划线 → 花括号下标） */
  const onInsertAlias = useCallback((targetId: string, alias: string) => {
    const us = alias.indexOf("_");
    const tex = us < 0 ? alias : `${alias.slice(0, us)}_{${alias.slice(us + 1)}}`;
    setFormulas((fs) =>
      fs.map((f) => {
        if (f.id !== targetId) return f;
        const latex = f.latex.trim() ? `${f.latex.trim()}+${tex}` : tex;
        return { ...f, latex, version: f.version + 1 };
      }),
    );
  }, []);

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
    const { formulas: imported, errors, notices } = parseImport(
      text,
      new Set(formulas.map((f) => f.id)),
      { afterCreatedAt: Math.max(0, ...formulas.map((f) => f.createdAt)) },
    );
    if (imported.length === 0) {
      setNotice(errors[0] ?? "文件中没有可导入的公式");
      return;
    }
    setFormulas((fs) => [...fs, ...imported]);
    const parts = [`已导入 ${imported.length} 条公式`];
    if (errors.length) parts.push(`${errors.length} 条记录有问题（${errors[0]}）`);
    if (notices.length) parts.push(notices.join("；"));
    setNotice(parts.join("；"));
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>量纲检查笔记本</h1>
        <p className="subtitle">
          本地运行 · 数据仅保存在本浏览器（IndexedDB）· 支持 + − × ÷、幂、常用单位换算
          · 可把其他公式<b>已验证的结果</b>作为派生变量引用（自动沿链路重算）
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
              只有「已验证」且量纲明确的结果才能发布为引用；上游出错时下游自动阻塞，绝不拿旧值冒充。
            </p>
          </div>
        ) : (
          formulas.map((f, i) => (
            <FormulaCard
              key={f.id}
              formula={f}
              index={i}
              allFormulas={formulas}
              runtime={graph?.runtimes.get(f.id)}
              allRuntimes={graph?.runtimes ?? new Map()}
              onChange={(patch) => update(f.id, patch)}
              onDelete={() => void remove(f.id)}
              onAddRef={(sourceId, alias) => onAddRef(f.id, sourceId, alias)}
              onRemoveRef={(alias) => onRemoveRef(f.id, alias)}
              onInsertAlias={(aliasName) => onInsertAlias(f.id, aliasName)}
            />
          ))
        )}
      </main>

      <footer className="footer">
        <p>
          红色 = 明确错误（量纲不兼容、未赋值、除零、语法错误、引用阻塞）；橙色 = 超出首版支持范围，结果未验证；
          <span style={{ color: "#1a7f37" }}>绿色下划线</span> = 引用自其他公式的已发布结果（带“引”来源标记）。
          普通公式彼此独立；引用关系形成依赖图，上游错误沿链路阻塞下游并保留最后有效快照。
        </p>
      </footer>
    </div>
  );
}
