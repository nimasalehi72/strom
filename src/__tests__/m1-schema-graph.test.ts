import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateAndValidateData, migrateData, FutureSchemaError } from '../data.js';
import {
    assertGraphInvariants,
    rebuildDerivedGraphIndexes,
    validateGraphInvariants,
} from '../graph-invariants.js';
import { validateJsonImport } from '../merge/validation.js';
import { STROM_DATA_VERSION, toPersonId, type StromData } from '../types.js';
import { exportToGedcom } from '../ged-exporter.js';
import { convertToStrom, parseGedcom } from '../ged-parser.js';

const fixture = (name: string): StromData => JSON.parse(
    readFileSync(join(process.cwd(), 'test', name), 'utf8'),
) as StromData;
const person = (data: StromData, id: string) => data.persons[toPersonId(id)];

describe('M1 schema v6 and strict migration', () => {
    it('preserves original Persian text, Solar Hijri provenance, variants, gender and attachment bytes', () => {
        const source = fixture('m1-schema-v6.json');
        const migrated = migrateAndValidateData(source);
        const subject = person(migrated, 'p_child');
        expect(migrated.version).toBe(STROM_DATA_VERSION);
        expect(subject.firstName).toBe('آرین');
        expect(subject.birthDate).toBe('حدود ۱۴۰۱/۰۲');
        expect(subject.birthDateEvidence).toEqual(person(source, 'p_child').birthDateEvidence);
        expect(subject.nameVariants).toEqual(['Arian Karimi', 'آریان کریمی']);
        expect(subject.gender).toBe('other');
        expect(person(migrated, 'p_foster').gender).toBe('unknown');
        expect(subject.attachments?.[0].dataUrl).toBe(person(source, 'p_child').attachments?.[0].dataUrl);
        expect(subject.parentIds).toHaveLength(3);
    });

    it('migrates immutable v1 and v5 fixtures without changing raw evidence', () => {
        const legacy = fixture('m1-legacy-v1.json');
        const migrated = migrateAndValidateData(legacy);
        expect(migrated.version).toBe(6);
        expect(person(migrated, 'legacy').firstName).toBe('قدیمی');
        expect(person(migrated, 'legacy').birthDate).toBe('<1900');

        const base = fixture('m0-complex-family.json');
        const baseMigrated = migrateAndValidateData(base);
        expect(base.version).toBe(5);
        expect(baseMigrated.version).toBe(6);
        expect(person(baseMigrated, 'm0_grandfather').firstName).toBe('رضا');
    });

    it('rejects future schema before it can become active data', () => {
        const future = fixture('m1-future-v999.json');
        expect(() => migrateData(future)).toThrow(FutureSchemaError);
        const result = validateJsonImport(JSON.stringify(future));
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('newerVersion:999:6');
        expect(result.data).toBeUndefined();
    });

    it('rejects corrupt canonical references instead of overwriting active data', () => {
        expect(() => migrateAndValidateData(fixture('m1-corrupt-orphan.json'))).toThrow(/orphanParent/);
    });

    it('maps other and unknown gender through GEDCOM X/U', () => {
        const source = fixture('m1-schema-v6.json');
        const gedcom = exportToGedcom(source).content;
        expect(gedcom).toContain('1 SEX X');
        expect(gedcom).toContain('1 SEX U');
        const imported = convertToStrom(parseGedcom(gedcom)).data;
        expect(Object.values(imported.persons).some(person => person.gender === 'other')).toBe(true);
        expect(Object.values(imported.persons).some(person => person.gender === 'unknown')).toBe(true);
    });
});

describe('canonical graph and derived indexes', () => {
    it('accepts more than two parent figures', () => {
        expect(validateGraphInvariants(fixture('m1-schema-v6.json'))).toEqual([]);
    });

    it('detects stale reverse indexes before commit', () => {
        const data = structuredClone(fixture('m1-schema-v6.json'));
        person(data, 'p_bio1').childIds = [];
        expect(validateGraphInvariants(data)).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'derivedChildIndex' }),
        ]));
        expect(() => assertGraphInvariants(data)).toThrow(/derivedChildIndex/);
    });

    it('rebuilds derived indexes from canonical parent and partnership fields on load', () => {
        const data = structuredClone(fixture('m1-schema-v6.json'));
        for (const person of Object.values(data.persons)) {
            person.childIds = [];
            person.partnerships = [];
        }
        rebuildDerivedGraphIndexes(data);
        expect(validateGraphInvariants(data)).toEqual([]);
        expect(person(data, 'p_bio1').childIds).toContain('p_child');
    });
});
