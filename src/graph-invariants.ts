/**
 * Canonical genealogy graph rules.
 *
 * Canonical fields:
 * - Person.parentIds owns parent -> child edges.
 * - Partnership records own partner edges.
 * - Partnership.childIds owns the family-unit attribution of a child.
 *
 * Person.childIds and Person.partnerships are derived reverse indexes retained
 * for renderer performance and legacy compatibility. Loads rebuild them from
 * the canonical fields; commits reject divergence.
 */

import type { PersonId, PartnershipId, StromData } from './types.js';

export interface GraphInvariantIssue {
    code: string;
    path: string;
    detail: string;
}

export class GraphInvariantError extends Error {
    constructor(public readonly issues: GraphInvariantIssue[]) {
        super(`Genealogy graph invariant failure: ${issues.map(i => `${i.code}@${i.path}`).join(', ')}`);
        this.name = 'GraphInvariantError';
    }
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const sameSet = <T>(a: T[], b: T[]): boolean =>
    a.length === b.length && a.every(value => b.includes(value));

/** Rebuild derived indexes and harmless legacy defaults on a loaded clone. */
export function rebuildDerivedGraphIndexes(data: StromData): StromData {
    for (const [id, person] of Object.entries(data.persons)) {
        person.parentIds = unique(person.parentIds ?? []);
        person.childIds = [];
        person.partnerships = [];
        if (person.parentRelTypes) {
            for (const parentId of Object.keys(person.parentRelTypes)) {
                if (!person.parentIds.includes(parentId as PersonId)) {
                    delete person.parentRelTypes[parentId as PersonId];
                }
            }
            if (Object.keys(person.parentRelTypes).length === 0) delete person.parentRelTypes;
        }
    }

    for (const [id, partnership] of Object.entries(data.partnerships)) {
        partnership.childIds = unique(partnership.childIds ?? []);
        const p1 = data.persons[partnership.person1Id];
        const p2 = data.persons[partnership.person2Id];
        if (p1) p1.partnerships.push(id as PartnershipId);
        if (p2) p2.partnerships.push(id as PartnershipId);
        for (const childId of partnership.childIds) {
            const child = data.persons[childId];
            if (!child) continue;
            if (p1 && !child.parentIds.includes(p1.id)) child.parentIds.push(p1.id);
            if (p2 && !child.parentIds.includes(p2.id)) child.parentIds.push(p2.id);
        }
    }

    for (const child of Object.values(data.persons)) {
        child.parentIds = unique(child.parentIds);
        for (const parentId of child.parentIds) {
            const parent = data.persons[parentId];
            if (parent && !parent.childIds.includes(child.id)) parent.childIds.push(child.id);
        }
    }
    for (const person of Object.values(data.persons)) {
        person.childIds = unique(person.childIds);
        person.partnerships = unique(person.partnerships);
    }
    return data;
}

export function validateGraphInvariants(data: StromData): GraphInvariantIssue[] {
    const issues: GraphInvariantIssue[] = [];
    const add = (code: string, path: string, detail: string) => issues.push({ code, path, detail });
    const persons = data?.persons;
    const partnerships = data?.partnerships;
    if (!persons || typeof persons !== 'object') {
        add('missingPersons', 'persons', 'persons must be an object');
        return issues;
    }
    if (!partnerships || typeof partnerships !== 'object') {
        add('missingPartnerships', 'partnerships', 'partnerships must be an object');
        return issues;
    }

    const expectedChildren = new Map<PersonId, PersonId[]>();
    const expectedPartnerships = new Map<PersonId, PartnershipId[]>();
    for (const id of Object.keys(persons) as PersonId[]) {
        expectedChildren.set(id, []);
        expectedPartnerships.set(id, []);
    }

    for (const [id, person] of Object.entries(persons) as [PersonId, typeof persons[PersonId]][]) {
        if (person.id !== id) add('personIdMismatch', `persons.${id}.id`, String(person.id));
        if (!Array.isArray(person.parentIds)) add('invalidIndex', `persons.${id}.parentIds`, 'must be an array');
        else if (new Set(person.parentIds).size !== person.parentIds.length) add('duplicateIndex', `persons.${id}.parentIds`, 'contains duplicates');
        if (!Array.isArray(person.childIds)) add('invalidIndex', `persons.${id}.childIds`, 'must be an array');
        else if (new Set(person.childIds).size !== person.childIds.length) add('duplicateIndex', `persons.${id}.childIds`, 'contains duplicates');
        if (!Array.isArray(person.partnerships)) add('invalidIndex', `persons.${id}.partnerships`, 'must be an array');
        else if (new Set(person.partnerships).size !== person.partnerships.length) add('duplicateIndex', `persons.${id}.partnerships`, 'contains duplicates');
        for (const parentId of person.parentIds ?? []) {
            if (parentId === id) add('selfParent', `persons.${id}.parentIds`, id);
            if (!persons[parentId]) add('orphanParent', `persons.${id}.parentIds`, parentId);
            else expectedChildren.get(parentId)!.push(id);
        }
        for (const parentId of Object.keys(person.parentRelTypes ?? {})) {
            if (!person.parentIds.includes(parentId as PersonId)) {
                add('orphanParentRelType', `persons.${id}.parentRelTypes.${parentId}`, 'key is not a parent');
            }
        }
    }

    for (const [id, partnership] of Object.entries(partnerships) as [PartnershipId, typeof partnerships[PartnershipId]][]) {
        if (partnership.id !== id) add('partnershipIdMismatch', `partnerships.${id}.id`, String(partnership.id));
        if (partnership.person1Id === partnership.person2Id) add('selfPartnership', `partnerships.${id}`, partnership.person1Id);
        const p1 = persons[partnership.person1Id];
        const p2 = persons[partnership.person2Id];
        if (!p1) add('orphanPartner', `partnerships.${id}.person1Id`, partnership.person1Id);
        if (!p2) add('orphanPartner', `partnerships.${id}.person2Id`, partnership.person2Id);
        if (p1) expectedPartnerships.get(p1.id)!.push(id);
        if (p2) expectedPartnerships.get(p2.id)!.push(id);
        if (!Array.isArray(partnership.childIds)) add('invalidIndex', `partnerships.${id}.childIds`, 'must be an array');
        else if (new Set(partnership.childIds).size !== partnership.childIds.length) add('duplicateIndex', `partnerships.${id}.childIds`, 'contains duplicates');
        for (const childId of partnership.childIds ?? []) {
            const child = persons[childId];
            if (!child) add('orphanPartnershipChild', `partnerships.${id}.childIds`, childId);
            else if (!child.parentIds.includes(partnership.person1Id) || !child.parentIds.includes(partnership.person2Id)) {
                add('partnershipChildParents', `partnerships.${id}.childIds`, childId);
            }
        }
    }

    // Ancestor-cycle check over canonical parent edges.
    const visiting = new Set<PersonId>();
    const visited = new Set<PersonId>();
    const visit = (id: PersonId): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;
        visiting.add(id);
        for (const parent of persons[id]?.parentIds ?? []) if (persons[parent] && visit(parent)) return true;
        visiting.delete(id);
        visited.add(id);
        return false;
    };
    for (const id of Object.keys(persons) as PersonId[]) {
        if (visit(id)) { add('ancestorCycle', `persons.${id}.parentIds`, 'cycle detected'); break; }
    }

    for (const [id, person] of Object.entries(persons) as [PersonId, typeof persons[PersonId]][]) {
        if (!sameSet(unique(person.childIds ?? []), unique(expectedChildren.get(id) ?? []))) {
            add('derivedChildIndex', `persons.${id}.childIds`, 'does not match canonical parentIds');
        }
        if (!sameSet(unique(person.partnerships ?? []), unique(expectedPartnerships.get(id) ?? []))) {
            add('derivedPartnershipIndex', `persons.${id}.partnerships`, 'does not match partnership records');
        }
    }
    return issues;
}

export function assertGraphInvariants(data: StromData): void {
    const issues = validateGraphInvariants(data);
    if (issues.length > 0) throw new GraphInvariantError(issues);
}
