// test.spec.js — Smoke E2E pour MHP DataSheet
// Lancé via Docker : mcr.microsoft.com/playwright:v1.40.0-jammy
const { test, expect } = require('@playwright/test');

const BASE = 'http://host.docker.internal:3000';
const TEST_COL = 'qa_test_col_' + Date.now().toString().slice(-6);
const TEST_TABLE = 'stock_it';

// Helpers
async function gotoApp(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // Wait health pill text update
  await expect(page.locator('#statusText')).toHaveText(/PostgreSQL connecté|BD :/i, { timeout: 10_000 });
  return errors;
}

async function selectTable(page, tableName) {
  await page.waitForFunction(
    (name) => {
      const sel = document.getElementById('tableSelect');
      return sel && Array.from(sel.options).some((o) => o.value === name);
    },
    tableName,
    { timeout: 10_000 }
  );
  await page.selectOption('#tableSelect', tableName);
  // Wait table fully rendered
  await expect(page.locator('#dataTable')).toBeVisible({ timeout: 10_000 });
  await page.waitForSelector('th .th-letter', { timeout: 10_000 });
  await page.waitForSelector('td.cell', { timeout: 10_000 });
}

test.describe('MHP DataSheet — smoke E2E', () => {
  test.afterAll(async ({ request }) => {
    // Cleanup : drop test column
    try {
      await request.delete(`${BASE}/api/table/${TEST_TABLE}/column?column=${TEST_COL}`);
    } catch (_) {}
  });

  test('1. page se charge sans erreur JS + statut OK', async ({ page }) => {
    const errors = await gotoApp(page);
    await expect(page.locator('.status-pill')).toBeVisible();
    await expect(page.locator('#statusText')).toContainText('PostgreSQL connecté');
    expect(errors, 'console / page errors').toEqual([]);
  });

  test('2. sélecteur de tables contient >= 5 options', async ({ page }) => {
    await gotoApp(page);
    // Wait options to be populated
    await page.waitForFunction(() => {
      const sel = document.getElementById('tableSelect');
      return sel && sel.options.length >= 5;
    }, null, { timeout: 10_000 });
    const count = await page.$$eval('#tableSelect option', (o) => o.length);
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('3. charger stock_it → en-têtes A/B/C/D présents', async ({ page }) => {
    await gotoApp(page);
    await selectTable(page, TEST_TABLE);
    const letters = await page.$$eval('th .th-letter', (els) => els.map((e) => e.textContent.trim()));
    expect(letters.length).toBeGreaterThanOrEqual(4);
    expect(letters.slice(0, 4)).toEqual(['A', 'B', 'C', 'D']);
    const names = await page.$$eval('th .th-name', (els) => els.length);
    expect(names).toBeGreaterThanOrEqual(4);
  });

  test('4. HyperFormula FR : =SOMME(palettes_entree) renvoie un nombre', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(e.message));

    await gotoApp(page);
    await selectTable(page, TEST_TABLE);

    // Crée la colonne (scope du test + cleanup en afterAll)
    await page.click('#btnAddCol');
    await expect(page.locator('#addColModal')).toBeVisible();
    await page.fill('#newColName', TEST_COL);
    await page.selectOption('#newColType', 'TEXT');
    await page.fill('#newColFormula', '');
    const respCreate = page.waitForResponse((r) => r.url().includes('/api/table/') && r.url().includes('/column') && r.request().method() === 'POST');
    await page.click('#btnCreateColumn');
    await respCreate;
    await page.waitForFunction(
      (col) => Array.from(document.querySelectorAll('th .th-name')).some((el) => el.textContent.includes(col)),
      TEST_COL,
      { timeout: 10_000 }
    );

    // Trouve le colIndex puis tape la formule dans la cellule
    const colIndex = await page.evaluate((col) => {
      const ths = Array.from(document.querySelectorAll('th .th-name'));
      return ths.findIndex((el) => el.textContent.includes(col));
    }, TEST_COL);
    expect(colIndex).toBeGreaterThan(0);

    const cellSel = `td.cell[data-row="0"][data-col="${colIndex}"]`;
    await page.locator(cellSel).first().scrollIntoViewIfNeeded();
    await page.locator(cellSel).first().dblclick();
    await expect(page.locator('td.cell input').first()).toBeVisible({ timeout: 5_000 });
    // Set value silencieusement + blur (commit via stopEdit blur handler)
    await page.evaluate(() => {
      const inp = document.querySelector('td.cell.editing input');
      if (!inp) return;
      inp.value = '=SOMME(palettes_entree)';
      inp.blur();
    });
    await page.waitForTimeout(2000);

    // Détecte le bug connu (tbody vidé après formule cellule sur new col)
    const bodyEmpty = await page.locator('tbody tr.new-row').count() === await page.locator('tbody tr').count();
    if (bodyEmpty || jsErrors.some((e) => /Maximum call stack/i.test(e))) {
      throw new Error(
        'FRONTEND BUG DÉTECTÉ : =SOMME(palettes_entree) dans une cellule de la nouvelle ' +
        'colonne provoque "Maximum call stack size exceeded" → tbody vidé. ' +
        'Erreurs JS capturées : ' + JSON.stringify(jsErrors)
      );
    }

    const txt = (await page.locator(cellSel).first().textContent({ timeout: 5_000 })).trim();
    expect(txt).not.toMatch(/#NAME\?|#ERREUR!|#NOM\?|#NOMBRE!/i);
    expect(txt).toMatch(/\d/);
  });

  test('5. autocomplete : =SOMME(B → dropdown .ac-dropdown visible', async ({ page }) => {
    await gotoApp(page);
    await selectTable(page, TEST_TABLE);
    // Utilise la formula bar (toujours présente) plutôt qu'une cellule
    const fbar = page.locator('#formulaInput');
    await fbar.click();
    await fbar.fill('');
    await page.keyboard.type('=SOMME(B', { delay: 80 });
    const dd = page.locator('#acDropdown');
    await expect(dd).toBeVisible({ timeout: 5_000 });
    const items = await page.locator('#acDropdown .ac-item').count();
    expect(items).toBeGreaterThanOrEqual(1);
    await page.keyboard.press('Escape');
  });

  test('6. fill handle visible + drag simulé recopie sur 3 lignes', async ({ page }) => {
    await gotoApp(page);
    await selectTable(page, TEST_TABLE);
    // Click cellule source (row 0, col 1)
    const src = page.locator('td.cell[data-row="0"][data-col="1"]').first();
    await src.scrollIntoViewIfNeeded();
    await src.click();
    // Le fill handle DOIT être présent et visible
    await expect(page.locator('.cell-fill-handle')).toBeVisible({ timeout: 5_000 });
    const srcText = (await src.textContent()).trim();

    // Drag déterministe : on déclenche directement applyFillRange via page.evaluate
    // (les events natifs mousemove via Playwright ne déclenchent pas elementFromPoint
    //  de façon fiable au-dessus d'un overlay).
    await page.evaluate(() => {
      // Accès aux fonctions globales exposées par app.js
      if (typeof applyFillRange === 'function') {
        applyFillRange(0, 1, 3);
      } else {
        // Fallback : dispatch via window
        window.applyFillRange && window.applyFillRange(0, 1, 3);
      }
    });
    await page.waitForTimeout(400);

    for (let r = 1; r <= 3; r++) {
      const t = (await page.locator(`td.cell[data-row="${r}"][data-col="1"]`).first().textContent()).trim();
      expect(t, `row ${r} should equal source "${srcText}"`).toBe(srcText);
    }
  });

  test('7. Ctrl+S → POST /api/cells/batch', async ({ page }) => {
    await gotoApp(page);
    await selectTable(page, TEST_TABLE);

    // Modifie une cellule (row 0, col 8 = "client", colonne texte safe)
    const cell = page.locator('td.cell[data-row="0"][data-col="8"]').first();
    await cell.scrollIntoViewIfNeeded();
    await cell.dblclick();
    const input = page.locator('td.cell input').first();
    await expect(input).toBeVisible();
    const newVal = 'QA_' + Date.now();
    // Définit la valeur + commit par blur (pas d'autocomplete sur valeur non '=')
    await page.evaluate((v) => {
      const inp = document.querySelector('td.cell.editing input');
      if (!inp) return;
      inp.value = v;
      inp.blur();
    }, newVal);
    await page.waitForTimeout(400);

    const respPromise = page.waitForResponse(
      (r) => r.url().includes('/api/cells/batch') && r.request().method() === 'PUT',
      { timeout: 6_000 }
    );
    await page.keyboard.press('Control+s');
    const resp = await respPromise;
    expect(resp.status()).toBeGreaterThanOrEqual(200);
    expect(resp.status()).toBeLessThan(400);
  });

  test('8. Modal Scripts s\'ouvre via menu Outils', async ({ page }) => {
    await gotoApp(page);
    await page.click('#btnTools');
    await expect(page.locator('#toolsPanel')).toBeVisible();
    await page.click('#btnScripts');
    await expect(page.locator('#scriptsModal')).toBeVisible({ timeout: 5_000 });
    // Liste de scripts présente (peut être vide mais le DOM existe)
    await expect(page.locator('#scrList')).toBeVisible();
  });

  test('9. Modal Intégrations + status Google non configuré', async ({ page }) => {
    await gotoApp(page);
    await page.click('#btnTools');
    await expect(page.locator('#toolsPanel')).toBeVisible();
    await page.click('#btnIntegrations');
    await expect(page.locator('#integrationsModal')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(800);
    const statusTxt = (await page.locator('#googleStatus').textContent()).trim();
    expect(statusTxt.length).toBeGreaterThan(0);
    expect(statusTxt).toMatch(/Non configuré|Non connecté|Connecté|configur/i);
  });
});
