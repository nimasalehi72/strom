/**
 * Deterministic synthetic fixtures for the fork's M0 baseline.
 *
 * These records are fictional. They exercise modern family structures,
 * bilingual text, archival material, and graph scale without using real family
 * information. Running the script twice produces byte-identical JSON.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    toPartnershipId,
    toPersonId,
    type Gender,
    type ParentChildRelType,
    type Partnership,
    type PartnershipId,
    type PartnershipStatus,
    type Person,
    type PersonId,
    type StromData,
} from '../src/types.js';
import { validateTreeData } from '../src/validation.js';

class FixtureBuilder {
    readonly persons: StromData['persons'] = {};
    readonly partnerships: StromData['partnerships'] = {};

    person(
        id: string,
        firstName: string,
        lastName: string,
        gender: Gender,
        extra: Partial<Person> = {},
    ): PersonId {
        const personId = toPersonId(id);
        if (this.persons[personId]) throw new Error(`Duplicate person id: ${id}`);
        this.persons[personId] = {
            id: personId,
            firstName,
            lastName,
            gender,
            isPlaceholder: false,
            partnerships: [],
            parentIds: [],
            childIds: [],
            ...extra,
        };
        return personId;
    }

    partnership(
        id: string,
        person1Id: PersonId,
        person2Id: PersonId,
        status: PartnershipStatus,
        extra: Partial<Partnership> = {},
    ): PartnershipId {
        const partnershipId = toPartnershipId(id);
        if (this.partnerships[partnershipId]) throw new Error(`Duplicate partnership id: ${id}`);
        this.partnerships[partnershipId] = {
            id: partnershipId,
            person1Id,
            person2Id,
            childIds: [],
            status,
            ...extra,
        };
        this.persons[person1Id].partnerships.push(partnershipId);
        this.persons[person2Id].partnerships.push(partnershipId);
        return partnershipId;
    }

    child(
        partnershipId: PartnershipId,
        childId: PersonId,
        types: Partial<Record<PersonId, ParentChildRelType>> = {},
    ): void {
        const partnership = this.partnerships[partnershipId];
        partnership.childIds.push(childId);
        for (const parentId of [partnership.person1Id, partnership.person2Id]) {
            if (!this.persons[parentId].childIds.includes(childId)) {
                this.persons[parentId].childIds.push(childId);
            }
            if (!this.persons[childId].parentIds.includes(parentId)) {
                this.persons[childId].parentIds.push(parentId);
            }
            const relationType = types[parentId];
            if (relationType && relationType !== 'biological') {
                this.persons[childId].parentRelTypes ??= {};
                this.persons[childId].parentRelTypes![parentId] = relationType;
            }
        }
    }

    additionalParent(childId: PersonId, parentId: PersonId, type: ParentChildRelType): void {
        if (!this.persons[childId].parentIds.includes(parentId)) this.persons[childId].parentIds.push(parentId);
        if (!this.persons[parentId].childIds.includes(childId)) this.persons[parentId].childIds.push(childId);
        if (type !== 'biological') {
            this.persons[childId].parentRelTypes ??= {};
            this.persons[childId].parentRelTypes![parentId] = type;
        }
    }

    data(extra: Partial<StromData> = {}): StromData {
        return {
            // Frozen M0 schema: these are immutable compatibility fixtures.
            version: 5,
            persons: this.persons,
            partnerships: this.partnerships,
            ...extra,
        };
    }
}

function complexFamily(): StromData {
    const b = new FixtureBuilder();
    const tinyJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==';
    const tinyPdfBase64 = 'JVBERi0xLjQKJSVFT0YK';

    const grandfather = b.person('m0_grandfather', 'رضا', 'کریمی', 'male', {
        birthDate: '1930', deathDate: '2001', nameVariants: ['Reza Karimi'], isDeceased: true,
    });
    const grandmother = b.person('m0_grandmother', 'مریم', 'کریمی', 'female', {
        birthDate: '~1934', nameVariants: ['Maryam Karimi', 'مریم کريمي'], isDeceased: true,
    });
    const father = b.person('m0_father', 'فرید', 'کریمی', 'male', {
        birthDate: '1956-02', nameVariants: ['Farid Karimi'], sourceIds: ['m0_source_register'],
    });
    const aunt = b.person('m0_aunt', 'ناهید', 'کریمی', 'female', { birthDate: '1960' });
    const unknownMaternalParent = b.person('m0_unknown_parent', '?', '', 'male', { isPlaceholder: true });
    const mother = b.person('m0_mother', 'لیلا', 'رضایی', 'female', {
        birthDate: '1960', nameVariants: ['Leila Rezaei'],
    });
    const stepmother = b.person('m0_stepmother', 'مینا', 'احمدی', 'female', { birthDate: '1965' });
    const focus = b.person('m0_focus', 'نیما', 'کریمی', 'male', {
        birthDate: '~1985', birthPlace: 'تهران', nameVariants: ['Nima Karimi', 'Nimā Karimi'],
        refn: 'M0-FOCUS', question: 'Original Solar Hijri date recorded as ۱۳۶۴/۰۲; conversion unverified.',
        notes: 'Synthetic mixed-script record. تاریخ اصلی باید بدون حذف شدن حفظ شود.',
        photo: tinyJpeg, photoOriginalName: 'synthetic-portrait.jpg', sourceIds: ['m0_source_register'],
        events: [{
            id: 'm0_event_occupation', type: 'occupation', date: '>2005', place: 'تهران',
            note: 'طراح / Designer', sourceIds: ['m0_source_letter'],
            participants: [{ id: 'm0_participant_1', role: 'witness', name: 'شاهد ساختگی' }],
        }],
        attachments: [{
            id: 'm0_attachment_pdf', name: 'synthetic-letter.pdf', mimeType: 'application/pdf',
            dataUrl: `data:application/pdf;base64,${tinyPdfBase64}`, sizeBytes: 15,
            note: 'Synthetic PDF marker', sourceId: 'm0_source_letter',
        }],
    });
    const sister = b.person('m0_sister', 'سارا', 'کریمی', 'female', { birthDate: '1988' });
    const halfBrother = b.person('m0_half_brother', 'آرمان', 'کریمی', 'male', { birthDate: '1995' });
    const stepChild = b.person('m0_step_child', 'روژان', 'کریمی', 'female', { birthDate: '1991' });
    const partner = b.person('m0_partner', 'امید', 'صادقی', 'male', {
        birthDate: '1984', nameVariants: ['Omid Sadeghi'],
    });
    const adoptedChild = b.person('m0_adopted_child', 'هانا', 'کریمی', 'female', { birthDate: '2015' });
    const fosterChild = b.person('m0_foster_child', 'سام', 'کریمی', 'male', { birthDate: '2017' });
    const duplicateCandidate = b.person('m0_duplicate_candidate', 'Nima', 'Karimi', 'male', {
        birthDate: '~1985', nameVariants: ['نیما کریمی'],
    });

    const grandparents = b.partnership('m0_union_grandparents', grandfather, grandmother, 'married', {
        startDate: '1954', startPlace: 'تهران', sourceIds: ['m0_source_register'],
    });
    b.child(grandparents, father);
    b.child(grandparents, aunt);

    const parents = b.partnership('m0_union_parents', father, mother, 'divorced', {
        startDate: '1980', endDate: '1992', startPlace: 'تهران',
    });
    b.child(parents, focus);
    b.child(parents, sister);

    const secondMarriage = b.partnership('m0_union_second_marriage', father, stepmother, 'married', {
        startDate: '1993', startPlace: 'کرج',
    });
    b.child(secondMarriage, halfBrother);
    b.child(secondMarriage, stepChild, { [stepmother]: 'step' });

    const sameSexPartnership = b.partnership('m0_union_focus_partner', focus, partner, 'partners', {
        startDate: '2010', startPlace: 'تهران', note: 'Synthetic same-sex partnership.',
    });
    b.child(sameSexPartnership, adoptedChild, {
        [focus]: 'adoptive',
        [partner]: 'adoptive',
    });
    b.child(sameSexPartnership, fosterChild, {
        [focus]: 'foster',
        [partner]: 'foster',
    });

    b.additionalParent(mother, unknownMaternalParent, 'biological');

    return b.data({
        defaultPersonId: focus,
        sources: {
            m0_source_register: {
                id: 'm0_source_register', title: 'Synthetic family register',
                repository: 'M0 Test Archive', reference: 'TEST-001', quality: 3,
            },
            m0_source_letter: {
                id: 'm0_source_letter', title: 'Synthetic bilingual letter',
                repository: 'M0 Test Archive', reference: 'TEST-002', quality: 2,
            },
        },
        places: {
            'تهران': { lat: 35.6892, lon: 51.3890, label: 'Tehran, Iran' },
            'کرج': { lat: 35.8400, lon: 50.9391, label: 'Karaj, Iran' },
        },
        surnameVariants: [['کریمی', 'كريمي', 'Karimi']],
    });
}

/** Documents the current validator limitation that M1 must resolve. */
function multiParentLimit(): StromData {
    const b = new FixtureBuilder();
    const father = b.person('m0_limit_father', 'Parent', 'One', 'male');
    const mother = b.person('m0_limit_mother', 'Parent', 'Two', 'female');
    const fosterParent = b.person('m0_limit_foster', 'Parent', 'Three', 'female');
    const child = b.person('m0_limit_child', 'Child', 'Example', 'male');
    const parents = b.partnership('m0_limit_union', father, mother, 'married');
    b.child(parents, child);
    b.additionalParent(child, fosterParent, 'foster');
    return b.data({ defaultPersonId: child });
}

function scaleFamily(target: number): StromData {
    if (target < 2) throw new Error('Scale fixture requires at least two people.');
    const b = new FixtureBuilder();
    let serial = 0;
    const nextPerson = (role: string, gender: Gender): PersonId => {
        const id = `m0_${target}_p${String(serial).padStart(4, '0')}`;
        const person = b.person(id, `${role}${serial}`, `Scale${target}`, gender);
        serial += 1;
        return person;
    };

    const root1 = nextPerson('Root', 'male');
    const root2 = nextPerson('Root', 'female');
    const rootUnion = b.partnership(`m0_${target}_u0000`, root1, root2, 'married');
    const queue: PartnershipId[] = [rootUnion];
    let unionSerial = 1;

    while (serial < target && queue.length > 0) {
        const parentUnion = queue.shift()!;
        for (let branch = 0; branch < 3 && serial < target; branch += 1) {
            const childGender: Gender = serial % 2 === 0 ? 'male' : 'female';
            const child = nextPerson('Person', childGender);
            b.child(parentUnion, child);
            if (serial < target) {
                const spouse = nextPerson('Partner', childGender === 'male' ? 'female' : 'male');
                const union = b.partnership(
                    `m0_${target}_u${String(unionSerial).padStart(4, '0')}`,
                    child,
                    spouse,
                    unionSerial % 7 === 0 ? 'partners' : 'married',
                );
                unionSerial += 1;
                queue.push(union);
            }
        }
    }

    if (serial !== target) throw new Error(`Expected ${target} people, generated ${serial}.`);
    return b.data({ defaultPersonId: root1 });
}

function writeFixture(name: string, data: StromData): void {
    const validation = validateTreeData(data);
    const errors = validation.issues.filter(issue => issue.severity === 'error');
    if (errors.length > 0) {
        throw new Error(`${name} has validation errors:\n${JSON.stringify(errors, null, 2)}`);
    }
    const path = join(process.cwd(), 'test', name);
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log(`${name}: ${Object.keys(data.persons).length} people, ${Object.keys(data.partnerships).length} partnerships, ${validation.stats.warnings} warnings`);
}

writeFixture('m0-complex-family.json', complexFamily());
for (const size of [100, 500, 1000]) {
    writeFixture(`m0-scale-${size}.json`, scaleFamily(size));
}
writeFixture('m0-current-limit-multi-parent.json', multiParentLimit());
