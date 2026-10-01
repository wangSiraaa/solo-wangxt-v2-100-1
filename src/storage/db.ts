// IndexedDB 本地持久化。无服务器，所有数据仅保存在浏览器本地。
import type { Formula } from "../engine/types";

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

export const db = {
  async all(): Promise<Formula[]> {
    const rows = await tx<Formula[]>("readonly", (s) => s.getAll() as IDBRequest<Formula[]>);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
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
