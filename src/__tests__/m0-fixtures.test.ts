/** M0 synthetic-fixture contract. No real family information belongs here. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STROM_DATA_VERSION, type StromData } from '../types.js';
import { migrateAndValidateData } from '../data.js';
import { validateTreeData } from '../validation.js';

function fixture(name: string): StromData {
    return JSON.parse(readFileSync(join(process.cwd(), 'test', name), 'utf8')) as StromData;
}

describe('M0 synthetic fixtures', () => {
    for (const [name, expectedPeople] of [
        ['m0-scale-100.json', 100],
        ['m0-scale-500.json', 500],
        ['m0-scale-1000.json', 1000],
    ] as const) {
        it(`${name} is current, exact-sized, and valid`, () => {
            const data = fixture(name);
            const result = validateTreeData(data);
            expect(data.version).toBe(5);
            expect(migrateAndValidateData(data).version).toBe(STROM_DATA_VERSION);
            expect(Object.keys(data.persons)).toHaveLength(expectedPeople);
            expect(result.issues.filter(issue => issue.severity === 'error')).toEqual([]);
        });
    }

    it('complex family covers the difficult archive baseline', () => {
        const data = fixture('m0-complex-family.json');
        const result = validateTreeData(data);
        const people = Object.values(data.persons);

        expect(result.issues.filter(issue => issue.severity === 'error')).toEqual([]);
        expect(people.some(person => person.isPlaceholder)).toBe(true);
        expect(Object.values(data.partnerships).some(partnership => partnership.status === 'divorced')).toBe(true);
        expect(Object.values(data.partnerships).some(partnership => {
            const p1 = data.persons[partnership.person1Id];
            const p2 = data.persons[partnership.person2Id];
            return p1.gender === p2.gender;
        })).toBe(true);
        expect(people.flatMap(person => Object.values(person.parentRelTypes ?? {}))).toEqual(
            expect.arrayContaining(['adoptive', 'step', 'foster']),
        );
        expect(people.some(person => person.nameVariants?.some(name => /[\u0600-\u06FF]/u.test(name)))).toBe(true);
        expect(people.some(person => person.birthDate?.startsWith('~'))).toBe(true);
        expect(people.some(person => person.photo)).toBe(true);
        expect(people.some(person => person.attachments?.some(attachment => attachment.mimeType === 'application/pdf'))).toBe(true);
        expect(Object.keys(data.sources ?? {}).length).toBeGreaterThan(0);
        expect(Object.keys(data.places ?? {}).length).toBeGreaterThan(0);
    });

    it('accepts the historical M0 more-than-two-parent fixture after M1', () => {
        const data = fixture('m0-current-limit-multi-parent.json');
        const result = validateTreeData(data);
        expect(result.valid).toBe(true);
        expect(result.issues.some(issue => issue.type === 'tooManyParents')).toBe(false);
    });
});
