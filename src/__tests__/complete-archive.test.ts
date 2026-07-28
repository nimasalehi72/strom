import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
    ARCHIVE_STORES,
    buildCompleteArchive,
    canonicalStringify,
    parseCompleteArchive,
    planArchiveReplace,
    planArchiveRestoreAsNew,
    serializeCompleteArchive,
    verifyCompleteArchive,
    type CompleteArchive,
} from '../complete-archive.js';
import { SettingsManager } from '../settings.js';
import { migrateAndValidateData } from '../data.js';
import type { StoredTreeRecord } from '../storage.js';
import { toPersonId, type StromData, type TreeId, type TreeIndex, type TreeMetadata } from '../types.js';

const readFixture = (name: string): StromData => JSON.parse(
    readFileSync(join(process.cwd(), 'test', name), 'utf8'),
) as StromData;

function metadata(id: string, name: string, data: StromData): TreeMetadata {
    return {
        id: id as TreeId, name, createdAt: '2026-07-28T00:00:00.000Z',
        lastModifiedAt: '2026-07-28T00:00:00.000Z',
        personCount: Object.keys(data.persons).length,
        partnershipCount: Object.keys(data.partnerships).length,
        sizeBytes: JSON.stringify(data).length,
    };
}

async function archiveFor(data = readFixture('m1-schema-v6.json')): Promise<CompleteArchive> {
    const meta = metadata('tree_m1', 'M1 fixture', data);
    const index: TreeIndex = { version: 1, activeTreeId: meta.id, trees: [meta] };
    const record: StoredTreeRecord<StromData> = {
        __stromTreeRecord: 1, revision: 7, updatedAt: meta.lastModifiedAt, payload: data,
    };
    const stores = Object.fromEntries(ARCHIVE_STORES.map(store => [store, []])) as unknown as Record<typeof ARCHIVE_STORES[number], Array<[string, unknown]>>;
    stores.trees = [['_index', index], [meta.id, record]];
    stores.snapshots = [['snap1', { meta: { id: 'snap1', treeId: meta.id }, plain: JSON.stringify(data) }]];
    return buildCompleteArchive(stores, [['strom-settings', '{"theme":"dark"}']], new Date('2026-07-28T00:00:00.000Z'));
}

afterEach(() => vi.restoreAllMocks());

describe('complete archive verification and encryption', () => {
    it('verifies every store plus attachment byte digests', async () => {
        const archive = await archiveFor();
        const result = await verifyCompleteArchive(archive);
        expect(result).toEqual({ valid: true, errors: [], treeCount: 1, attachmentCount: 1 });
        expect(archive.manifest.attachments[0]).toMatchObject({
            path: expect.stringContaining('att_doc'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
    });

    it('detects a one-byte payload change before restore', async () => {
        const archive = await archiveFor();
        const record = archive.payload.stores.trees[1][1] as StoredTreeRecord<StromData>;
        record.payload.persons[toPersonId('p_child')].attachments![0].dataUrl += 'A';
        const result = await verifyCompleteArchive(archive);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('digest:trees');
        expect(result.errors).toContain('attachmentDigest');
    });

    it('rejects a manifest-valid archive whose attachment bytes are missing', async () => {
        const archive = await archiveFor(readFixture('m1-missing-attachment.json'));
        const result = await verifyCompleteArchive(archive);
        expect(result.valid).toBe(false);
        expect(result.errors.some(error => error.startsWith('attachmentData:'))).toBe(true);
    });

    it('round-trips a password-protected container and rejects a wrong password', async () => {
        vi.spyOn(SettingsManager, 'isEncryptionEnabled').mockReturnValue(false);
        const archive = await archiveFor();
        const serialized = await serializeCompleteArchive(archive, 'correct horse battery staple');
        expect(serialized).not.toContain('آرین');
        await expect(parseCompleteArchive(serialized, 'wrong')).rejects.toThrow();
        const parsed = await parseCompleteArchive(serialized, 'correct horse battery staple');
        expect(canonicalStringify(parsed)).toBe(canonicalStringify(archive));
    });

    it('refuses to serialize a complete archive without a password', async () => {
        await expect(serializeCompleteArchive(await archiveFor(), null))
            .rejects.toThrow('must be password protected');
    });
});

describe('staged restore plans', () => {
    it('migrates and restores the pinned M0 complex-family fixture semantically', async () => {
        const legacy = readFixture('m0-complex-family.json');
        const expected = migrateAndValidateData(legacy);
        const archive = await archiveFor(legacy);
        const plan = await planArchiveRestoreAsNew(archive, [], 'complex');
        const entries = new Map(plan.replacements.trees!);
        const index = entries.get('_index') as TreeIndex;
        const restored = entries.get(index.activeTreeId!) as StoredTreeRecord<StromData>;
        expect(canonicalStringify(restored.payload)).toBe(canonicalStringify(expected));
    });

    it('restore-as-new preserves existing trees, remaps IDs and selects the restored copy', async () => {
        const archive = await archiveFor();
        const currentData: StromData = { version: 6, persons: {}, partnerships: {} };
        const currentMeta = metadata('current', 'Current', currentData);
        const currentIndex: TreeIndex = { version: 1, activeTreeId: currentMeta.id, trees: [currentMeta] };
        const currentRecord: StoredTreeRecord<StromData> = {
            __stromTreeRecord: 1, revision: 3, updatedAt: currentMeta.lastModifiedAt, payload: currentData,
        };
        const plan = await planArchiveRestoreAsNew(
            archive, [['_index', currentIndex], [currentMeta.id, currentRecord]], 'fixed',
        );
        expect(plan.mode).toBe('as-new');
        const entries = new Map(plan.replacements.trees!);
        const index = entries.get('_index') as TreeIndex;
        expect(index.trees.map(tree => tree.name)).toEqual(['Current', 'M1 fixture (restored)']);
        expect(index.activeTreeId).not.toBe(currentMeta.id);
        const restored = entries.get(index.activeTreeId!) as StoredTreeRecord<StromData>;
        expect(restored.payload.persons[toPersonId('p_child')].attachments![0].dataUrl)
            .toBe(readFixture('m1-schema-v6.json').persons[toPersonId('p_child')].attachments![0].dataUrl);
        expect(plan.localStorage).toBeNull();
    });

    it('replace plan includes every contracted store and the archived active pointer', async () => {
        const archive = await archiveFor();
        const plan = await planArchiveReplace(archive);
        expect(Object.keys(plan.replacements).sort()).toEqual([...ARCHIVE_STORES].sort());
        expect(plan.activeTreeId).toBe('tree_m1');
        expect(plan.localStorage).toEqual([['strom-settings', '{"theme":"dark"}']]);
    });
});
