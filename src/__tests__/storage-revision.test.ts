import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import {
    StorageManager,
    TreeRevisionConflictError,
    isStoredTreeRecord,
} from '../storage.js';
import {
    ARCHIVE_STORES,
    buildCompleteArchive,
    canonicalStringify,
    recoverInterruptedArchiveRestore,
    sha256Text,
} from '../complete-archive.js';
import { TreeManager } from '../tree-manager.js';
import { createSnapshot } from '../snapshots.js';
import type { StromData, TreeId, TreeIndex } from '../types.js';

type PrivateStorage = { db: IDBDatabase | null; pendingWrites: Promise<void>[] };

async function resetDatabase(): Promise<void> {
    const manager = StorageManager as unknown as PrivateStorage;
    manager.db?.close();
    manager.db = null;
    manager.pendingWrites = [];
    await new Promise<void>((resolve, reject) => {
        const request = fakeIndexedDB.deleteDatabase('strom-db');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('delete blocked'));
    });
}

beforeEach(async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: fakeIndexedDB });
    await resetDatabase();
    await StorageManager.init();
});

afterEach(resetDatabase);

describe('revision compare-and-swap', () => {
    it('rejects a stale tab without changing the committed payload', async () => {
        await StorageManager.set('trees', 'tree', { value: 'base' });
        const first = await StorageManager.getTreeRecord<{ value: string }>('tree');
        expect(first?.revision).toBe(0);
        expect(await StorageManager.compareAndSwapTree('tree', 0, { value: 'tab-a' })).toBe(1);
        await expect(StorageManager.compareAndSwapTree('tree', 0, { value: 'stale-tab-b' }))
            .rejects.toBeInstanceOf(TreeRevisionConflictError);
        const stored = await StorageManager.get<unknown>('trees', 'tree');
        expect(isStoredTreeRecord(stored)).toBe(true);
        expect((stored as { payload: { value: string } }).payload.value).toBe('tab-a');
    });

    it('atomically replaces several stores', async () => {
        await StorageManager.set('trees', 'old', { value: 1 });
        await StorageManager.set('audit', 'old', { value: 1 });
        await StorageManager.replaceStoresAtomically({
            trees: [['new', { value: 2 }]], audit: [['new', { value: 2 }]],
        });
        expect(await StorageManager.keys('trees')).toEqual(['new']);
        expect(await StorageManager.keys('audit')).toEqual(['new']);
    });

    it('aborts the whole replacement when one value cannot be cloned', async () => {
        await StorageManager.set('trees', 'safe', { value: 1 });
        await StorageManager.set('audit', 'safe', { value: 1 });
        await expect(StorageManager.replaceStoresAtomically({
            trees: [['new', { value: 2 }]],
            audit: [['broken', { fn: () => undefined }]],
        })).rejects.toThrow();
        expect(await StorageManager.keys('trees')).toEqual(['safe']);
        expect(await StorageManager.keys('audit')).toEqual(['safe']);
    });

    it('rejects a stale save after an archive restore changes the revision', async () => {
        await StorageManager.set('trees', 'tree', { value: 'before' });
        const staleRevision = (await StorageManager.getTreeRecord('tree'))!.revision;
        await StorageManager.replaceStoresAtomically({
            trees: [['tree', {
                __stromTreeRecord: 1, revision: 9,
                updatedAt: '2026-07-28T00:00:00.000Z', payload: { value: 'restored' },
            }]],
        });
        await expect(StorageManager.compareAndSwapTree('tree', staleRevision, { value: 'stale' }))
            .rejects.toBeInstanceOf(TreeRevisionConflictError);
        expect((await StorageManager.getTreeRecord<{ value: string }>('tree'))?.payload.value).toBe('restored');
    });

    it('does not resurrect a tree deleted by another tab', async () => {
        await StorageManager.set('trees', 'tree', { value: 'before' });
        const revision = (await StorageManager.getTreeRecord('tree'))!.revision;
        await StorageManager.delete('trees', 'tree');
        await expect(StorageManager.compareAndSwapTree('tree', revision, { value: 'stale' }))
            .rejects.toBeInstanceOf(TreeRevisionConflictError);
        expect(await StorageManager.get('trees', 'tree')).toBeNull();
    });

    it('closes its connection when another tab upgrades IndexedDB', async () => {
        const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = fakeIndexedDB.open('strom-db', 6);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('upgrade blocked'));
        });
        expect((StorageManager as unknown as PrivateStorage).db).toBeNull();
        upgraded.close();
    });

    it('preserves the persisted active tree when no startup override exists', () => {
        const first = 'first' as TreeId;
        const restored = 'first_restored_token_1' as TreeId;
        const tm = TreeManager as unknown as { index: TreeIndex };
        tm.index = {
            version: 1, activeTreeId: restored,
            trees: [first, restored].map(id => ({
                id, name: id, createdAt: '', lastModifiedAt: '',
                personCount: 0, partnershipCount: 0, sizeBytes: 0,
            })),
        };
        expect(TreeManager.getStartupTreeId()).toBe(restored);
    });

    it('rolls back an interrupted replace from the write-ahead recovery journal', async () => {
        const data: StromData = { version: 6, persons: {}, partnerships: {} };
        const treeId = 'safe-tree' as TreeId;
        const index: TreeIndex = {
            version: 1, activeTreeId: treeId,
            trees: [{
                id: treeId, name: 'Safe', createdAt: '2026-07-28T00:00:00.000Z',
                lastModifiedAt: '2026-07-28T00:00:00.000Z', personCount: 0,
                partnershipCount: 0, sizeBytes: 45,
            }],
        };
        const stores = Object.fromEntries(ARCHIVE_STORES.map(store => [store, []])) as unknown as Record<typeof ARCHIVE_STORES[number], Array<[string, unknown]>>;
        stores.trees = [['_index', index], [treeId, {
            __stromTreeRecord: 1, revision: 4,
            updatedAt: '2026-07-28T00:00:00.000Z', payload: data,
        }]];
        const before = await buildCompleteArchive(stores, []);
        await StorageManager.set('recovery', '_pending_archive_restore', {
            kind: 'archive-restore', createdAt: new Date().toISOString(), mode: 'replace', before,
        });
        await StorageManager.replaceStoresAtomically({ trees: [['corrupt', { value: true }]] });

        expect(await recoverInterruptedArchiveRestore()).toBe(true);
        expect(await StorageManager.keys('trees')).toEqual(['_index', 'safe-tree']);
        expect(await StorageManager.get('recovery', '_pending_archive_restore')).toBeNull();
    });

    it('keeps a verified deleted-tree recovery record outside the cascade', async () => {
        const tm = TreeManager as unknown as {
            initialized: boolean;
            index: TreeIndex;
            loadedRevisions: Map<TreeId, number>;
            saveQueues: Map<TreeId, Promise<void>>;
        };
        tm.initialized = false;
        tm.index = { version: 1, activeTreeId: null, trees: [] };
        tm.loadedRevisions = new Map();
        tm.saveQueues = new Map();
        await TreeManager.init();
        const treeId = TreeManager.getActiveTreeId()!;
        const data = await TreeManager.getTreeData(treeId);
        await createSnapshot(treeId, data!, 'pre-delete', 1_000);

        expect(await TreeManager.deleteTree(treeId)).toBe(true);
        expect((await StorageManager.entries<{ meta?: { treeId?: string } }>('snapshots'))
            .some(([, value]) => value.meta?.treeId === treeId)).toBe(false);
        const recovery = (await StorageManager.entries<Record<string, unknown>>('recovery'))
            .find(([key]) => key.startsWith(`deleted-tree:${treeId}:`));
        expect(recovery).toBeDefined();
        const record = recovery![1];
        const { sha256, ...payload } = record;
        expect(sha256).toBe(await sha256Text(canonicalStringify(payload)));
        expect((payload.metadata as { id: string }).id).toBe(treeId);
    });
});
