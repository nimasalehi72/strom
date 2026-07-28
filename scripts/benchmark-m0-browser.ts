/** Browser capability, screenshot, and 1,000-person interaction baseline. */

import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from '@playwright/test';

const appRoot = process.cwd();
const outputDir = resolve(appRoot, '..', 'docs', 'evidence');
mkdirSync(outputDir, { recursive: true });

async function waitForToolbar(page: Page): Promise<void> {
    await page.locator('.toolbar').waitFor({ state: 'visible' });
}

async function createFirstPerson(page: Page, firstName: string): Promise<void> {
    await page.locator('#empty-state button').first().click();
    const modal = page.locator('#person-modal');
    await modal.locator('#input-firstname').fill(firstName);
    await modal.locator('#input-lastname').fill('Persistence');
    await modal.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction((needle) => new Promise<boolean>((resolvePersisted) => {
        const request = indexedDB.open('strom-db');
        request.onsuccess = () => {
            const tx = request.result.transaction('trees', 'readonly');
            const all = tx.objectStore('trees').getAll();
            all.onsuccess = () => resolvePersisted(JSON.stringify(all.result).includes(needle));
            all.onerror = () => resolvePersisted(false);
        };
        request.onerror = () => resolvePersisted(false);
    }), firstName);
}

const html = readFileSync(join(appRoot, 'strom.html'));
const server = createServer((request, response) => {
    if (request.url === '/' || request.url?.startsWith('/strom.html')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(html);
        return;
    }
    response.writeHead(404);
    response.end();
});

await new Promise<void>((resolveListen) => server.listen(8200, '127.0.0.1', resolveListen));

const metrics: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    browser: 'Chromium via Playwright',
};

try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();

    let started = performance.now();
    await page.goto('http://127.0.0.1:8200/strom.html');
    await waitForToolbar(page);
    metrics.shellInteractiveMs = Number((performance.now() - started).toFixed(1));
    await page.screenshot({ path: join(outputDir, 'm0-desktop-empty.png'), fullPage: true });

    started = performance.now();
    await page.getByRole('button', { name: 'Try a sample tree' }).click();
    await page.locator('.person-card').first().waitFor({ state: 'visible' });
    metrics.sampleTreeVisibleMs = Number((performance.now() - started).toFixed(1));
    metrics.sampleVisibleCards = await page.locator('.person-card').count();
    await page.screenshot({ path: join(outputDir, 'm0-desktop-sample.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(outputDir, 'm0-mobile-sample.png'), fullPage: true });

    const scaleContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    const scalePage = await scaleContext.newPage();
    await scalePage.goto('http://127.0.0.1:8200/strom.html');
    await waitForToolbar(scalePage);

    started = performance.now();
    await scalePage.locator('#file-input').setInputFiles(join(appRoot, 'test', 'm0-scale-1000.json'));
    const importDialog = scalePage.locator('#import-tree-modal');
    await importDialog.waitFor({ state: 'visible' });
    await importDialog.locator('#import-tree-name').fill('M0 Scale 1000');
    await importDialog.getByRole('button', { name: 'Import' }).click();
    await importDialog.waitFor({ state: 'hidden' });
    await scalePage.waitForFunction(() => Object.keys(window.Strom.DataManager.getData().persons).length === 1000);
    await scalePage.locator('.person-card').first().waitFor({ state: 'visible' });
    metrics.importAndRender1000Ms = Number((performance.now() - started).toFixed(1));
    metrics.renderedCardsFor1000 = await scalePage.locator('.person-card').count();

    const searchName = await scalePage.evaluate(() => {
        const people = window.Strom.DataManager.getAllPersons();
        return people[people.length - 1].firstName;
    });
    const searchInput = scalePage.locator('#toolbar-search-picker .person-picker-input');
    started = performance.now();
    await searchInput.fill(searchName);
    const result = scalePage.locator('#toolbar-search-picker .person-picker-item', { hasText: searchName }).first();
    await result.waitFor({ state: 'visible' });
    metrics.searchSuggestion1000Ms = Number((performance.now() - started).toFixed(1));
    started = performance.now();
    await result.click();
    await scalePage.locator('.person-card.focused').waitFor({ state: 'visible' });
    metrics.searchFocus1000Ms = Number((performance.now() - started).toFixed(1));
    await scalePage.screenshot({ path: join(outputDir, 'm0-desktop-scale-1000.png'), fullPage: true });

    await context.close();
    await scaleContext.close();
    await browser.close();

    const profileDir = mkdtempSync(join(tmpdir(), 'strom-m0-profile-'));
    const filesDir = mkdtempSync(join(tmpdir(), 'strom-m0-files-'));
    const originalFile = join(filesDir, 'strom.html');
    const renamedFile = join(filesDir, 'strom-renamed.html');
    copyFileSync(join(appRoot, 'strom.html'), originalFile);
    copyFileSync(join(appRoot, 'strom.html'), renamedFile);

    try {
        let persistent = await chromium.launchPersistentContext(profileDir, { headless: true, locale: 'en-US' });
        let filePage = persistent.pages()[0] ?? await persistent.newPage();
        await filePage.goto(pathToFileURL(originalFile).href);
        await waitForToolbar(filePage);
        await createFirstPerson(filePage, 'M0Persisted');
        await filePage.reload();
        metrics.fileReloadPersistence = await filePage.locator('.person-card', { hasText: 'M0Persisted' }).isVisible();
        await persistent.close();

        persistent = await chromium.launchPersistentContext(profileDir, { headless: true, locale: 'en-US' });
        filePage = persistent.pages()[0] ?? await persistent.newPage();
        await filePage.goto(pathToFileURL(originalFile).href);
        await waitForToolbar(filePage);
        metrics.browserRestartPersistence = await filePage.locator('.person-card', { hasText: 'M0Persisted' }).isVisible();
        await filePage.goto(pathToFileURL(renamedFile).href);
        await waitForToolbar(filePage);
        metrics.renamedFileSharesStorage = await filePage.locator('.person-card', { hasText: 'M0Persisted' }).isVisible();
        await persistent.close();
    } finally {
        for (const tempPath of [profileDir, filesDir]) {
            const resolved = resolve(tempPath);
            if (!resolved.startsWith(resolve(tmpdir())) || !basename(resolved).startsWith('strom-m0-')) {
                throw new Error(`Refusing to remove unexpected temp path: ${resolved}`);
            }
            rmSync(resolved, { recursive: true, force: true });
        }
    }
} finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
}

const outputPath = join(outputDir, 'm0-browser-metrics.json');
writeFileSync(outputPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
console.log(outputPath);
console.log(JSON.stringify(metrics, null, 2));
