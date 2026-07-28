/** Verified, self-contained archive and staged restore contract. */

import {
    STROM_DATA_VERSION,
    SETTINGS_KEY,
    type StromData,
    type TreeId,
    type TreeIndex,
    type TreeMetadata,
} from './types.js';
import {
    StorageManager,
    type StoreName,
    type StoredTreeRecord,
    isStoredTreeRecord,
} from './storage.js';
import { TreeManager } from './tree-manager.js';
import { migrateAndValidateData } from './data.js';
import { isEncrypted, encrypt, decrypt, CryptoSession, type EncryptedData } from './crypto.js';
import { SettingsManager } from './settings.js';

export const COMPLETE_ARCHIVE_FORMAT = 'strom-complete-archive' as const;
export const COMPLETE_ARCHIVE_VERSION = 1;
export const ARCHIVE_STORES = ['trees', 'audit', 'merge', 'snapshots', 'shareBaselines'] as const;
export type ArchiveStoreName = typeof ARCHIVE_STORES[number];

export interface ArchiveAttachmentDigest {
    path: string;
    sha256: string;
    sizeBytes: number;
}

export interface CompleteArchive {
    format: typeof COMPLETE_ARCHIVE_FORMAT;
    archiveVersion: number;
    createdAt: string;
    dataVersion: number;
    manifest: {
        stores: Record<ArchiveStoreName, { records: number; sha256: string }>;
        localStorage: { records: number; sha256: string };
        attachments: ArchiveAttachmentDigest[];
        excluded: Array<{ scope: string; reason: string }>;
    };
    payload: {
        stores: Record<ArchiveStoreName, Array<[string, unknown]>>;
        localStorage: Array<[string, string]>;
    };
}

export interface ArchiveVerification {
    valid: boolean;
    errors: string[];
    treeCount: number;
    attachmentCount: number;
}

export interface ArchiveRestorePlan {
    mode: 'as-new' | 'replace';
    archiveSha256: string;
    replacements: Partial<Record<StoreName, Array<[string, unknown]>>>;
    localStorage: Array<[string, string]> | null;
    activeTreeId: TreeId | null;
    warnings: string[];
}

interface RecoveryJournal {
    kind: 'archive-restore';
    createdAt: string;
    mode: ArchiveRestorePlan['mode'];
    before: CompleteArchive | EncryptedData;
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonicalize(item)]));
    }
    return value;
}

export function canonicalStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

export async function sha256Text(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const sortedEntries = <T>(entries: Array<[string, T]>): Array<[string, T]> =>
    [...entries].sort(([a], [b]) => a.localeCompare(b));

function localStorageEntries(): Array<[string, string]> {
    if (typeof localStorage === 'undefined') return [];
    const entries: Array<[string, string]> = [];
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key || (key !== SETTINGS_KEY && !key.startsWith('strom-'))) continue;
        const value = localStorage.getItem(key);
        if (value !== null) entries.push([key, value]);
    }
    return sortedEntries(entries);
}

function treePayload(record: unknown): StromData | null {
    const payload = isStoredTreeRecord(record) ? record.payload : record;
    return payload && typeof payload === 'object' && !isEncrypted(payload)
        ? payload as StromData : null;
}

async function attachmentManifest(treeEntries: Array<[string, unknown]>): Promise<ArchiveAttachmentDigest[]> {
    const attachments: ArchiveAttachmentDigest[] = [];
    for (const [treeId, record] of treeEntries) {
        if (treeId === '_index') continue;
        const data = treePayload(record);
        if (!data) continue;
        for (const person of Object.values(data.persons ?? {})) {
            if (person.photo) {
                attachments.push({
                    path: `trees/${treeId}/persons/${person.id}/photo`,
                    sha256: await sha256Text(person.photo),
                    sizeBytes: new TextEncoder().encode(person.photo).byteLength,
                });
            }
            for (const attachment of person.attachments ?? []) {
                attachments.push({
                    path: `trees/${treeId}/persons/${person.id}/attachments/${attachment.id}`,
                    sha256: await sha256Text(attachment.dataUrl),
                    sizeBytes: attachment.sizeBytes,
                });
            }
        }
    }
    return attachments.sort((a, b) => a.path.localeCompare(b.path));
}

export async function buildCompleteArchive(
    stores: Record<ArchiveStoreName, Array<[string, unknown]>>,
    settings: Array<[string, string]>,
    now = new Date(),
): Promise<CompleteArchive> {
    const normalizedStores = Object.fromEntries(
        ARCHIVE_STORES.map(store => [store, sortedEntries(stores[store] ?? [])]),
    ) as Record<ArchiveStoreName, Array<[string, unknown]>>;
    const normalizedSettings = sortedEntries(settings);
    const storeManifest = {} as CompleteArchive['manifest']['stores'];
    for (const store of ARCHIVE_STORES) {
        storeManifest[store] = {
            records: normalizedStores[store].length,
            sha256: await sha256Text(canonicalStringify(normalizedStores[store])),
        };
    }
    return {
        format: COMPLETE_ARCHIVE_FORMAT,
        archiveVersion: COMPLETE_ARCHIVE_VERSION,
        createdAt: now.toISOString(),
        dataVersion: STROM_DATA_VERSION,
        manifest: {
            stores: storeManifest,
            localStorage: {
                records: normalizedSettings.length,
                sha256: await sha256Text(canonicalStringify(normalizedSettings)),
            },
            attachments: await attachmentManifest(normalizedStores.trees),
            excluded: [
                { scope: 'IndexedDB/fileHandles', reason: 'Browser capability handles are non-portable and cannot be serialized safely.' },
                { scope: 'IndexedDB/recovery', reason: 'Recovery journals are local crash-state, not archive content.' },
                { scope: 'non-strom localStorage', reason: 'Unrelated origin data is outside the archive boundary.' },
            ],
        },
        payload: { stores: normalizedStores, localStorage: normalizedSettings },
    };
}

/** Build a plaintext in-memory archive. Call serializeCompleteArchive before download. */
export async function createCompleteArchiveFromStorage(): Promise<CompleteArchive> {
    await TreeManager.flushSaves();
    const stores = {} as Record<ArchiveStoreName, Array<[string, unknown]>>;
    for (const store of ARCHIVE_STORES) stores[store] = await StorageManager.entries(store);

    // Operational stores may be encrypted internally with the current session.
    // Canonical archives carry plaintext logical records inside the outer
    // password-protected archive container so a new profile is not tied to an
    // old IndexedDB encryption session.
    for (const store of ['audit', 'merge'] as const) {
        stores[store] = await Promise.all(stores[store].map(async ([key, value]) => {
            if (!isEncrypted(value)) return [key, value] as [string, unknown];
            if (!CryptoSession.isUnlocked()) throw new Error(`Unlock encryption before archiving ${store}.`);
            return [key, JSON.parse(await CryptoSession.decrypt(value))] as [string, unknown];
        }));
    }
    stores.snapshots = await Promise.all(stores.snapshots.map(async ([key, value]) => {
        const record = structuredClone(value) as { encrypted?: EncryptedData; plain?: string; gzip?: string };
        if (!record?.encrypted) return [key, record] as [string, unknown];
        if (!CryptoSession.isUnlocked()) throw new Error('Unlock encryption before archiving snapshots.');
        record.plain = await CryptoSession.decrypt(record.encrypted);
        delete record.encrypted;
        delete record.gzip;
        return [key, record] as [string, unknown];
    }));
    stores.shareBaselines = await Promise.all(stores.shareBaselines.map(async ([key, value]) => {
        const record = structuredClone(value) as { encrypted?: EncryptedData; plain?: string };
        if (!record?.encrypted) return [key, record] as [string, unknown];
        if (!CryptoSession.isUnlocked()) throw new Error('Unlock encryption before archiving share baselines.');
        record.plain = await CryptoSession.decrypt(record.encrypted);
        delete record.encrypted;
        return [key, record] as [string, unknown];
    }));

    // Archive canonical, decrypted tree payloads. The downloaded container must
    // be password-encrypted when local encryption is enabled.
    const treeEntries: Array<[string, unknown]> = [['_index', TreeManager.getIndex()]];
    for (const metadata of TreeManager.getTrees()) {
        const data = await TreeManager.getTreeData(metadata.id);
        if (!data) throw new Error(`Unable to read tree ${metadata.id}; unlock encryption before archiving.`);
        const sourceRecord = await StorageManager.getTreeRecord(metadata.id);
        const record: StoredTreeRecord<StromData> = {
            __stromTreeRecord: 1,
            revision: sourceRecord?.revision ?? 0,
            updatedAt: metadata.lastModifiedAt,
            payload: migrateAndValidateData(data),
        };
        treeEntries.push([metadata.id, record]);
    }
    stores.trees = treeEntries;
    return buildCompleteArchive(stores, localStorageEntries());
}

export function isCompleteArchive(value: unknown): value is CompleteArchive {
    return !!value && typeof value === 'object'
        && (value as CompleteArchive).format === COMPLETE_ARCHIVE_FORMAT;
}

export async function verifyCompleteArchive(archive: CompleteArchive): Promise<ArchiveVerification> {
    const errors: string[] = [];
    if (!isCompleteArchive(archive)) return { valid: false, errors: ['format'], treeCount: 0, attachmentCount: 0 };
    if (archive.archiveVersion !== COMPLETE_ARCHIVE_VERSION) errors.push('archiveVersion');
    if (archive.dataVersion > STROM_DATA_VERSION) errors.push('futureDataVersion');
    for (const store of ARCHIVE_STORES) {
        const entries = archive.payload?.stores?.[store];
        if (!Array.isArray(entries)) { errors.push(`missingStore:${store}`); continue; }
        const digest = await sha256Text(canonicalStringify(sortedEntries(entries)));
        if (digest !== archive.manifest?.stores?.[store]?.sha256) errors.push(`digest:${store}`);
        if (entries.length !== archive.manifest?.stores?.[store]?.records) errors.push(`count:${store}`);
    }
    const settings = archive.payload?.localStorage ?? [];
    if (await sha256Text(canonicalStringify(sortedEntries(settings))) !== archive.manifest?.localStorage?.sha256) {
        errors.push('digest:localStorage');
    }

    const treeEntries = new Map(archive.payload?.stores?.trees ?? []);
    const index = treeEntries.get('_index') as TreeIndex | undefined;
    if (!index || !Array.isArray(index.trees)) errors.push('treeIndex');
    for (const metadata of index?.trees ?? []) {
        const record = treeEntries.get(metadata.id);
        if (!record) { errors.push(`missingTree:${metadata.id}`); continue; }
        const data = treePayload(record);
        if (!data) { errors.push(`encryptedCanonicalTree:${metadata.id}`); continue; }
        try { migrateAndValidateData(data); } catch { errors.push(`invalidTree:${metadata.id}`); }
        for (const person of Object.values(data.persons ?? {})) {
            for (const attachment of person.attachments ?? []) {
                if (!attachment.dataUrl?.startsWith('data:') || attachment.dataUrl.length < 16) {
                    errors.push(`attachmentData:${metadata.id}:${person.id}:${attachment.id}`);
                }
            }
        }
    }
    if (index?.activeTreeId && !index.trees.some(tree => tree.id === index.activeTreeId)) errors.push('activeTree');

    const actualAttachments = await attachmentManifest(archive.payload?.stores?.trees ?? []);
    const expectedAttachments = archive.manifest?.attachments ?? [];
    if (canonicalStringify(actualAttachments) !== canonicalStringify(expectedAttachments)) errors.push('attachmentDigest');

    return {
        valid: errors.length === 0,
        errors,
        treeCount: index?.trees?.length ?? 0,
        attachmentCount: actualAttachments.length,
    };
}

export async function serializeCompleteArchive(archive: CompleteArchive, password?: string | null): Promise<string> {
    const verification = await verifyCompleteArchive(archive);
    if (!verification.valid) throw new Error(`Archive verification failed: ${verification.errors.join(', ')}`);
    const json = JSON.stringify(archive, null, 2);
    if (!password) throw new Error('Complete archives must be password protected.');
    return JSON.stringify(await encrypt(json, password), null, 2);
}

export async function parseCompleteArchive(text: string, password?: string): Promise<CompleteArchive> {
    let value = JSON.parse(text) as unknown;
    if (isEncrypted(value)) {
        if (!password) throw new Error('passwordRequired');
        value = JSON.parse(await decrypt(value, password));
    }
    if (!isCompleteArchive(value)) throw new Error('notCompleteArchive');
    const verification = await verifyCompleteArchive(value);
    if (!verification.valid) throw new Error(`archiveInvalid:${verification.errors.join(',')}`);
    return value;
}

function archivedEncryptionEnabled(archive: CompleteArchive): boolean {
    const raw = archive.payload.localStorage.find(([key]) => key === SETTINGS_KEY)?.[1];
    if (!raw) return false;
    try { return JSON.parse(raw).encryption === true; } catch { return false; }
}

async function persistenceStoresForReplace(
    archive: CompleteArchive,
    password?: string,
): Promise<Record<ArchiveStoreName, Array<[string, unknown]>>> {
    const stores = structuredClone(archive.payload.stores);
    if (!archivedEncryptionEnabled(archive)) return stores;
    if (password) await CryptoSession.unlock(password);
    else if (!CryptoSession.isUnlocked()) throw new Error('archivePasswordRequiredForEncryptedReplace');

    stores.trees = await Promise.all(stores.trees.map(async ([key, value]) => {
        if (key === '_index') return [key, value] as [string, unknown];
        const record = value as StoredTreeRecord<StromData>;
        return [key, {
            ...record,
            payload: await CryptoSession.encrypt(JSON.stringify(record.payload)),
        }] as [string, unknown];
    }));
    for (const store of ['audit', 'merge'] as const) {
        stores[store] = await Promise.all(stores[store].map(async ([key, value]) =>
            [key, await CryptoSession.encrypt(JSON.stringify(value))] as [string, unknown]));
    }
    stores.snapshots = await Promise.all(stores.snapshots.map(async ([key, value]) => {
        const record = structuredClone(value) as { plain?: string; encrypted?: EncryptedData; gzip?: string };
        const plain = record.plain;
        if (plain !== undefined) {
            record.encrypted = await CryptoSession.encrypt(plain);
            delete record.plain;
            delete record.gzip;
        }
        return [key, record] as [string, unknown];
    }));
    stores.shareBaselines = await Promise.all(stores.shareBaselines.map(async ([key, value]) => {
        const record = structuredClone(value) as { plain?: string; encrypted?: EncryptedData };
        if (record.plain !== undefined) {
            record.encrypted = await CryptoSession.encrypt(record.plain);
            delete record.plain;
        }
        return [key, record] as [string, unknown];
    }));
    return stores;
}

export async function planArchiveReplace(archive: CompleteArchive, password?: string): Promise<ArchiveRestorePlan> {
    const verification = await verifyCompleteArchive(archive);
    if (!verification.valid) throw new Error(`archiveInvalid:${verification.errors.join(',')}`);
    const stores = await persistenceStoresForReplace(archive, password);
    const index = new Map(stores.trees).get('_index') as TreeIndex;
    return {
        mode: 'replace',
        archiveSha256: await sha256Text(canonicalStringify(archive)),
        replacements: Object.fromEntries(ARCHIVE_STORES.map(store => [store, stores[store]])),
        localStorage: archive.payload.localStorage,
        activeTreeId: index.activeTreeId,
        warnings: ['Existing Strom trees and included operational stores will be replaced after a recovery journal is written.'],
    };
}

export async function planArchiveRestoreAsNew(
    archive: CompleteArchive,
    currentTreeEntries: Array<[string, unknown]>,
    token = Date.now().toString(36),
): Promise<ArchiveRestorePlan> {
    const verification = await verifyCompleteArchive(archive);
    if (!verification.valid) throw new Error(`archiveInvalid:${verification.errors.join(',')}`);
    const current = new Map(currentTreeEntries);
    const currentIndex = structuredClone((current.get('_index') as TreeIndex | undefined) ?? {
        version: 1, activeTreeId: null, trees: [],
    });
    const archived = new Map(archive.payload.stores.trees);
    const archivedIndex = archived.get('_index') as TreeIndex;
    const used = new Set(currentIndex.trees.map(tree => String(tree.id)));
    const restored: TreeMetadata[] = [];
    let counter = 0;
    for (const metadata of archivedIndex.trees) {
        let newId: string;
        do { newId = `${metadata.id}_restored_${token}_${++counter}`; } while (used.has(newId));
        used.add(newId);
        const record = archived.get(metadata.id);
        const data = treePayload(record);
        if (!data) throw new Error(`Tree ${metadata.id} is not a canonical plaintext archive tree.`);
        const cloned = migrateAndValidateData(data);
        const nextMeta: TreeMetadata = {
            ...structuredClone(metadata),
            id: newId as TreeId,
            name: `${metadata.name} (restored)`,
            createdAt: new Date().toISOString(),
            lastModifiedAt: new Date().toISOString(),
        };
        restored.push(nextMeta);
        let persistedPayload: StromData | EncryptedData = cloned;
        if (SettingsManager.isEncryptionEnabled()) {
            if (!CryptoSession.isUnlocked()) throw new Error('locked');
            persistedPayload = await CryptoSession.encrypt(JSON.stringify(cloned));
        }
        const nextRecord: StoredTreeRecord<StromData | EncryptedData> = {
            __stromTreeRecord: 1, revision: 0, updatedAt: nextMeta.lastModifiedAt, payload: persistedPayload,
        };
        current.set(newId, nextRecord);
    }
    currentIndex.trees.push(...restored);
    currentIndex.activeTreeId = restored[0]?.id ?? currentIndex.activeTreeId;
    current.set('_index', currentIndex);
    return {
        mode: 'as-new',
        archiveSha256: await sha256Text(canonicalStringify(archive)),
        replacements: { trees: sortedEntries([...current.entries()]) },
        localStorage: null,
        activeTreeId: currentIndex.activeTreeId,
        warnings: ['Snapshots, audit logs, merge sessions, and share baselines remain in the archive but are not duplicated by restore-as-new. Use verified replace in a fresh profile for a complete operational restore.'],
    };
}

function applyArchivedLocalStorage(entries: Array<[string, string]>): void {
    if (typeof localStorage === 'undefined') return;
    const keep = new Set(entries.map(([key]) => key));
    const remove: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key && (key === SETTINGS_KEY || key.startsWith('strom-')) && !keep.has(key)) remove.push(key);
    }
    for (const key of remove) localStorage.removeItem(key);
    for (const [key, value] of entries) localStorage.setItem(key, value);
}

async function encodeRecovery(archive: CompleteArchive): Promise<CompleteArchive | EncryptedData> {
    if (!SettingsManager.isEncryptionEnabled()) return archive;
    if (!CryptoSession.isUnlocked()) throw new Error('locked');
    return CryptoSession.encrypt(JSON.stringify(archive));
}

async function decodeRecovery(value: CompleteArchive | EncryptedData): Promise<CompleteArchive> {
    if (!isEncrypted(value)) return value;
    if (!CryptoSession.isUnlocked()) throw new Error('locked');
    return JSON.parse(await CryptoSession.decrypt(value)) as CompleteArchive;
}

export async function executeArchiveRestore(plan: ArchiveRestorePlan): Promise<void> {
    const before = await createCompleteArchiveFromStorage();
    const journal: RecoveryJournal = {
        kind: 'archive-restore', createdAt: new Date().toISOString(), mode: plan.mode,
        before: await encodeRecovery(before),
    };
    await StorageManager.set('recovery', '_pending_archive_restore', journal);
    await StorageManager.replaceStoresAtomically(plan.replacements);
    if (plan.localStorage) applyArchivedLocalStorage(plan.localStorage);
    await StorageManager.delete('recovery', '_pending_archive_restore');
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('strom:archive-restored', { detail: plan }));
}

/** Roll back an interrupted destructive restore to the verified pre-state. */
export async function recoverInterruptedArchiveRestore(): Promise<boolean> {
    const journal = await StorageManager.get<RecoveryJournal>('recovery', '_pending_archive_restore');
    if (!journal || journal.kind !== 'archive-restore') return false;
    const before = await decodeRecovery(journal.before);
    const plan = await planArchiveReplace(before);
    await StorageManager.replaceStoresAtomically(plan.replacements);
    if (plan.localStorage) applyArchivedLocalStorage(plan.localStorage);
    await StorageManager.delete('recovery', '_pending_archive_restore');
    return true;
}
