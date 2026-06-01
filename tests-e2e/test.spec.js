// test.spec.js — Validation des 5 fixes critiques (session courante)
// Lancé via Docker : mcr.microsoft.com/playwright:v1.40.0-jammy
const { test, expect } = require('@playwright/test');

const BASE = 'http://host.docker.internal:3000';
const TABLE = 'dashdoc_kpi';
const TS = Date.now().toString().slice(-6);
const COL_A = 'tst_a_' + TS;
const COL_B = 'tst_b_' + TS;
const COL_E_SRC = 'tst_esrc_' + TS;
const COL_E = 'tst_e_' + TS;

// ─── helpers ──────────────────────────────────────────────────
async function gotoApp(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  // Force fresh load (cache-buster ?v=14)
  await page.goto(BASE, { waitUntil: 'networkidle' });
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
  await expect(page.locator('#dataTable')).toBeVisible({ timeout: 10_000 });
  await page.waitForSelector('th .th-letter', { timeout: 10_000 });
  await page.waitForSelector('td.cell', { timeout: 10_000 });
  // Wait HF instance ready
  await page.waitForFunction(() => typeof hf !== 'undefined' && hf !== null, null, { timeout: 10_000 });
}

async function createColumn(request, name, formula = null) {
  const body = { name, col_type: 'TEXT' };
  if (formula) body.formula = formula;
  return request.post(`${BASE}/api/table/${TABLE}/column`, { data: body });
}

async function deleteColumn(request, name) {
  try {
    await request.delete(`${BASE}/api/table/${TABLE}/column?column=${name}`);
  } catch (_) {}
}

async function findColIndex(page, name) {
  return page.evaluate((col) => {
    const ths = Array.from(document.querySelectorAll('th .th-name'));
    return ths.findIndex((el) => el.textContent.trim() === col);
  }, name);
}

async function setCellFormula(page, ri, ci, value) {
  const sel = `td.cell[data-row="${ri}"][data-col="${ci}"]`;
  await page.locator(sel).first().scrollIntoViewIfNeeded();
  await page.locator(sel).first().dblclick();
  await expect(page.locator('td.cell.editing input').first()).toBeVisible({ timeout: 5_000 });
  await page.evaluate((v) => {
    const inp = document.querySelector('td.cell.editing input');
    if (!inp) return;
    inp.value = v;
    inp.blur();
  }, value);
}

// ─── tests ────────────────────────────────────────────────────
test.describe('MHP DataSheet — 5 fixes critiques', () => {
  test.beforeAll(async ({ request }) => {
    // Cleanup résiduel d'une run précédente, juste au cas
    await deleteColumn(request, COL_A);
    await deleteColumn(request, COL_B);
    await deleteColumn(request, COL_E_SRC);
    await deleteColumn(request, COL_E);
  });

  test.afterAll(async ({ request }) => {
    await deleteColumn(request, COL_A);
    await deleteColumn(request, COL_B);
    await deleteColumn(request, COL_E_SRC);
    await deleteColumn(request, COL_E);
  });

  test('A. HyperFormula FR — =SOMME(B:B) renvoie 189 (pas de #NOM?)', async ({ page, request }) => {
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(e.message));

    // 1) créer la colonne via API (préalable)
    const cr = await createColumn(request, COL_A);
    expect(cr.ok(), 'POST /api/table/.../column should succeed').toBeTruthy();

    // 2) reload pour voir la colonne
    await gotoApp(page);
    await selectTable(page, TABLE);

    const ci = await findColIndex(page, COL_A);
    expect(ci, 'colonne ' + COL_A + ' présente').toBeGreaterThan(0);

    // 3) double-clic, tape =SOMME(B:B), blur
    await setCellFormula(page, 0, ci, '=SOMME(B:B)');
    await page.waitForTimeout(2000);

    // Diagnostic : tbody vidé / cellules disparues ?
    const diag = await page.evaluate(() => ({
      tbodyRows: document.querySelectorAll('tbody tr').length,
      cellCount: document.querySelectorAll('td.cell').length,
      newRow: document.querySelectorAll('tbody tr.new-row').length,
    }));
    console.log('[Test A] DOM diag après formule:', diag, 'JS errors:', jsErrors);

    if (diag.cellCount === 0 || jsErrors.some((e) => /Maximum call stack/i.test(e))) {
      throw new Error(
        'FIX A NON APPLIQUÉ — "Maximum call stack size exceeded" déclenché en tapant ' +
        '=SOMME(B:B) dans une cellule de la nouvelle colonne ' + COL_A + '. ' +
        'tbody vidé de ses td.cell (diag=' + JSON.stringify(diag) + '). ' +
        'JS errors : ' + JSON.stringify(jsErrors)
      );
    }

    // 4) vérifier la cellule
    const sel = `td.cell[data-row="0"][data-col="${ci}"]`;
    const txt = (await page.locator(sel).first().textContent({ timeout: 5_000 })).trim();
    console.log('[Test A] cellule (0,' + ci + ') =', JSON.stringify(txt), 'errors:', jsErrors);

    expect(txt, 'cellule ne doit pas afficher #NOM?/#NAME?').not.toMatch(/#NOM\?|#NAME\?|#ERROR|#REF/i);
    expect(txt.length, 'cellule ne doit pas être vide').toBeGreaterThan(0);
    // attendu : somme de nb_transports_crees (19+33+14+24+18+15+39+27 = 189)
    expect(txt, 'doit contenir un nombre').toMatch(/\d/);
    const num = parseFloat(txt.replace(/\s/g, '').replace(',', '.'));
    expect(Number.isFinite(num), 'doit être un nombre fini').toBeTruthy();
    expect(num, 'somme = 189').toBe(189);
  });

  test('B. Fill handle ajuste les références (=B1+C1 → =B2+C2…)', async ({ page, request }) => {
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(e.message));

    const cr = await createColumn(request, COL_B);
    expect(cr.ok()).toBeTruthy();

    await gotoApp(page);
    await selectTable(page, TABLE);

    const ci = await findColIndex(page, COL_B);
    expect(ci).toBeGreaterThan(0);

    // 1) =B1+C1 en row 0
    await setCellFormula(page, 0, ci, '=B1+C1');
    await page.waitForTimeout(1500);

    // Diagnostic : tbody vidé / cellules disparues ?
    const diag = await page.evaluate(() => ({
      tbodyRows: document.querySelectorAll('tbody tr').length,
      cellCount: document.querySelectorAll('td.cell').length,
    }));
    console.log('[Test B] DOM diag :', diag, 'JS errors:', jsErrors);
    if (diag.cellCount === 0 || jsErrors.some((e) => /Maximum call stack/i.test(e))) {
      throw new Error(
        'FIX B PRÉ-REQUIS NON SATISFAIT — même bug "Maximum call stack" que test A : ' +
        'impossible d\'évaluer =B1+C1 dans la cellule de ' + COL_B + ' (diag=' +
        JSON.stringify(diag) + ', errors=' + JSON.stringify(jsErrors) + ')'
      );
    }

    const sel0 = `td.cell[data-row="0"][data-col="${ci}"]`;
    const t0 = (await page.locator(sel0).first().textContent()).trim();
    console.log('[Test B] row 0 =', JSON.stringify(t0));
    const n0 = parseFloat(t0.replace(/\s/g, '').replace(',', '.'));
    expect(n0, 'row 0 doit valoir 2119 (19+2100)').toBe(2119);

    // 2) applyFillRange row 0 → row 3
    await page.evaluate(
      (args) => {
        const fn = (typeof applyFillRange === 'function') ? applyFillRange : window.applyFillRange;
        if (!fn) throw new Error('applyFillRange not exposed globally');
        fn(args.r, args.c, args.end);
      },
      { r: 0, c: ci, end: 3 }
    );
    await page.waitForTimeout(800);

    const tx = async (r) =>
      (await page.locator(`td.cell[data-row="${r}"][data-col="${ci}"]`).first().textContent()).trim();
    const t1 = await tx(1), t2 = await tx(2), t3 = await tx(3);
    console.log('[Test B] r1=' + t1 + ' r2=' + t2 + ' r3=' + t3);

    const num = (s) => parseFloat(s.replace(/\s/g, '').replace(',', '.'));
    expect(num(t1), 'row 1 = 2808 (33+2775)').toBe(2808);
    expect(num(t2), 'row 2 = 308 (14+294)').toBe(308);
    expect(num(t3), 'row 3 = 2889 (24+2865)').toBe(2889);
  });

  test('C. Autocomplete propose les lettres (B1 / B:B)', async ({ page }) => {
    await gotoApp(page);
    await selectTable(page, TABLE);

    const fbar = page.locator('#formulaInput');
    await fbar.click();
    await fbar.fill('');
    await page.keyboard.type('=', { delay: 60 });
    await page.keyboard.type('B', { delay: 80 });

    const dd = page.locator('#acDropdown');
    await expect(dd).toBeVisible({ timeout: 5_000 });

    const labels = await page.locator('#acDropdown .ac-item').allTextContents();
    console.log('[Test C] suggestions:', labels);
    expect(labels.length).toBeGreaterThanOrEqual(1);

    const joined = labels.join(' | ');
    expect(joined, 'au moins une suggestion contient B1 ou B:B').toMatch(/B1|B:B/);

    await page.keyboard.press('Escape');
  });

  test('D. Ctrl+D recopie depuis le haut', async ({ page }) => {
    await gotoApp(page);
    await selectTable(page, TABLE);

    // valeur de référence row 0 col 1 (nb_transports_crees = 19)
    const src = page.locator('td.cell[data-row="0"][data-col="1"]').first();
    const srcText = (await src.textContent()).trim();
    console.log('[Test D] srcText (row0,col1) =', JSON.stringify(srcText));

    // Sélectionne row 1 col 1
    const target = page.locator('td.cell[data-row="1"][data-col="1"]').first();
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await page.waitForTimeout(150);

    await page.keyboard.press('Control+d');
    await page.waitForTimeout(500);

    const t1 = (await page.locator('td.cell[data-row="1"][data-col="1"]').first().textContent()).trim();
    console.log('[Test D] après Ctrl+D row1 =', JSON.stringify(t1));
    expect(t1, 'row 1 col 1 doit être recopié depuis row 0').toBe(srcText);
  });

  test('E. Suppression colonne → cascade des formules dépendantes', async ({ request }) => {
    // ⚠️ Test API only (non destructif sur table prod : on crée 2 colonnes jetables)
    // 1) créer COL_E_SRC (source de la formule)
    const r1 = await createColumn(request, COL_E_SRC);
    expect(r1.ok(), 'create COL_E_SRC').toBeTruthy();

    // 2) créer COL_E avec une formule qui référence COL_E_SRC
    //    Note : COL_E_SRC est NULL au début → on l'initialise à '2' via une formule SQL
    const initSrc = await request.post(`${BASE}/api/formula/apply`, {
      data: { table: TABLE, column: COL_E_SRC, formula: "'2'" },
    });
    expect(initSrc.ok(), 'init COL_E_SRC').toBeTruthy();

    // 3) créer COL_E avec formule pfn(COL_E_SRC) * pfn(nb_transports_crees)
    const r2 = await createColumn(request, COL_E);
    expect(r2.ok()).toBeTruthy();
    const apply = await request.post(`${BASE}/api/formula/apply`, {
      data: { table: TABLE, column: COL_E, formula: `pfn(${COL_E_SRC}) * pfn(nb_transports_crees)` },
    });
    expect(apply.ok(), 'apply formula COL_E').toBeTruthy();

    // 4) vérifier que la formule est enregistrée et que les cellules ont une valeur (38, 66, 28...)
    const formulasResp = await request.get(`${BASE}/api/table/${TABLE}/formulas`);
    const formulas = await formulasResp.json();
    expect(formulas.formulas[COL_E], 'formule COL_E enregistrée').toContain(COL_E_SRC);

    const dataResp = await request.get(`${BASE}/api/table/${TABLE}?limit=4`);
    const data = await dataResp.json();
    const vals = data.rows.slice(0, 4).map((r) => r[COL_E]);
    console.log('[Test E] valeurs COL_E avant drop :', vals);
    // attendu : 38 (19*2), 66 (33*2), 28 (14*2), 48 (24*2)
    expect(parseFloat(vals[0])).toBe(38);

    // 5) DELETE de COL_E_SRC → broken_formulas_removed doit contenir 'dashdoc_kpi.COL_E'
    const del = await request.delete(`${BASE}/api/table/${TABLE}/column?column=${COL_E_SRC}`);
    expect(del.ok(), 'DELETE COL_E_SRC').toBeTruthy();
    const body = await del.json();
    console.log('[Test E] DELETE response:', body);

    const fq = `${TABLE}.${COL_E}`;
    expect(body.broken_formulas_removed, 'broken_formulas_removed doit lister la formule cascade').toContain(fq);
  });
});
