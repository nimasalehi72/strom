import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataManager } from '../data.js';
import { TreeManager } from '../tree-manager.js';
import { AuditLogManager } from '../audit-log.js';
import { UndoManager } from '../undo.js';
import { assertGraphInvariants } from '../graph-invariants.js';
import { STROM_DATA_VERSION, type StromData, type TreeId } from '../types.js';

const TREE = 'm1-mutation-tree' as TreeId;

function reset(): void {
    vi.spyOn(TreeManager, 'saveTreeData').mockImplementation(() => {});
    vi.spyOn(AuditLogManager, 'log').mockImplementation(() => {});
    const manager = DataManager as unknown as {
        data: StromData;
        currentTreeId: TreeId | null;
        viewMode: boolean;
        pendingBefore: StromData | null;
        batchActive: boolean;
    };
    manager.data = { version: STROM_DATA_VERSION, persons: {}, partnerships: {} };
    manager.currentTreeId = TREE;
    manager.viewMode = false;
    manager.pendingBefore = null;
    manager.batchActive = false;
    UndoManager.setActiveTree(null);
    UndoManager.setActiveTree(TREE);
}

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const valid = () => expect(() => assertGraphInvariants(DataManager.getData())).not.toThrow();

describe('mutation invariant choke point', () => {
    it('keeps a deterministic mixed mutation sequence valid through undo and redo', () => {
        const people = Array.from({ length: 12 }, (_, index) => {
            const created = DataManager.createPerson({
                firstName: `Person${index}`, lastName: 'Synthetic',
                gender: index % 4 === 0 ? 'unknown' : index % 4 === 1 ? 'other' : index % 4 === 2 ? 'female' : 'male',
            });
            valid();
            return created;
        });

        for (let index = 0; index < 6; index += 2) {
            expect(DataManager.createPartnership(people[index].id, people[index + 1].id)).not.toBeNull();
            valid();
        }
        // Three typed parent figures are intentional and must stay symmetric.
        expect(DataManager.addParentChild(people[0].id, people[8].id)).toBe(true);
        expect(DataManager.addParentChild(people[1].id, people[8].id)).toBe(true);
        expect(DataManager.addParentChild(people[2].id, people[8].id)).toBe(true);
        expect(DataManager.setParentRelType(people[8].id, people[2].id, 'adoptive')).toBe(true);
        valid();

        const source = DataManager.addSource({ title: 'Synthetic register', quality: 3 })!;
        expect(DataManager.citePerson(people[8].id, source.id)).toBe(true);
        const event = DataManager.addLifeEvent(people[8].id, {
            type: 'residence', date: '2001', place: 'Tehran', sourceIds: [source.id],
        })!;
        expect(DataManager.updateLifeEvent(people[8].id, event.id, { note: 'verified' })).toBe(true);
        const attachment = DataManager.addAttachment(people[8].id, {
            name: 'evidence.pdf', mimeType: 'application/pdf',
            dataUrl: 'data:application/pdf;base64,JVBERi0xLjQKJSVFT0YK', sizeBytes: 18,
        })!;
        expect(DataManager.updateAttachmentNote(people[8].id, attachment.id, 'page 1')).toBe(true);
        valid();

        for (let count = 0; count < 8 && DataManager.canUndo(); count++) {
            expect(DataManager.undo()).not.toBeNull();
            valid();
        }
        for (let count = 0; count < 8 && DataManager.canRedo(); count++) {
            expect(DataManager.redo()).not.toBeNull();
            valid();
        }
    });

    it('rolls back a rejected cycle without changing the active graph', () => {
        const parent = DataManager.createPerson({ firstName: 'Parent', lastName: 'X', gender: 'unknown' });
        const child = DataManager.createPerson({ firstName: 'Child', lastName: 'X', gender: 'unknown' });
        expect(DataManager.addParentChild(parent.id, child.id)).toBe(true);
        const before = structuredClone(DataManager.getData());
        expect(() => DataManager.addParentChild(child.id, parent.id)).toThrow(/ancestorCycle/);
        expect(DataManager.getData()).toEqual(before);
        valid();
    });

    it('rejected missing IDs and locked records are non-mutating', () => {
        const person = DataManager.createPerson({ firstName: 'Locked', lastName: 'X', gender: 'unknown' });
        DataManager.updatePerson(person.id, { isLocked: true });
        const before = structuredClone(DataManager.getData());
        expect(DataManager.updatePerson(person.id, { firstName: 'Changed' })?.firstName).toBe('Locked');
        expect(DataManager.addParentChild('missing' as never, person.id)).toBe(false);
        expect(DataManager.getData()).toEqual(before);
        valid();
    });
});
