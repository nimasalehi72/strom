/** Repeatable M0 data, search, validation, and focused-layout benchmark. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runLayoutPipeline } from '../src/layout/pipeline/index.js';
import { filterPersons } from '../src/search-filter.js';
import { DEFAULT_LAYOUT_CONFIG, type PersonId, type StromData } from '../src/types.js';
import { validateTreeData } from '../src/validation.js';

interface Distribution {
    medianMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
}

function rounded(value: number): number {
    return Number(value.toFixed(3));
}

function distribution(values: number[]): Distribution {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    return {
        medianMs: rounded(at(0.5)),
        p95Ms: rounded(at(0.95)),
        minMs: rounded(sorted[0]),
        maxMs: rounded(sorted[sorted.length - 1]),
    };
}

function measure(iterations: number, operation: () => void): Distribution {
    operation();
    const samples: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
        const start = performance.now();
        operation();
        samples.push(performance.now() - start);
    }
    return distribution(samples);
}

const outputDir = resolve(process.cwd(), '..', 'docs', 'evidence');
mkdirSync(outputDir, { recursive: true });

const results: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    reference: {
        platform: platform(),
        osRelease: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        logicalCpus: cpus().length,
        memoryGiB: rounded(totalmem() / 1024 ** 3),
        node: process.version,
    },
    method: {
        warmupRuns: 1,
        measuredRuns: 20,
        layout: 'focused family view, ancestorDepth=5, descendantDepth=5, standard display',
    },
    fixtures: {},
};

for (const size of [100, 500, 1000]) {
    const fileName = `m0-scale-${size}.json`;
    const text = readFileSync(join(process.cwd(), 'test', fileName), 'utf8');
    const data = JSON.parse(text) as StromData;
    const focusPersonId = data.defaultPersonId as PersonId;
    const query = data.persons[Object.keys(data.persons).at(-1) as PersonId].firstName;

    const parse = measure(20, () => { JSON.parse(text); });
    const validate = measure(20, () => { validateTreeData(data); });
    const search = measure(20, () => { filterPersons(data, { query }, 2026); });
    let visiblePersons = 0;
    let visiblePartnerships = 0;
    const layout = measure(20, () => {
        const laidOut = runLayoutPipeline({
            data,
            focusPersonId,
            config: DEFAULT_LAYOUT_CONFIG,
            ancestorDepth: 5,
            descendantDepth: 5,
            includeSpouseAncestors: true,
            includeParentSiblings: true,
            includeParentSiblingDescendants: true,
            displayPolicy: { mode: 'standard', autoExpand: false },
        });
        visiblePersons = laidOut.positions.size;
        visiblePartnerships = laidOut.connections.length + laidOut.spouseLines.length;
    });

    (results.fixtures as Record<string, unknown>)[String(size)] = {
        bytes: Buffer.byteLength(text, 'utf8'),
        people: Object.keys(data.persons).length,
        partnerships: Object.keys(data.partnerships).length,
        visiblePersons,
        visibleEdges: visiblePartnerships,
        parse,
        validate,
        search,
        focusedLayout: layout,
    };
}

const outputPath = join(outputDir, 'm0-data-benchmarks.json');
writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(outputPath);
console.log(JSON.stringify(results.fixtures, null, 2));
