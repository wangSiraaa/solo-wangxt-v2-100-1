// IndexedDB 本地持久化。无服务器，所有数据仅保存在浏览器本地。
// 引用（refs）与版本号（revision）随公式一同存储；旧版数据加载时做前向迁移。
import type { Formula, RefBinding } from "../engine/types";

const DB_NAME = "dimension-notebook";
const STORE = "formulas";
const VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => { resolve(req.result); db.close(); };
        req.onerror = () => { reject(req.error); db.close(); };
      }),
  );
}

/** 规整/迁移一条来自旧版本或外部导入的公式记录，保证引用与版本字段可用 */
export function normalizeFormula(raw: unknown): Formula | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Formula>;
  if (typeof r.id !== "string" || typeof r.latex !== "string") return null;

  const refs: RefBinding[] = Array.isArray(r.refs)
    ? r.refs.filter((x): x is RefBinding =>
        !!x && typeof x === "object" &&
        typeof (x as RefBinding).name === "string" &&
        typeof (x as RefBinding).sourceId === "string")
      .map((x) => ({
        name: x.name,
        sourceId: x.sourceId,
        sourceRevision: typeof x.sourceRevision === "number" ? x.sourceRevision : 0,
        snapshot: x.snapshot && typeof x.snapshot === "object" ? {
          value: Number(x.snapshot.value),
          unit: String(x.snapshot.unit ?? ""),
          sourceRevision: Number(x.snapshot.sourceRevision ?? 0),
          capturedAt: Number(x.snapshot.capturedAt ?? 0),
        } : undefined,
      }))
    : [];

  return {
    id: r.id,
    latex: r.latex,
    note: typeof r.note === "string" ? r.note : "",
    variables: r.variables && typeof r.variables === "object" ? r.variables : {},
    targetUnit: typeof r.targetUnit === "string" ? r.targetUnit : "",
    createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
    revision: typeof r.revision === "number" && r.revision > 0 ? r.revision : 1,
    refs,
  };
}

export const db = {
  async all(): Promise<Formula[]> {
    const rows = await tx<Formula[]>("readonly", (s) => s.getAll() as IDBRequest<Formula[]>);
    return rows
      .map(normalizeFormula)
      .filter((f): f is Formula => f !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  },
  async put(formula: Formula): Promise<void> {
    await tx<IDBValidKey>("readwrite", (s) => s.put(formula));
  },
  async bulkPut(formulas: Formula[]): Promise<void> {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      for (const f of formulas) store.put(f);
      t.oncomplete = () => { resolve(); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
    });
  },
  async delete(id: string): Promise<void> {
    await tx<undefined>("readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
  },
  async clear(): Promise<void> {
    await tx<undefined>("readwrite", (s) => s.clear() as IDBRequest<undefined>);
  },
};

export function newId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
