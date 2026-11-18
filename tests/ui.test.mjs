import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { startApp } from '../server/main.js';
import { setBase, boot, shot, withPage } from './ui-helpers.mjs';

const SHOTS = '/tmp/ui';
process.env.SHOT_DIR = SHOTS;

let app;

test.before(async () => {
  await mkdir(SHOTS, { recursive: true });
  if (process.env.BASE_URL) return;
  app = await startApp({ port: 0, sourcePort: 0, receiverPort: 0 });
  setBase(`http://127.0.0.1:${app.port}`);
});

test.after(async () => {
  await app?.close();
});

test('console renders sources, fields and the completeness promise', async () => {
  await withPage(async (page, errors) => {
    await boot(page);
    await page.click('#reset-demo');
    await page.waitForFunction(() => document.querySelectorAll('.badge.uncollected').length === 6);

    assert.equal(await page.locator('.source-card').count(), 3);
    assert.equal(await page.locator('#field-rows tr').count(), 6);
    assert.equal(await page.locator('#publish-complete').isDisabled(), true, 'cannot publish complete before collecting');
    await shot(page, '01-before-collect');

    await page.click('#collect-all');
    await page.waitForFunction(() => document.querySelector('#publish-complete') && !document.querySelector('#publish-complete').disabled, null, { timeout: 15000 });
    assert.equal(await page.locator('.badge.authorized').count() >= 5, true);
    assert.equal(await page.locator('#promise-body').textContent().then((text) => text.includes('可承诺完整')), true);
    await shot(page, '02-collected');
    assert.deepEqual(errors, []);
  });
});

test('a source that is explicitly cleared is not shown as missing', async () => {
  await withPage(async (page, errors) => {
    await boot(page);
    await page.selectOption('#record-select', 'SKU-1002');
    await page.waitForFunction(() => document.body.dataset.record === 'SKU-1002' && document.querySelectorAll('.badge.uncollected').length === 6);
    await page.click('#collect-all');
    await page.waitForFunction(() => document.querySelector('#promise-body')?.textContent.includes('可承诺完整'), null, { timeout: 15000 });
    const row = page.locator('tr[data-field-row="description"]');
    assert.match(await row.textContent(), /明确清空/);
    assert.match(await row.textContent(), /未采用/);
    await shot(page, '03-cleared-description');
    assert.deepEqual(errors, []);
  });
});

test('denied fields block a complete publish and the partial dialog is honest', async () => {
  await withPage(async (page, errors) => {
    await boot(page);
    await page.selectOption('#record-select', 'SKU-1004');
    await page.waitForFunction(() => document.body.dataset.record === 'SKU-1004' && document.querySelectorAll('.badge.uncollected').length === 6);
    await page.click('#collect-all');
    await page.waitForFunction(() => document.querySelectorAll('.badge.denied').length >= 2, null, { timeout: 15000 });
    assert.equal(await page.locator('#publish-complete').isDisabled(), true);
    assert.match(await page.locator('#promise-body').textContent(), /只能承诺部分/);
    // A refusal is a settled answer, not a gap: the waiting panel must say so
    // instead of implying these fields will arrive on their own.
    const promiseText = await page.locator('#promise-body').textContent();
    assert.match(promiseText, /没有字段在等待/);
    assert.match(promiseText, /未授权/);
    assert.doesNotMatch(promiseText, /每个字段都有明确结论/);
    await shot(page, '04-denied');

    await page.click('#publish-partial');
    await page.waitForSelector('#partial-dialog[open]');
    assert.match(await page.locator('#partial-summary').textContent(), /标题|Title/);
    await page.fill('#partial-note', '等待 Aurora 补标题');
    await shot(page, '05-partial-dialog');
    await page.click('#partial-confirm');
    await page.waitForFunction(() => document.querySelector('#publish-body')?.textContent.includes('部分'));
    await page.waitForFunction(() => document.querySelector('#banner-stack')?.textContent.includes('未承诺完整'));
    await page.waitForFunction(() => document.querySelector('#receiver-body')?.textContent.includes('下游还没有收到'));
    await page.click('#deliver-active');
    await page.waitForFunction(() => document.querySelector('#receiver-body')?.textContent.includes('rcpt-'), null, { timeout: 10000 });
    assert.match(await page.locator('#receiver-body').textContent(), /等待/);
    await shot(page, '06-partial-delivered');
    assert.deepEqual(errors, []);
  });
});

test('changing priority previews impact, refetches only those fields, and keeps old versions', async () => {
  await withPage(async (page, errors) => {
    await boot(page);
    await page.click('#reset-demo');
    await page.click('#collect-all');
    await page.waitForFunction(() => document.querySelector('#publish-complete') && !document.querySelector('#publish-complete').disabled, null, { timeout: 15000 });
    await page.click('#publish-complete');
    await page.waitForFunction(() => document.querySelector('#publish-body')?.textContent.includes('r1'));
    await page.click('#deliver-active');
    await page.waitForFunction(() => document.querySelector('#receiver-body')?.textContent.includes('rcpt-'), null, { timeout: 10000 });
    await shot(page, '07-baseline-published');

    // Move Cirrus up twice with the arrow buttons.
    await page.click('[data-move="cirrus"][data-dir="-1"]');
    await page.click('[data-move="cirrus"][data-dir="-1"]');
    await page.waitForSelector('[data-apply-priority]');
    const impactText = await page.locator('#priority-impact').textContent();
    assert.match(impactText, /将影响 3 个字段/);
    await shot(page, '08-priority-preview');

    await page.click('[data-apply-priority]');
    await page.waitForFunction(() => document.querySelector('#banner-stack')?.textContent.includes('补采完成'), null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('#publish-complete') && !document.querySelector('#publish-complete').disabled, null, { timeout: 15000 });
    await page.click('#publish-complete');
    await page.waitForFunction(() => document.querySelector('#publish-body')?.textContent.includes('r2'));
    const history = await page.locator('.history-list').textContent();
    assert.match(history, /r1/);
    assert.match(history, /r2/);

    // Old revision must still show the values it promised.
    await page.click('[data-view-pub]');
    await page.waitForSelector('dialog[open] .field-table');
    await shot(page, '09-old-revision');
    const dialogText = await page.locator('dialog[open]').textContent();
    assert.match(dialogText, /已被更新版本取代|当前生效/);
    assert.deepEqual(errors, []);
  });
});

test('disconnecting a source shows waiting, not missing, and blocks complete publish', async () => {
  await withPage(async (page, errors) => {
    await boot(page);
    await page.click('#reset-demo');
    await page.click('[data-source-action="online"][data-source-id="aurora"]');
    await page.waitForFunction(() => document.querySelector('#banner-stack')?.textContent.includes('已断开'));
    await page.click('[data-refetch-field="title"]');
    await page.waitForFunction(
      () => document.querySelector('tr[data-field-row="title"]')?.textContent.includes('等待中'),
      null,
      { timeout: 15000 },
    );
    const row = await page.locator('tr[data-field-row="title"]').textContent();
    assert.match(row, /Aurora/);
    assert.doesNotMatch(row, /已答复·缺失/);
    assert.equal(await page.locator('#publish-complete').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('#raw-list')?.textContent.includes('503'), null, { timeout: 10000 });
    await shot(page, '10-disconnected');

    await page.click('[data-source-action="online"][data-source-id="aurora"]');
    await page.waitForFunction(() => !document.querySelector('.source-card[data-source="aurora"]')?.classList.contains('is-offline'));
    await page.click('[data-refetch-field="title"]');
    await page.waitForFunction(() => document.querySelector('tr[data-field-row="title"]')?.textContent.includes('已授权'), null, { timeout: 15000 });
    await shot(page, '11-reconnected');
    assert.deepEqual(errors, []);
  });
});

test('a revision queued mid-refetch is surfaced and applied on the next pull', async () => {
  await withPage(async (page, errors) => {
    await boot(page);
    await page.click('#reset-demo');
    await page.click('#collect-all');
    await page.waitForFunction(() => document.querySelector('#publish-complete') && !document.querySelector('#publish-complete').disabled, null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('tr[data-field-row="title"]')?.textContent.includes('已授权'));

    await page.click('[data-source-action="revision"][data-source-id="aurora"]');
    await page.waitForSelector('#rev-queue');
    await page.selectOption('#rev-field', 'title');
    await page.fill('#rev-value', 'Nimbus Ceramic Mug · 补采途中修订');
    await page.click('#rev-queue');
    await page.waitForFunction(() => document.querySelector('#source-grid')?.textContent.includes('待回传 title'), null, { timeout: 10000 });
    assert.match(await page.locator('tr[data-field-row="title"]').textContent(), /来源有更新待取/);
    await shot(page, '12-revision-queued');

    await page.click('[data-refetch-field="title"]');
    await page.waitForFunction(
      () => document.querySelector('tr[data-field-row="title"]')?.textContent.includes('补采途中修订'),
      null,
      { timeout: 15000 },
    );
    await shot(page, '13-revision-applied');
    assert.deepEqual(errors, []);
  });
});

test('duplicate delivery through the UI leaves one receipt', async () => {
  await withPage(async (page, errors) => {
    await boot(page);
    await page.click('#reset-demo');
    await page.click('#collect-all');
    await page.waitForFunction(() => document.querySelector('#publish-complete') && !document.querySelector('#publish-complete').disabled, null, { timeout: 15000 });
    await page.click('#publish-complete');
    await page.waitForFunction(() => document.querySelector('#publish-body')?.textContent.includes('r1'));
    await page.click('#deliver-active');
    await page.waitForFunction(() => document.querySelectorAll('.receipt').length === 1, null, { timeout: 10000 });
    await page.click('#deliver-duplicate');
    await page.waitForFunction(() => document.querySelector('#receiver-body')?.textContent.includes('重复领取 1 次'), null, { timeout: 10000 });
    assert.equal(await page.locator('.receipt-list .receipt').count(), 1);
    await shot(page, '14-duplicate-delivery');
    assert.deepEqual(errors, []);
  });
});

test('the guided scenarios run end to end from the page', async () => {
  await withPage(async (page, errors) => {
    await boot(page);
    await page.click('#reset-demo');
    for (const id of ['disconnect', 'duplicate']) {
      await page.click(`[data-scenario="${id}"]`);
      await page.waitForFunction(() => document.querySelector('#scenario-status')?.textContent.includes('刚才的演示已完成'), null, { timeout: 40000 });
      await page.waitForFunction(() => !document.querySelector('[data-scenario]')?.disabled, null, { timeout: 40000 });
    }
    await shot(page, '15-scenarios');
    assert.deepEqual(errors, []);
  });
});
