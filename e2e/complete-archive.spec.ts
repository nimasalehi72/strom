import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { addRelation, card, createFirstPerson, openApp, waitForPersist } from './helpers.js';

test('verified complete archive restores as new without touching the original tree', async ({ page }) => {
    await openApp(page);
    await createFirstPerson(page, 'ArchiveRoot', 'Synthetic');
    await addRelation(page, 'ArchiveRoot', 'child', 'ArchiveChild', 'Synthetic');
    await page.evaluate(() => {
        const person = window.Strom.DataManager.getAllPersons()
            .find((candidate: { firstName: string }) => candidate.firstName === 'ArchiveChild');
        if (!person) throw new Error('fixture person missing');
        window.Strom.DataManager.addAttachment(person.id, {
            name: 'proof.pdf', mimeType: 'application/pdf',
            dataUrl: 'data:application/pdf;base64,JVBERi0xLjQKJSVFT0YK', sizeBytes: 18,
        });
    });
    await waitForPersist(page, 'proof.pdf');

    await page.evaluate(() => window.Strom.UI.exportCompleteArchive());
    const password = page.locator('#export-password-modal');
    await expect(password).toBeVisible();
    await expect(password.getByRole('button', { name: 'Export without encryption' })).toBeHidden();
    await expect(password.locator('#export-privacy-section')).toBeHidden();
    await expect(password.locator('#export-content-section')).toBeHidden();
    await password.locator('#export-password-input').fill('archive-proof');
    await password.locator('#export-password-confirm').fill('archive-proof');
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        password.getByRole('button', { name: 'Export encrypted' }).click(),
    ]);
    const path = await download.path();
    const archive = JSON.parse(readFileSync(path, 'utf8'));
    expect(archive).toMatchObject({ encrypted: true, version: 1 });

    await page.locator('#file-input').setInputFiles(path);
    const unlock = page.locator('#password-prompt-modal');
    await expect(unlock).toBeVisible();
    await unlock.locator('#password-prompt-input').fill('archive-proof');
    await unlock.getByRole('button', { name: 'OK' }).click();
    const confirm = page.locator('#confirmation-modal');
    await expect(confirm).toBeVisible();
    await Promise.all([
        page.waitForEvent('load'),
        confirm.getByRole('button', { name: 'Yes' }).click(),
    ]);
    await expect(page.locator('.toolbar')).toBeVisible();
    expect(await page.evaluate(() => window.Strom.TreeManager.getActiveTreeId()))
        .toContain('_restored_');
    await expect(page.locator('.tree-switcher-btn .tree-name')).toContainText('(restored)');
    await expect(card(page, 'ArchiveRoot')).toBeVisible();
    await expect(card(page, 'ArchiveChild')).toBeVisible();

    const state = await page.evaluate(() => ({
        trees: window.Strom.TreeManager.getTrees().map((tree: { name: string }) => tree.name),
        attachment: window.Strom.DataManager.getAllPersons()
            .find((person: { firstName: string }) => person.firstName === 'ArchiveChild')
            ?.attachments?.[0]?.dataUrl,
    }));
    expect(state.trees).toHaveLength(2);
    expect(state.trees.some((name: string) => !name.includes('(restored)'))).toBe(true);
    expect(state.attachment).toBe('data:application/pdf;base64,JVBERi0xLjQKJSVFT0YK');
});

test('person editor stores other and unknown gender values', async ({ page }) => {
    await openApp(page);
    await page.locator('#empty-state button').first().click();
    const modal = page.locator('#person-modal');
    await modal.locator('#input-firstname').fill('Alex');
    await modal.locator('#input-lastname').fill('Synthetic');
    await modal.locator('[data-gender="other"]').click();
    await modal.getByRole('button', { name: 'Save' }).click();
    expect(await page.evaluate(() => window.Strom.DataManager.getAllPersons()[0].gender)).toBe('other');
    await expect(card(page, 'Alex')).toHaveClass(/other/);

    await card(page, 'Alex').click();
    await page.locator('.context-menu-item[data-action="edit"]').click();
    await modal.locator('[data-gender="unknown"]').click();
    await modal.getByRole('button', { name: 'Save' }).click();
    expect(await page.evaluate(() => window.Strom.DataManager.getAllPersons()[0].gender)).toBe('unknown');
    await expect(card(page, 'Alex')).toHaveClass(/unknown/);
});
