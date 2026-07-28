/**
 * StorageManager - IndexedDB wrapper for persistent storage
 * Simple key-value API over three object stores: trees, audit, merge
 *
 * Design:
 * - Data lives in RAM after load; IDB is just persistence
 * - Reads are async (IDB requirement)
 * - Writes are fire-and-forget: set() returns Promise but callers don't need to await
 * - flush() waits for all pending writes (call before export/switchTree)
 */

const DB_NAME = 'strom-db';
// v2: added the 'snapshots' store (versioned backups).
// v3: added the 'fileHandles' store (File System Access handles per tree).
// v4: added the 'shareBaselines' store (change-packet baselines per exportId).
// v5: added the 'recovery' store (write-ahead records for destructive restores).
// onupgradeneeded creates any missing store, so existing databases gain it on
// the next open.
export const DB_VERSION = 5;

export const STORES = ['trees', 'audit', 'merge', 'snapshots', 'fileHandles', 'shareBaselines', 'recovery'] as const;
export type StoreName = typeof STORES[number];

export interface StoredTreeRecord<T = unknown> {
    __stromTreeRecord: 1;
    revision: number;
    updatedAt: string;
    payload: T;
}

export function isStoredTreeRecord(value: unknown): value is StoredTreeRecord {
    return !!value && typeof value === 'object'
        && (value as StoredTreeRecord).__stromTreeRecord === 1
        && Number.isInteger((value as StoredTreeRecord).revision)
        && 'payload' in value;
}

export class TreeRevisionConflictError extends Error {
    constructor(
        public readonly treeId: string,
        public readonly expectedRevision: number,
        public readonly actualRevision: number,
    ) {
        super(`Tree ${treeId} changed in another tab (expected revision ${expectedRevision}, found ${actualRevision})`);
        this.name = 'TreeRevisionConflictError';
    }
}

class StorageManagerClass {
    private db: IDBDatabase | null = null;
    private pendingWrites: Promise<void>[] = [];

    /**
     * Open/create the database with all object stores
     */
    async init(): Promise<void> {
        if (this.db) return;

        return new Promise<void>((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = () => {
                const db = request.result;
                for (const store of STORES) {
                    if (!db.objectStoreNames.contains(store)) {
                        db.createObjectStore(store);
                    }
                }
            };

            request.onsuccess = () => {
                this.db = request.result;
                this.db.onversionchange = () => {
                    this.db?.close();
                    this.db = null;
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('strom:storage-version-change'));
                    }
                };
                resolve();
            };

            request.onerror = () => {
                console.error('Failed to open IndexedDB:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Read a value from an object store
     */
    async get<T>(store: StoreName, key: string): Promise<T | null> {
        if (!this.db) throw new Error('StorageManager not initialized');

        return new Promise<T | null>((resolve, reject) => {
            const tx = this.db!.transaction(store, 'readonly');
            const req = tx.objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Write a value to an object store (fire-and-forget)
     * Returns a Promise, but callers don't need to await it.
     * The write is tracked internally; use flush() to wait for all pending writes.
     */
    set(store: StoreName, key: string, value: unknown): Promise<void> {
        if (!this.db) throw new Error('StorageManager not initialized');

        const promise = new Promise<void>((resolve, reject) => {
            const tx = this.db!.transaction(store, 'readwrite');
            tx.objectStore(store).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        this.pendingWrites.push(promise);
        // Clean up resolved promises
        promise.finally(() => {
            const idx = this.pendingWrites.indexOf(promise);
            if (idx >= 0) this.pendingWrites.splice(idx, 1);
        });

        return promise;
    }

    /**
     * Delete a key from an object store
     */
    async delete(store: StoreName, key: string): Promise<void> {
        if (!this.db) throw new Error('StorageManager not initialized');

        return new Promise<void>((resolve, reject) => {
            const tx = this.db!.transaction(store, 'readwrite');
            tx.objectStore(store).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Get all keys in an object store
     */
    async keys(store: StoreName): Promise<string[]> {
        if (!this.db) throw new Error('StorageManager not initialized');

        return new Promise<string[]>((resolve, reject) => {
            const tx = this.db!.transaction(store, 'readonly');
            const req = tx.objectStore(store).getAllKeys();
            req.onsuccess = () => resolve(req.result.map(k => String(k)));
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Get all values in an object store.
     */
    async getAll<T>(store: StoreName): Promise<T[]> {
        if (!this.db) throw new Error('StorageManager not initialized');

        return new Promise<T[]>((resolve, reject) => {
            const tx = this.db!.transaction(store, 'readonly');
            const req = tx.objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result as T[]);
            req.onerror = () => reject(req.error);
        });
    }

    /** Key/value entries, used by the complete archive contract. */
    async entries<T = unknown>(store: StoreName): Promise<Array<[string, T]>> {
        if (!this.db) throw new Error('StorageManager not initialized');
        return new Promise<Array<[string, T]>>((resolve, reject) => {
            const tx = this.db!.transaction(store, 'readonly');
            const objectStore = tx.objectStore(store);
            const keys = objectStore.getAllKeys();
            const values = objectStore.getAll();
            tx.oncomplete = () => resolve(keys.result.map((key, index) => [String(key), values.result[index] as T]));
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('entries transaction aborted'));
        });
    }

    /** Read a legacy raw tree or a revision-wrapped tree uniformly. */
    async getTreeRecord<T = unknown>(treeId: string): Promise<{ payload: T; revision: number } | null> {
        const value = await this.get<T | StoredTreeRecord<T>>('trees', treeId);
        if (value === null) return null;
        return isStoredTreeRecord(value)
            ? { payload: value.payload as T, revision: value.revision }
            : { payload: value as T, revision: 0 };
    }

    /**
     * Atomic compare-and-swap. This is the multi-tab safety boundary: a stale
     * tab cannot overwrite a revision committed by another tab or a restore.
     */
    async compareAndSwapTree<T>(treeId: string, expectedRevision: number, payload: T): Promise<number> {
        if (!this.db) throw new Error('StorageManager not initialized');
        return new Promise<number>((resolve, reject) => {
            const tx = this.db!.transaction('trees', 'readwrite');
            const store = tx.objectStore('trees');
            const read = store.get(treeId);
            let nextRevision = expectedRevision + 1;
            read.onsuccess = () => {
                const current = read.result;
                // New trees are inserted before their first CAS save. A missing
                // record here therefore means deletion in another tab, not a
                // fresh tree; treating it as revision 0 would resurrect it.
                const actualRevision = current === undefined
                    ? -1
                    : isStoredTreeRecord(current) ? current.revision : 0;
                if (actualRevision !== expectedRevision) {
                    tx.abort();
                    reject(new TreeRevisionConflictError(treeId, expectedRevision, actualRevision));
                    return;
                }
                const record: StoredTreeRecord<T> = {
                    __stromTreeRecord: 1,
                    revision: nextRevision,
                    updatedAt: new Date().toISOString(),
                    payload,
                };
                store.put(record, treeId);
            };
            read.onerror = () => reject(read.error);
            tx.oncomplete = () => resolve(nextRevision);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => {
                // A deliberate conflict already rejected with its richer error.
                if (tx.error) reject(tx.error);
            };
        });
    }

    /** Replace selected stores in one IndexedDB transaction after verification. */
    async replaceStoresAtomically(
        replacements: Partial<Record<StoreName, Array<[string, unknown]>>>,
    ): Promise<void> {
        if (!this.db) throw new Error('StorageManager not initialized');
        const stores = Object.keys(replacements) as StoreName[];
        if (stores.length === 0) return;
        return new Promise<void>((resolve, reject) => {
            const tx = this.db!.transaction(stores, 'readwrite');
            try {
                for (const storeName of stores) {
                    const store = tx.objectStore(storeName);
                    store.clear();
                    for (const [key, value] of replacements[storeName] ?? []) store.put(value, key);
                }
            } catch (error) {
                tx.abort();
                reject(error);
                return;
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('restore transaction aborted'));
        });
    }

    /**
     * Wait for all pending writes to complete
     * Call before operations that need data consistency (export, switchTree)
     */
    async flush(): Promise<void> {
        if (this.pendingWrites.length === 0) return;
        await Promise.all([...this.pendingWrites]);
    }

}

export const StorageManager = new StorageManagerClass();
