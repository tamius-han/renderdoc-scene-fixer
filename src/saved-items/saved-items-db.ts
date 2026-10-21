import type { SavedItemMeta, SavedItemPayload } from "./saved-item.types";

/**
 * Browser-side persistence for saved items (IndexedDB - localStorage can't
 * hold geometry and texture files).
 *
 * Two object stores share one key (the item id):
 *  - "meta":     name, counts, transforms. Small; rewritten whenever an item is
 *                moved/renamed.
 *  - "payloads": geometry arrays + texture Blobs. Big; written once, when the
 *                item is saved.
 * Both are written in a single transaction, so an item is never half-saved.
 */

const DB_NAME = "renderdoc-scene-fixer";
const DB_VERSION = 1;
const META_STORE = "saved-item-meta";
const PAYLOAD_STORE = "saved-item-payloads";

let dbPromise: Promise<IDBDatabase> | null = null;

export function isSavedItemStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!isSavedItemStorageAvailable()) {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PAYLOAD_STORE)) db.createObjectStore(PAYLOAD_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema (or the browser evicting storage)
      // closes this connection - drop the cached handle so the next call
      // reopens rather than failing forever.
      db.onclose = () => (dbPromise = null);
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked by another tab."));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/** Resolves when the transaction has actually committed (not merely when the
 * last request succeeded) - a quota error surfaces on the transaction. */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted (storage full?)."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

/** Every saved item's metadata, oldest first. */
export async function listSavedItemMeta(): Promise<SavedItemMeta[]> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, "readonly");
  const all = await requestResult<SavedItemMeta[]>(tx.objectStore(META_STORE).getAll());
  return all.sort((a, b) => a.seq - b.seq);
}

export async function getSavedItemPayload(id: string): Promise<SavedItemPayload | null> {
  const db = await openDb();
  const tx = db.transaction(PAYLOAD_STORE, "readonly");
  const payload = await requestResult<SavedItemPayload | undefined>(tx.objectStore(PAYLOAD_STORE).get(id));
  return payload ?? null;
}

/** Writes a new item's metadata and payload atomically. */
export async function putSavedItem(meta: SavedItemMeta, payload: SavedItemPayload): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META_STORE, PAYLOAD_STORE], "readwrite");
  tx.objectStore(META_STORE).put(meta);
  tx.objectStore(PAYLOAD_STORE).put(payload);
  await transactionDone(tx);
}

/** Rewrites only the (small) metadata - used after a transform or rename. */
export async function putSavedItemMeta(...metas: SavedItemMeta[]): Promise<void> {
  if (metas.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(META_STORE, "readwrite");
  const store = tx.objectStore(META_STORE);
  for (const meta of metas) store.put(meta);
  await transactionDone(tx);
}

export async function deleteSavedItems(...ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const tx = db.transaction([META_STORE, PAYLOAD_STORE], "readwrite");
  for (const id of ids) {
    tx.objectStore(META_STORE).delete(id);
    tx.objectStore(PAYLOAD_STORE).delete(id);
  }
  await transactionDone(tx);
}
