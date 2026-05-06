'use strict';

// ============================================================
//  MHP DataSheet — frontend
//  Deux moteurs de formules :
//   - SQL colonne : appliqué par PostgreSQL sur toutes les lignes
//   - Cellule "=..." : évalué côté navigateur via HyperFormula (Sheets-compatible, FR)
// ============================================================
const API = '/api';
const SIDEBAR_KEY = 'mhp.sidebar.collapsed';

// ─── State ──────────────────────────────────────────────────
const state = {
  table: '',
  columns: [],
  colNames: [],
  colTypes: {},
  rows: [],
  rowKeys: [],
  formulas: {},          // { col: 'sql expr' } — formules SQL colonne
  primaryCol: '',
  total: 0,
  limit: 500,
  offset: 0,
  pending: new Map(),
  selectedCell: null,
  editingCell: null,
  sort: null,        // { ci, dir: 'asc' | 'desc' }
  filters: {},       // { [ci]: 'searchText' }
};

let hf = null;            // HyperFormula instance
let hfReady = false;

// ─── DOM helpers ────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const escapeHTML = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

function colLetter(n) {
  let s = '';
  n++;
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// ============================================================
//  HyperFormula
// ============================================================
function isFormulaText(v) {
  return typeof v === 'string' && v.trim().startsWith('=');
}

function toHFValue(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  if (isFormulaText(s)) return s;
  // Convertit chiffres FR ("11 707,00") en number pour que SOMME etc. fonctionnent
  const cleaned = s.replace(/\s/g, '').replace(',', '.');
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned);
  return s;
}

function rebuildHF() {
  if (typeof HyperFormula === 'undefined') {
    hfReady = false;
    return;
  }
  if (hf) { try { hf.destroy(); } catch {} hf = null; }
  try {
    if (typeof HyperFormulaLanguages !== 'undefined' && HyperFormulaLanguages.frFR) {
      try { HyperFormula.registerLanguage('frFR', HyperFormulaLanguages.frFR); } catch {}
    }
    const data2d = state.rows.map((row) =>
      state.colNames.map((col) => toHFValue(row[col]))
    );
    hf = HyperFormula.buildFromArray(data2d, {
      licenseKey: 'gpl-v3',
      language: (typeof HyperFormulaLanguages !== 'undefined' && HyperFormulaLanguages.frFR) ? 'frFR' : 'enGB',
    });
    // Plages nommées : =SOMME(palettes_entree) plutôt que =SOMME(B:B)
    state.colNames.forEach((col, ci) => {
      const letter = colLetter(ci);
      try { hf.addNamedExpression(col, `=Sheet1!${letter}:${letter}`); } catch {}
    });
    hfReady = true;
  } catch (e) {
    console.error('HyperFormula init failed', e);
    hfReady = false;
  }
}

function updateHFCell(ri, ci, raw) {
  if (!hfReady) return [];
  try {
    return hf.setCellContents({ sheet: 0, col: ci, row: ri }, [[toHFValue(raw)]]);
  } catch (e) {
    console.warn('HF update failed', e);
    return [];
  }
}

function getDisplayValue(ri, ci) {
  const col = state.colNames[ci];
  const raw = state.rows[ri] ? state.rows[ri][col] : '';
  if (raw == null || raw === '') return { text: '', isFormula: false, isError: false };
  const s = String(raw);
  if (isFormulaText(s) && hfReady) {
    let v;
    try { v = hf.getCellValue({ sheet: 0, col: ci, row: ri }); }
    catch { return { text: '#ERR', isFormula: true, isError: true }; }
    return formatHFValue(v, true);
  }
  return { text: s, isFormula: false, isError: false };
}

function formatHFValue(v, isFormula) {
  if (v == null) return { text: '', isFormula, isError: false };
  if (typeof v === 'object') {
    // DetailedCellError : { type: 'NAME', value: '#NAME?', message: '...' }
    const text = v.value || ('#' + (v.type || 'ERR'));
    return { text, isFormula, isError: true };
  }
  if (typeof v === 'number') {
    const text = Number.isInteger(v)
      ? v.toLocaleString('fr-FR')
      : v.toLocaleString('fr-FR', { maximumFractionDigits: 6 });
    return { text, isFormula, isError: false };
  }
  if (typeof v === 'boolean') return { text: v ? 'VRAI' : 'FAUX', isFormula, isError: false };
  return { text: String(v), isFormula, isError: false };
}

// ============================================================
//  AUTOCOMPLETE  (fonctions + noms de colonnes)
// ============================================================
const ac = {
  el: null,        // <div id="acDropdown">
  input: null,     // input courant
  items: [],
  selected: 0,
  tokenStart: 0,
  tokenEnd: 0,
  visible: false,
};

const TOKEN_STOPS = /[\s,;()[\]+\-*/<>=!&|^%:"]/;

function getTokenAtCursor(text, pos) {
  let start = pos;
  while (start > 0 && !TOKEN_STOPS.test(text[start - 1])) start--;
  return { token: text.substring(start, pos), start, end: pos };
}

function buildSuggestions(token) {
  const t = token.trim();
  if (!t) return [];
  const upper = t.toUpperCase();
  const lower = t.toLowerCase();
  const fnMatches = FORMULAS
    .filter((f) => f.name.startsWith(upper) || f.en.startsWith(upper))
    .slice(0, 10)
    .map((f) => ({ kind: 'fn', ...f }));
  const colMatches = state.colNames
    .filter((c) => c.toLowerCase().startsWith(lower) && c.toLowerCase() !== lower)
    .slice(0, 8)
    .map((c) => ({ kind: 'col', name: c, type_pg: state.colTypes[c] || 'text' }));
  // Si la 1re lettre est upper-case → favorise fonctions, sinon colonnes
  const isUpper = t[0] === t[0].toUpperCase() && /[A-Z]/.test(t[0]);
  return isUpper ? [...fnMatches, ...colMatches] : [...colMatches, ...fnMatches];
}

function attachAutocomplete(input) {
  if (!input) return;
  if (input.dataset.acAttached === '1') return;
  input.dataset.acAttached = '1';
  input.addEventListener('input', () => acRefresh(input));
  input.addEventListener('keydown', (e) => acHandleKey(e, input));
  input.addEventListener('blur', () => setTimeout(acHide, 150));
}

const TOP_FORMULAS = ['SOMME', 'MOYENNE', 'SI', 'NB.SI', 'RECHERCHEV', 'MIN', 'MAX', 'CONCATENER', 'SOMME.SI', 'SI.CONDITIONS', 'SIERREUR'];

function acRefresh(input) {
  const value = input.value;
  const pos = input.selectionStart || 0;

  if (!value.trim().startsWith('=')) { acHide(); return; }

  // Cas spécial : juste `=` → propose les fonctions les plus utiles
  if (value.trim() === '=' && pos === value.length) {
    const items = TOP_FORMULAS
      .map((n) => FORMULAS_BY_NAME[n])
      .filter(Boolean)
      .map((f) => ({ kind: 'fn', ...f }));
    ac.input = input;
    ac.items = items;
    ac.selected = 0;
    ac.tokenStart = pos;
    ac.tokenEnd = pos;
    acRender();
    acPosition(input);
    acShow();
    return;
  }

  const { token, start, end } = getTokenAtCursor(value, pos);
  if (!token) { acHide(); return; }

  const items = buildSuggestions(token);
  if (items.length === 0) { acHide(); return; }

  ac.input = input;
  ac.items = items;
  ac.selected = 0;
  ac.tokenStart = start;
  ac.tokenEnd = end;
  acRender();
  acPosition(input);
  acShow();
}

function acRender() {
  ac.el.innerHTML = ac.items.map((it, i) => {
    const active = i === ac.selected ? 'ac-active' : '';
    if (it.kind === 'fn') {
      return `
        <div class="ac-item ${active}" data-idx="${i}">
          <span class="ac-icon ac-fn">ƒ</span>
          <span class="ac-name">${escapeHTML(it.name)}</span>
          <span class="ac-sig">${escapeHTML((FORMULA_CATEGORIES[it.cat] || {}).label || '')}</span>
          <span class="ac-desc">${escapeHTML(it.short)}</span>
        </div>`;
    }
    return `
      <div class="ac-item ${active}" data-idx="${i}">
        <span class="ac-icon ac-col">▦</span>
        <span class="ac-name">${escapeHTML(it.name)}</span>
        <span class="ac-sig">${escapeHTML(it.type_pg)}</span>
        <span class="ac-desc">colonne</span>
      </div>`;
  }).join('') + `
    <div class="ac-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span>
      <span><kbd>Tab</kbd>/<kbd>Entrée</kbd> insérer</span>
      <span><kbd>Esc</kbd> fermer</span>
    </div>`;
  // Click handlers
  ac.el.querySelectorAll('.ac-item').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      acApply(parseInt(el.dataset.idx, 10));
    });
  });
}

function acPosition(input) {
  const r = input.getBoundingClientRect();
  // Place sous le champ; si pas la place, au-dessus
  const dropH = 280;
  const winH = window.innerHeight;
  let top = r.bottom + 4;
  if (top + dropH > winH) top = Math.max(8, r.top - dropH - 4);
  let left = r.left;
  const winW = window.innerWidth;
  if (left + 320 > winW) left = winW - 340;
  ac.el.style.top = top + 'px';
  ac.el.style.left = left + 'px';
}

function acShow() { ac.el.classList.remove('hidden'); ac.visible = true; }
function acHide() {
  if (!ac.el) return;
  ac.el.classList.add('hidden');
  ac.visible = false;
  ac.input = null;
}

function acHandleKey(e, input) {
  if (!ac.visible) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    ac.selected = (ac.selected + 1) % ac.items.length;
    acRender();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    ac.selected = (ac.selected - 1 + ac.items.length) % ac.items.length;
    acRender();
  } else if (e.key === 'Tab' || e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    acApply(ac.selected);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    acHide();
  }
}

function acApply(idx) {
  const it = ac.items[idx];
  if (!it || !ac.input) return;
  const before = ac.input.value.substring(0, ac.tokenStart);
  const after = ac.input.value.substring(ac.tokenEnd);
  let insertion;
  let cursorOffset;
  if (it.kind === 'fn') {
    insertion = it.name + '(';
    cursorOffset = insertion.length;
  } else {
    insertion = it.name;
    cursorOffset = insertion.length;
  }
  ac.input.value = before + insertion + after;
  const newPos = before.length + cursorOffset;
  ac.input.setSelectionRange(newPos, newPos);
  // Maj. de la barre de formule si on édite une cellule
  if (ac.input !== $('formulaInput')) $('formulaInput').value = ac.input.value;
  acHide();
  // Re-déclenche (ex: après '(' on pourrait suggérer des colonnes)
  setTimeout(() => acRefresh(ac.input || $('formulaInput')), 0);
}

// ============================================================
//  BIBLIOTHÈQUE DE FORMULES (modal)
// ============================================================
const lib = {
  selectedCat: 'all',
  selectedFn: null,
  search: '',
};

function openLibModal() {
  $('libModal').classList.remove('hidden');
  libRenderCats();
  libRenderList();
  setTimeout(() => $('libSearch').focus(), 50);
}

function libRenderCats() {
  const counts = {};
  FORMULAS.forEach((f) => { counts[f.cat] = (counts[f.cat] || 0) + 1; });
  const cats = [
    `<div class="lib-cat ${lib.selectedCat === 'all' ? 'active' : ''}" data-cat="all">
       <span class="lib-cat-icon">★</span> Toutes <span class="lib-cat-count">${FORMULAS.length}</span>
     </div>`,
    ...Object.entries(FORMULA_CATEGORIES).map(([key, c]) => `
      <div class="lib-cat ${lib.selectedCat === key ? 'active' : ''}" data-cat="${key}">
        <span class="lib-cat-icon" style="color:${c.color}">${c.icon}</span>
        ${escapeHTML(c.label)}
        <span class="lib-cat-count">${counts[key] || 0}</span>
      </div>`),
  ].join('');
  $('libCats').innerHTML = cats;
  $('libCats').querySelectorAll('.lib-cat').forEach((el) => {
    el.addEventListener('click', () => {
      lib.selectedCat = el.dataset.cat;
      libRenderCats();
      libRenderList();
    });
  });
}

function libRenderList() {
  const q = lib.search.trim().toLowerCase();
  const filtered = FORMULAS.filter((f) => {
    if (lib.selectedCat !== 'all' && f.cat !== lib.selectedCat) return false;
    if (!q) return true;
    return f.name.toLowerCase().includes(q)
        || f.en.toLowerCase().includes(q)
        || f.short.toLowerCase().includes(q)
        || f.desc.toLowerCase().includes(q);
  });
  if (filtered.length === 0) {
    $('libList').innerHTML = `<div class="lib-empty">Aucune formule trouvée</div>`;
    return;
  }
  $('libList').innerHTML = filtered.map((f) => `
    <div class="lib-item ${lib.selectedFn === f.name ? 'active' : ''}" data-name="${f.name}">
      <div class="lib-item-name">${escapeHTML(f.name)}</div>
      <div class="lib-item-short">${escapeHTML(f.short)}</div>
    </div>
  `).join('');
  $('libList').querySelectorAll('.lib-item').forEach((el) => {
    el.addEventListener('click', () => {
      lib.selectedFn = el.dataset.name;
      libRenderList();
      libRenderDetail();
    });
  });
  if (lib.selectedFn && !filtered.find((f) => f.name === lib.selectedFn)) {
    lib.selectedFn = null;
    libRenderDetail();
  }
}

function libRenderDetail() {
  const f = FORMULAS_BY_NAME[lib.selectedFn];
  if (!f) {
    $('libDetail').innerHTML = `<div class="lib-detail-empty">← Sélectionne une formule pour voir sa fiche</div>`;
    return;
  }
  const cat = FORMULA_CATEGORIES[f.cat] || {};
  $('libDetail').innerHTML = `
    <h4>${escapeHTML(f.name)}</h4>
    <div class="lib-en">≡ ${escapeHTML(f.en)} (Excel/Sheets) · ${escapeHTML(cat.label || '')}</div>

    <div class="lib-block">
      <div class="lib-block-label">Signature</div>
      <div class="lib-sig">${escapeHTML(f.sig)}</div>
    </div>

    <div class="lib-block">
      <div class="lib-block-label">Description</div>
      <div class="lib-desc">${escapeHTML(f.desc)}</div>
    </div>

    <div class="lib-block">
      <div class="lib-block-label">Exemple</div>
      <div class="lib-example">${escapeHTML(f.example)}</div>
    </div>

    <div class="lib-insert-row">
      <button class="btn btn-primary" id="libBtnInsert">Insérer dans la cellule sélectionnée</button>
      <button class="btn btn-ghost" id="libBtnCopy">📋 Copier l'exemple</button>
    </div>
  `;
  $('libBtnInsert').addEventListener('click', () => libInsertFn(f));
  $('libBtnCopy').addEventListener('click', () => {
    navigator.clipboard.writeText(f.example);
    toast('Exemple copié', 'green');
  });
}

function libInsertFn(f) {
  const insertion = f.name + '(';
  // Cible : input éditable de la cellule sélectionnée si en édition,
  // sinon barre de formule (et on l'applique sur la cellule sélectionnée)
  if (state.editingCell) {
    const inp = state.editingCell.td.querySelector('input');
    if (inp) {
      const pos = inp.selectionStart || 0;
      const before = inp.value.substring(0, pos);
      const after = inp.value.substring(pos);
      const prefix = before.startsWith('=') ? '' : '=';
      inp.value = before + (before === '' ? prefix : '') + insertion + after;
      const newPos = (before + (before === '' ? prefix : '') + insertion).length;
      inp.setSelectionRange(newPos, newPos);
      $('formulaInput').value = inp.value;
      closeModal('libModal');
      inp.focus();
      return;
    }
  }
  if (state.selectedCell) {
    const fbar = $('formulaInput');
    const current = fbar.value;
    const newVal = (current.startsWith('=') ? current : '=') + insertion;
    fbar.value = newVal;
    closeModal('libModal');
    fbar.focus();
    fbar.setSelectionRange(newVal.length, newVal.length);
    acRefresh(fbar);
    return;
  }
  // Aucune cellule sélectionnée
  navigator.clipboard.writeText('=' + insertion);
  closeModal('libModal');
  toast('Aucune cellule sélectionnée — formule copiée dans le presse-papier', 'orange');
}
// ============================================================
//  HTTP layer (auth désactivée — accès libre via Nginx interne)
// ============================================================
async function api(path, opts = {}) {
  const headers = {
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  const r = await fetch(API + path, { ...opts, headers });
  let body = null;
  const text = await r.text();
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!r.ok) {
    const detail = (body && body.detail) || body || r.statusText;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return body;
}

// ============================================================
//  Init
// ============================================================
async function init() {
  ac.el = $('acDropdown');
  bindGlobalEvents();
  applySidebarStateFromStorage();
  attachAutocomplete($('formulaInput'));
  try {
    await checkHealth();
    await loadTables();
  } catch (e) {
    console.error(e);
    $('loadingMsg').innerHTML = `<span style="color:var(--red)">❌ ${escapeHTML(e.message)}</span>`;
  }
}

async function checkHealth() {
  try {
    const h = await api('/health');
    if (h.status === 'ok') {
      $('statusDot').classList.remove('error');
      $('statusText').textContent = 'PostgreSQL connecté';
    } else {
      $('statusDot').classList.add('error');
      $('statusText').textContent = 'BD : ' + (h.db || 'erreur');
    }
  } catch {
    $('statusDot').classList.add('error');
    $('statusText').textContent = 'Hors ligne';
  }
}

async function loadTables() {
  const d = await api('/tables');
  const sel = $('tableSelect');
  sel.innerHTML = d.tables.map((t) => `<option value="${escapeHTML(t)}">${escapeHTML(t)}</option>`).join('');
  if (d.tables.length > 0) await loadTable(d.tables[0]);
  else $('loadingMsg').textContent = 'Aucune table dans cette base.';
}

async function loadTable(name, { resetOffset = true, resetView = true } = {}) {
  if (!name) return;
  const isNewTable = state.table !== name;
  state.table = name;
  if (resetOffset) state.offset = 0;
  // Quand on change de table, on remet le tri/filtre à zéro
  if (isNewTable && resetView) { state.sort = null; state.filters = {}; }
  $('tableNameInfo').textContent = name;
  $('sqlQuery').textContent = `SELECT * FROM "${name}" LIMIT ${state.limit} OFFSET ${state.offset}`;
  $('loadingMsg').classList.remove('hidden');
  $('dataTable').classList.add('hidden');

  state.pending.clear();
  state.undoStack = [];
  closeColumnMenu();
  updatePendingCount();

  try {
    const data = await api(`/table/${encodeURIComponent(name)}?limit=${state.limit}&offset=${state.offset}`);
    state.columns = data.columns;
    state.colNames = data.columns.map((c) => c.name);
    state.colTypes = Object.fromEntries(data.columns.map((c) => [c.name, c.type]));
    state.formulas = Object.fromEntries(
      data.columns.filter((c) => c.has_formula).map((c) => [c.name, '...'])
    );
    state.primaryCol = state.colNames[0];
    state.rows = data.rows;
    state.rowKeys = data.rows.map((r) => r[state.primaryCol] != null ? String(r[state.primaryCol]) : '');
    state.total = data.total;

    rebuildHF();

    api(`/table/${encodeURIComponent(name)}/formulas`).then((f) => {
      state.formulas = f.formulas || {};
      renderTable();
    }).catch(() => {});

    $('rowCount').textContent =
      `${state.total.toLocaleString('fr-FR')} lignes totales · ${state.rows.length} affichées (offset ${state.offset})`;
    renderTable();
    $('loadingMsg').classList.add('hidden');
    $('dataTable').classList.remove('hidden');
    $('statRows').textContent = state.rows.length;
    toast(`✓ ${name} chargée (${state.rows.length} lignes)`, 'green');
  } catch (e) {
    $('loadingMsg').innerHTML = `<span style="color:var(--red)">❌ ${escapeHTML(e.message)}</span>`;
    toast(e.message, 'red');
  }
}

// ============================================================
//  View : tri + filtre appliqués sur state.rows
// ============================================================
function getDisplayedRows() {
  let view = state.rows.map((row, i) => ({ row, key: state.rowKeys[i], origI: i }));
  // Filtres
  Object.entries(state.filters).forEach(([ciStr, q]) => {
    if (!q) return;
    const ci = parseInt(ciStr, 10);
    const col = state.colNames[ci];
    const lq = q.toLowerCase();
    view = view.filter(({ row, origI }) => {
      const display = getDisplayValue(origI, ci).text;
      const raw = row[col] == null ? '' : String(row[col]);
      return display.toLowerCase().includes(lq) || raw.toLowerCase().includes(lq);
    });
  });
  // Tri
  if (state.sort) {
    const { ci, dir } = state.sort;
    const col = state.colNames[ci];
    view.sort((a, b) => {
      const av = a.row[col] == null ? '' : String(a.row[col]);
      const bv = b.row[col] == null ? '' : String(b.row[col]);
      const an = parseFloat(av.replace(/\s/g, '').replace(',', '.'));
      const bn = parseFloat(bv.replace(/\s/g, '').replace(',', '.'));
      if (!isNaN(an) && !isNaN(bn)) return dir === 'asc' ? an - bn : bn - an;
      return dir === 'asc' ? av.localeCompare(bv, 'fr') : bv.localeCompare(av, 'fr');
    });
  }
  return view;
}

function renderActiveFilters() {
  const el = $('activeFilters');
  if (!el) return;
  const chips = [];
  Object.entries(state.filters).forEach(([ciStr, q]) => {
    if (!q) return;
    const col = state.colNames[parseInt(ciStr, 10)];
    chips.push(`<span class="af-chip">🔍 ${escapeHTML(col)} = "${escapeHTML(q)}" <button data-clear-filter="${ciStr}" title="Retirer">×</button></span>`);
  });
  if (state.sort) {
    const col = state.colNames[state.sort.ci];
    const arrow = state.sort.dir === 'asc' ? '↑' : '↓';
    chips.push(`<span class="af-chip" style="background:rgba(34,197,94,0.15);border-color:rgba(34,197,94,0.4);color:var(--green);">${arrow} ${escapeHTML(col)} <button data-clear-sort="1" title="Retirer" style="color:var(--green);">×</button></span>`);
  }
  el.innerHTML = chips.join('');
  el.querySelectorAll('[data-clear-filter]').forEach((b) =>
    b.addEventListener('click', () => { delete state.filters[b.dataset.clearFilter]; renderTable(); })
  );
  el.querySelectorAll('[data-clear-sort]').forEach((b) =>
    b.addEventListener('click', () => { state.sort = null; renderTable(); })
  );
}

// ============================================================
//  Render
// ============================================================
function renderTable() {
  const thead = $('tableHead');
  const tbody = $('tableBody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  // Header
  const hr = document.createElement('tr');
  const idxTh = document.createElement('th');
  idxTh.textContent = '#';
  hr.appendChild(idxTh);

  state.colNames.forEach((col, ci) => {
    const th = document.createElement('th');
    const hasSqlFormula = !!state.formulas[col];
    const sorted = state.sort && state.sort.ci === ci;
    const filtered = !!state.filters[ci];
    if (hasSqlFormula) th.classList.add('formula-header');
    if (sorted) th.classList.add('sorted');
    if (filtered) th.classList.add('filtered');
    th.innerHTML = (hasSqlFormula ? '⚡ ' : '')
      + escapeHTML(col)
      + (sorted ? `<span class="h-icon sort">${state.sort.dir === 'asc' ? '↑' : '↓'}</span>` : '')
      + (filtered ? '<span class="h-icon filter">🔍</span>' : '');
    th.title = col + (hasSqlFormula ? '\n= ' + state.formulas[col] : '') + '\n' + (state.colTypes[col] || '') + '\n\nClic : trier / filtrer';
    th.onclick = (e) => { e.stopPropagation(); openColumnMenu(ci, th); };
    hr.appendChild(th);
  });

  const addTh = document.createElement('th');
  addTh.className = 'add-col';
  addTh.textContent = '+';
  addTh.title = 'Ajouter une colonne PostgreSQL';
  addTh.onclick = openAddColModal;
  hr.appendChild(addTh);
  thead.appendChild(hr);

  // Body — vue triée et filtrée
  const view = getDisplayedRows();
  const displayRows = view.map((v) => v.row);
  const displayKeys = view.map((v) => v.key);
  const displayIndices = view.map((v) => v.origI);
  renderActiveFilters();

  displayRows.forEach((row, di) => {
    const tr = document.createElement('tr');
    const idxTd = document.createElement('td');
    idxTd.className = 'row-idx';
    idxTd.textContent = state.offset + displayIndices[di] + 1;
    idxTd.title = 'Clic : actions sur la ligne';
    const realRiForIdx = displayIndices[di];
    idxTd.onclick = (e) => { e.stopPropagation(); openRowMenu(realRiForIdx, idxTd); };
    tr.appendChild(idxTd);

    const realRi = displayIndices[di];
    state.colNames.forEach((col, ci) => {
      const td = document.createElement('td');
      td.className = 'cell';
      const raw = row[col];
      const rawStr = raw == null ? '' : String(raw);
      const display = getDisplayValue(realRi, ci);

      if (state.formulas[col]) td.classList.add('formula-col');
      if (display.isFormula) td.classList.add('cell-formula');
      if (display.isError) td.classList.add('error-val');
      if (rawStr === '' && !display.isFormula) td.classList.add('null-val');
      else if (!display.isFormula && !isNaN(rawStr) && rawStr !== '') td.classList.add('num-val');
      else if (display.isFormula && !display.isError && !isNaN(parseFloat(display.text.replace(/\s/g, '').replace(',', '.')))) td.classList.add('num-val');

      const key = `${displayKeys[di]}::${col}`;
      if (state.pending.has(key)) td.classList.add('modified');

      // Surlignage recherche
      if (state.search.q) {
        const isMatch = state.search.matches.some((m) => m.ri === realRi && m.ci === ci);
        if (isMatch) {
          td.classList.add('search-match');
          const cur = state.search.matches[state.search.current];
          if (cur && cur.ri === realRi && cur.ci === ci) td.classList.add('search-current');
        }
      }

      td.textContent = display.text;
      td.title = display.isFormula ? `${rawStr}\n= ${display.text}` : display.text;
      td.dataset.row = realRi;
      td.dataset.col = ci;
      td.dataset.key = displayKeys[di];
      td.onclick = () => selectCell(realRi, ci, td);
      td.ondblclick = () => startEdit(realRi, ci, td);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  const newTr = document.createElement('tr');
  newTr.className = 'new-row';
  const newTd = document.createElement('td');
  newTd.colSpan = state.colNames.length + 2;
  newTd.textContent = '+ Ajouter une ligne';
  newTd.onclick = openAddRowModal;
  newTr.appendChild(newTd);
  tbody.appendChild(newTr);
}

// ============================================================
//  Selection & edit
// ============================================================
function selectCell(ri, ci, td) {
  if (state.editingCell) stopEdit(true);
  document.querySelectorAll('.cell.selected').forEach((c) => c.classList.remove('selected'));
  td.classList.add('selected');
  state.selectedCell = { ri, ci, td };

  const col = state.colNames[ci];
  const row = state.rows[ri];
  const rawVal = row ? (row[col] == null ? '' : String(row[col])) : '';
  const display = getDisplayValue(ri, ci);

  const cellLetter = colLetter(ci);
  const cellRef = cellLetter + (state.offset + ri + 1);

  $('cellRef').textContent = cellRef;
  $('formulaInput').value = rawVal; // Toujours la valeur brute (formule visible si =)
  $('sidebarCell').textContent = `${cellRef} · ${col}`;
  $('sidebarValue').textContent = display.text || '(vide)';

  // Section "Formule cellule"
  const cellFormulaSection = $('cellFormulaSection');
  if (isFormulaText(rawVal)) {
    cellFormulaSection.style.display = '';
    $('sidebarCellFormula').textContent = rawVal;
  } else {
    cellFormulaSection.style.display = 'none';
  }

  // Section "Formule SQL colonne"
  if (state.formulas[col]) {
    $('sidebarFormula').innerHTML = `<span class="formula-tag">= ${escapeHTML(state.formulas[col])}</span>`;
  } else {
    $('sidebarFormula').textContent = '—';
  }
  $('selectionInfo').textContent = `${cellRef} · ${col} · ${state.colTypes[col] || 'TEXT'}`;

  // Stats colonne
  const vals = state.rows.map((_, i) => getDisplayValue(i, ci).text).filter((v) => v !== '');
  const nums = vals.map((v) => parseFloat(String(v).replace(/\s/g, '').replace(',', '.'))).filter((n) => !isNaN(n));
  $('statFilled').textContent = vals.length;
  if (nums.length > 0) {
    const sum = nums.reduce((a, b) => a + b, 0);
    $('statSum').textContent = formatNum(sum);
    $('statAvg').textContent = formatNum(sum / nums.length);
  } else {
    $('statSum').textContent = '—';
    $('statAvg').textContent = '—';
  }
}

function selectColumn(ci) {
  if (state.editingCell) stopEdit(true);
  state.selectedCell = { ri: -1, ci, td: null };
  document.querySelectorAll('thead th').forEach((th, i) => {
    th.style.background = i === ci + 1 ? 'rgba(79,124,255,0.15)' : '';
  });
  const col = state.colNames[ci];
  $('cellRef').textContent = col;
  $('formulaInput').value = state.formulas[col] ? '⚡ ' + state.formulas[col] : '';
  if (state.formulas[col]) {
    $('sidebarFormula').innerHTML = `<span class="formula-tag">= ${escapeHTML(state.formulas[col])}</span>`;
  }
}

function startEdit(ri, ci, td) {
  const col = state.colNames[ci];
  if (state.formulas[col]) {
    toast('Cellule calculée par formule SQL — édition désactivée', 'orange');
    return;
  }
  if (state.editingCell) stopEdit(true);
  const original = state.rows[ri][col] ?? '';
  state.editingCell = { ri, ci, td, original };

  const input = document.createElement('input');
  input.value = original;
  input.onblur = () => stopEdit(true);
  input.onkeydown = (e) => {
    // Si l'autocomplete est ouvert, il intercepte Enter/Tab/Esc (cf. acHandleKey).
    if (ac.visible && (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
    if (e.key === 'Enter') stopEdit(true);
    if (e.key === 'Escape') { input.value = original; stopEdit(false); }
  };
  input.oninput = () => { $('formulaInput').value = input.value; };
  td.classList.add('editing');
  td.textContent = '';
  td.appendChild(input);
  attachAutocomplete(input);
  input.focus();
  input.select();
}

function stopEdit(save) {
  if (!state.editingCell) return;
  const { ri, ci, td, original } = state.editingCell;
  const input = td.querySelector('input');
  const newVal = input ? input.value : original;
  td.classList.remove('editing');

  if (save && newVal !== String(original ?? '')) {
    const col = state.colNames[ci];
    const key = state.rowKeys[ri];
    recordUndo(ri, ci, original);
    state.rows[ri][col] = newVal;
    updateHFCell(ri, ci, newVal);
    state.pending.set(`${key}::${col}`, { primary_val: key, column: col, value: newVal === '' ? null : newVal });
    markModified();
    renderTable();   // re-rendu : les formules dépendantes se mettent à jour
    // Re-sélectionne la même cellule
    const sel = document.querySelector(`td.cell[data-row="${ri}"][data-col="${ci}"]`);
    if (sel) selectCell(ri, ci, sel);
  } else {
    // Restaure l'affichage
    const display = getDisplayValue(ri, ci);
    td.textContent = display.text;
  }
  state.editingCell = null;
}

function onFormulaKey(e) {
  if (ac.visible) return;  // l'autocomplete a la priorité
  if (e.key !== 'Enter' || !state.selectedCell || state.editingCell) return;
  const { ri, ci } = state.selectedCell;
  if (ri < 0 || !state.rows[ri]) return;
  const col = state.colNames[ci];
  if (state.formulas[col]) {
    toast('Colonne calculée par SQL — utilisez "Modifier formule"', 'orange');
    return;
  }
  const val = $('formulaInput').value;
  const key = state.rowKeys[ri];
  const prev = state.rows[ri][col] ?? '';
  recordUndo(ri, ci, prev);
  state.rows[ri][col] = val;
  updateHFCell(ri, ci, val);
  state.pending.set(`${key}::${col}`, { primary_val: key, column: col, value: val === '' ? null : val });
  markModified();
  renderTable();
}

// ============================================================
//  Save (batch)
// ============================================================
async function saveAllChanges() {
  if (state.pending.size === 0) return;
  const changes = Array.from(state.pending.values());
  try {
    const res = await api('/cells/batch', {
      method: 'PUT',
      body: JSON.stringify({ table: state.table, primary_col: state.primaryCol, changes }),
    });
    state.pending.clear();
    state.undoStack = [];
    updatePendingCount();
    $('saveBtn').classList.add('hidden');
    $('modifiedInfo').style.display = 'none';
    toast(`✓ ${res.updated} cellule(s) sauvegardée(s) sur ${res.submitted}`, 'green');
    await loadTable(state.table, { resetOffset: false });
  } catch (e) {
    toast('Erreur sauvegarde : ' + e.message, 'red');
  }
}

function markModified() {
  $('saveBtn').classList.remove('hidden');
  $('modifiedInfo').style.display = 'block';
  updatePendingCount();
}

function updatePendingCount() { $('pendingCount').textContent = state.pending.size; }

// ============================================================
//  Add column / row / formula
// ============================================================
function openAddColModal() {
  $('addColModal').classList.remove('hidden');
  setTimeout(() => $('newColName').focus(), 50);
}

async function createColumn() {
  const name = $('newColName').value.trim();
  const type = $('newColType').value;
  const formula = $('newColFormula').value.trim();
  if (!name) { toast('Nom requis', 'red'); return; }
  try {
    const r = await api(`/table/${encodeURIComponent(state.table)}/column`, {
      method: 'POST',
      body: JSON.stringify({ name, col_type: type, formula: formula || null }),
    });
    closeModal('addColModal');
    $('newColName').value = '';
    $('newColFormula').value = '';
    await loadTable(state.table, { resetOffset: false });
    toast(`✓ Colonne "${r.created}" créée${formula ? ' avec formule' : ''}`, 'green');
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

function openAddRowModal() {
  const container = $('newRowFields');
  container.innerHTML = state.colNames.map((col) => `
    <div class="form-group">
      <label class="form-label">${escapeHTML(col)} <span style="color:var(--text3);font-size:10px;">${escapeHTML(state.colTypes[col] || '')}</span></label>
      <input class="form-input" data-col="${escapeHTML(col)}" placeholder="${escapeHTML(col)}">
    </div>
  `).join('');
  $('addRowModal').classList.remove('hidden');
}

async function insertRow() {
  const data = {};
  document.querySelectorAll('#newRowFields input[data-col]').forEach((inp) => {
    if (inp.value !== '') data[inp.dataset.col] = inp.value;
  });
  if (Object.keys(data).length === 0) {
    toast('Au moins une valeur requise', 'red');
    return;
  }
  try {
    await api(`/table/${encodeURIComponent(state.table)}/row`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
    closeModal('addRowModal');
    await loadTable(state.table, { resetOffset: false });
    toast('✓ Ligne insérée', 'green');
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

function openFormulaModal() {
  if (!state.selectedCell) {
    toast('Sélectionne une colonne d\'abord', 'orange');
    return;
  }
  const col = state.colNames[state.selectedCell.ci];
  $('formulaColName').textContent = col;
  $('formulaColInput').value = state.formulas[col] || '';
  $('btnDeleteFormula').style.display = state.formulas[col] ? '' : 'none';
  $('formulaModal').classList.remove('hidden');
  setTimeout(() => $('formulaColInput').focus(), 50);
}

async function saveFormula() {
  if (!state.selectedCell) return;
  const col = state.colNames[state.selectedCell.ci];
  const formula = $('formulaColInput').value.trim();
  if (!formula) { toast('Formule vide — utilisez "Supprimer"', 'orange'); return; }
  try {
    await api('/formula/apply', {
      method: 'POST',
      body: JSON.stringify({ table: state.table, column: col, formula }),
    });
    closeModal('formulaModal');
    await loadTable(state.table, { resetOffset: false });
    toast(`✓ Formule appliquée sur "${col}"`, 'green');
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

async function deleteFormula() {
  if (!state.selectedCell) return;
  const col = state.colNames[state.selectedCell.ci];
  if (!confirm(`Supprimer la formule de "${col}" ? La colonne reste mais ne sera plus recalculée.`)) return;
  try {
    await api(`/formula?table=${encodeURIComponent(state.table)}&column=${encodeURIComponent(col)}`, {
      method: 'DELETE',
    });
    closeModal('formulaModal');
    await loadTable(state.table, { resetOffset: false });
    toast(`✓ Formule supprimée pour "${col}"`, 'green');
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

// ============================================================
//  Column menu (tri + filtre + actions par colonne)
// ============================================================
function openColumnMenu(ci, anchorEl) {
  closeColumnMenu();
  const col = state.colNames[ci];
  const sortDir = state.sort && state.sort.ci === ci ? state.sort.dir : null;
  const filterVal = state.filters[ci] || '';
  const hasSql = !!state.formulas[col];
  const menu = $('colMenu');
  menu.innerHTML = `
    <div class="cm-section">
      <div class="cm-label">${escapeHTML(col)} · ${escapeHTML(state.colTypes[col] || 'text')}</div>
    </div>
    <div class="cm-section">
      <button class="cm-item ${sortDir === 'asc' ? 'active' : ''}" data-act="sort-asc">↑ Trier croissant</button>
      <button class="cm-item ${sortDir === 'desc' ? 'active' : ''}" data-act="sort-desc">↓ Trier décroissant</button>
      ${sortDir ? '<button class="cm-item danger" data-act="sort-clear">× Effacer le tri</button>' : ''}
    </div>
    <div class="cm-section">
      <div class="cm-label">Filtrer (contient...)</div>
      <input class="cm-input" id="cmFilterInput" placeholder="ex: BBA, 2025, EUROTAB..." value="${escapeHTML(filterVal)}" autocomplete="off">
      ${filterVal ? '<button class="cm-item danger" data-act="filter-clear">× Effacer le filtre</button>' : ''}
    </div>
    <div class="cm-section">
      <button class="cm-item" data-act="select-col">📊 Voir stats colonne</button>
      <button class="cm-item" data-act="edit-formula">⚡ ${hasSql ? 'Modifier' : 'Ajouter'} formule SQL</button>
      ${hasSql ? '<button class="cm-item" data-act="recalc">🔄 Recalculer la colonne</button>' : ''}
    </div>
  `;
  // Position
  menu.classList.remove('hidden');
  const r = anchorEl.getBoundingClientRect();
  const w = menu.offsetWidth || 260;
  let left = r.left;
  if (left + w > window.innerWidth - 10) left = window.innerWidth - w - 10;
  let top = r.bottom + 4;
  const h = menu.offsetHeight || 280;
  if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 4);
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';

  // Actions
  menu.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => handleColMenuAction(btn.dataset.act, ci, anchorEl));
  });
  const filterInput = $('cmFilterInput');
  filterInput.addEventListener('input', (e) => {
    const v = e.target.value;
    if (v === '') delete state.filters[ci];
    else state.filters[ci] = v;
    renderTable();
  });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closeColumnMenu();
    if (e.key === 'Escape') { delete state.filters[ci]; renderTable(); closeColumnMenu(); }
  });
  setTimeout(() => filterInput.focus(), 30);

  setTimeout(() => document.addEventListener('mousedown', closeColMenuOutside, true), 50);
}

function handleColMenuAction(act, ci, anchorEl) {
  switch (act) {
    case 'sort-asc': state.sort = { ci, dir: 'asc' }; renderTable(); closeColumnMenu(); break;
    case 'sort-desc': state.sort = { ci, dir: 'desc' }; renderTable(); closeColumnMenu(); break;
    case 'sort-clear': state.sort = null; renderTable(); openColumnMenu(ci, anchorEl); break;
    case 'filter-clear': delete state.filters[ci]; renderTable(); openColumnMenu(ci, anchorEl); break;
    case 'select-col': closeColumnMenu(); selectColumn(ci); break;
    case 'edit-formula': closeColumnMenu(); state.selectedCell = { ri: -1, ci, td: null }; openFormulaModal(); break;
    case 'recalc': closeColumnMenu(); recalculateColumn(ci); break;
  }
}

function closeColumnMenu() {
  const m = $('colMenu');
  if (m) m.classList.add('hidden');
  document.removeEventListener('mousedown', closeColMenuOutside, true);
}

function closeColMenuOutside(e) {
  const m = $('colMenu');
  if (!m || m.classList.contains('hidden')) return;
  if (!m.contains(e.target)) closeColumnMenu();
}

function changePage(delta) {
  const newOffset = Math.max(0, state.offset + delta * state.limit);
  state.offset = newOffset;
  $('pageOffset').value = newOffset;
  loadTable(state.table, { resetOffset: false });
}

function applyPager() {
  state.limit = Math.max(1, Math.min(5000, parseInt($('pageLimit').value, 10) || 500));
  state.offset = Math.max(0, parseInt($('pageOffset').value, 10) || 0);
  loadTable(state.table, { resetOffset: false });
}

// ============================================================
//  Sidebar collapse
// ============================================================
function toggleSidebar() {
  const sb = $('appSidebar');
  sb.classList.toggle('collapsed');
  localStorage.setItem(SIDEBAR_KEY, sb.classList.contains('collapsed') ? '1' : '0');
}

function applySidebarStateFromStorage() {
  const collapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
  // Sur mobile on démarre toujours fermée
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (collapsed || isMobile) $('appSidebar').classList.add('collapsed');
}

// ============================================================
//  RECHERCHE GLOBALE (Ctrl+F)
// ============================================================
state.search = { q: '', matches: [], current: -1 };

function openSearch() {
  $('searchBar').classList.remove('hidden');
  setTimeout(() => { $('searchInput').focus(); $('searchInput').select(); }, 30);
}

function closeSearch() {
  $('searchBar').classList.add('hidden');
  state.search = { q: '', matches: [], current: -1 };
  renderTable();
}

function runSearch(q) {
  state.search.q = q;
  if (!q) {
    state.search.matches = [];
    state.search.current = -1;
    $('searchCounter').textContent = '—';
    renderTable();
    return;
  }
  const lq = q.toLowerCase();
  const matches = [];
  state.rows.forEach((row, ri) => {
    state.colNames.forEach((col, ci) => {
      const display = getDisplayValue(ri, ci).text;
      const raw = row[col] == null ? '' : String(row[col]);
      if (display.toLowerCase().includes(lq) || raw.toLowerCase().includes(lq)) {
        matches.push({ ri, ci });
      }
    });
  });
  state.search.matches = matches;
  state.search.current = matches.length > 0 ? 0 : -1;
  updateSearchCounter();
  renderTable();
  if (matches.length > 0) scrollToMatch();
}

function updateSearchCounter() {
  const { matches, current } = state.search;
  $('searchCounter').textContent = matches.length === 0 ? '0 résultat' : `${current + 1} / ${matches.length}`;
}

function scrollToMatch() {
  const m = state.search.matches[state.search.current];
  if (!m) return;
  const td = document.querySelector(`td.cell[data-row="${m.ri}"][data-col="${m.ci}"]`);
  if (td) td.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
}

function nextMatch() {
  if (state.search.matches.length === 0) return;
  state.search.current = (state.search.current + 1) % state.search.matches.length;
  updateSearchCounter();
  renderTable();
  scrollToMatch();
}

function prevMatch() {
  if (state.search.matches.length === 0) return;
  state.search.current = (state.search.current - 1 + state.search.matches.length) % state.search.matches.length;
  updateSearchCounter();
  renderTable();
  scrollToMatch();
}

// ============================================================
//  EXPORT CSV (vue courante : filtres + tri appliqués)
// ============================================================
function exportCSV() {
  const view = getDisplayedRows();
  if (view.length === 0) { toast('Rien à exporter', 'orange'); return; }
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const SEP = ';'; // Excel FR par défaut
  const header = state.colNames.map(escape).join(SEP);
  const lines = view.map(({ origI }) =>
    state.colNames.map((_, ci) => escape(getDisplayValue(origI, ci).text)).join(SEP)
  );
  const csv = '﻿' + [header, ...lines].join('\r\n'); // BOM UTF-8 pour Excel
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.table}_${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`✓ Export CSV : ${view.length} ligne(s)`, 'green');
}

// ============================================================
//  ROW MENU + SUPPRESSION DE LIGNE
// ============================================================
function openRowMenu(ri, anchor) {
  closeColumnMenu();
  const key = state.rowKeys[ri];
  const menu = $('colMenu');
  menu.innerHTML = `
    <div class="cm-section">
      <div class="cm-label">Ligne · ${escapeHTML(state.primaryCol)}=${escapeHTML(key)}</div>
    </div>
    <div class="cm-section">
      <button class="cm-item danger" data-act="delete-row">🗑 Supprimer cette ligne</button>
    </div>
  `;
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  let top = r.bottom + 4;
  const h = menu.offsetHeight || 80;
  if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 4);
  menu.style.top = top + 'px';
  menu.style.left = Math.min(r.right + 4, window.innerWidth - 270) + 'px';
  menu.querySelector('[data-act="delete-row"]').addEventListener('click', () => deleteRow(ri));
  setTimeout(() => document.addEventListener('mousedown', closeColMenuOutside, true), 50);
}

async function deleteRow(ri) {
  closeColumnMenu();
  const key = state.rowKeys[ri];
  if (!confirm(`Supprimer définitivement la ligne où ${state.primaryCol}="${key}" ?\n\nCette action est irréversible.`)) return;
  try {
    await api(`/table/${encodeURIComponent(state.table)}/row?primary_col=${encodeURIComponent(state.primaryCol)}&primary_val=${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    toast(`✓ Ligne supprimée`, 'green');
    await loadTable(state.table, { resetOffset: false });
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

// ============================================================
//  UNDO Ctrl+Z (sur les modifs en attente uniquement)
// ============================================================
state.undoStack = [];

function recordUndo(ri, ci, oldRaw) {
  state.undoStack.push({ ri, ci, oldRaw });
  if (state.undoStack.length > 200) state.undoStack.shift();
}

function undo() {
  const last = state.undoStack.pop();
  if (!last) { toast('Rien à annuler', 'orange'); return; }
  const { ri, ci, oldRaw } = last;
  const col = state.colNames[ci];
  state.rows[ri][col] = oldRaw;
  updateHFCell(ri, ci, oldRaw);
  const key = state.rowKeys[ri];
  state.pending.set(`${key}::${col}`, {
    primary_val: key, column: col,
    value: (oldRaw == null || oldRaw === '') ? null : oldRaw,
  });
  markModified();
  renderTable();
  toast('↶ Annulé', 'blue');
}

// ============================================================
//  VUES SAUVEGARDÉES (filtres + tri + limit, par table, en localStorage)
// ============================================================
const VIEWS_KEY = (table) => `mhp.views.${table}`;

function getSavedViews(table) {
  try { return JSON.parse(localStorage.getItem(VIEWS_KEY(table)) || '[]'); }
  catch { return []; }
}

function saveCurrentViewAs(name) {
  if (!name || !name.trim()) return;
  const views = getSavedViews(state.table);
  views.push({
    name: name.trim(),
    sort: state.sort,
    filters: { ...state.filters },
    limit: state.limit,
    savedAt: new Date().toISOString(),
  });
  localStorage.setItem(VIEWS_KEY(state.table), JSON.stringify(views));
  toast(`✓ Vue "${name}" enregistrée`, 'green');
  renderViewsPanel();
}

function applyView(view) {
  state.sort = view.sort || null;
  state.filters = { ...(view.filters || {}) };
  state.limit = view.limit || state.limit;
  $('pageLimit').value = state.limit;
  $('viewsPanel').classList.add('hidden');
  loadTable(state.table, { resetOffset: false });
  toast(`✓ Vue "${view.name}" appliquée`, 'green');
}

function deleteView(idx) {
  const views = getSavedViews(state.table);
  const removed = views.splice(idx, 1)[0];
  localStorage.setItem(VIEWS_KEY(state.table), JSON.stringify(views));
  toast(`Vue "${removed.name}" supprimée`, 'orange');
  renderViewsPanel();
}

function renderViewsPanel() {
  const panel = $('viewsPanel');
  const views = getSavedViews(state.table);
  const hasActive = state.sort || Object.values(state.filters).some(Boolean);
  panel.innerHTML = `
    <div class="dp-section">
      <span class="dp-label">${escapeHTML(state.table)} — vues sauvegardées</span>
      ${views.length === 0
        ? '<div class="dp-empty">Aucune vue enregistrée</div>'
        : views.map((v, i) => `
          <div style="display:flex;align-items:center;gap:0;">
            <button class="dp-item" data-apply="${i}" style="flex:1;">
              📌 ${escapeHTML(v.name)}
              <span class="dp-meta">${v.sort ? (v.sort.dir === 'asc' ? '↑' : '↓') + ' ' : ''}${Object.keys(v.filters || {}).length > 0 ? '🔍' : ''}</span>
            </button>
            <button class="dp-del" data-del="${i}" title="Supprimer">×</button>
          </div>`).join('')}
    </div>
    <div class="dp-section">
      <span class="dp-label">Sauvegarder la vue actuelle</span>
      ${hasActive
        ? '<input class="dp-input" id="viewNameInput" placeholder="Nom de la vue (ex: BL en retard)" autocomplete="off">'
        : '<div class="dp-empty">Applique d\'abord un filtre/tri</div>'}
    </div>
  `;
  panel.querySelectorAll('[data-apply]').forEach((b) =>
    b.addEventListener('click', () => applyView(views[+b.dataset.apply]))
  );
  panel.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); deleteView(+b.dataset.del); })
  );
  const inp = $('viewNameInput');
  if (inp) {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { saveCurrentViewAs(inp.value); }
      if (e.key === 'Escape') { panel.classList.add('hidden'); }
    });
  }
}

function toggleViewsPanel() {
  const panel = $('viewsPanel');
  if (panel.classList.contains('hidden')) {
    renderViewsPanel();
    panel.classList.remove('hidden');
    setTimeout(() => document.addEventListener('mousedown', closeViewsOutside, true), 50);
  } else {
    panel.classList.add('hidden');
    document.removeEventListener('mousedown', closeViewsOutside, true);
  }
}

function closeViewsOutside(e) {
  const panel = $('viewsPanel');
  const wrap = $('viewsWrap');
  if (!panel || panel.classList.contains('hidden')) return;
  if (!wrap.contains(e.target)) {
    panel.classList.add('hidden');
    document.removeEventListener('mousedown', closeViewsOutside, true);
  }
}

// ============================================================
//  RECALCULER UNE COLONNE (réapplique sa formule SQL)
// ============================================================
async function recalculateColumn(ci) {
  const col = state.colNames[ci];
  const formula = state.formulas[col];
  if (!formula) { toast('Pas de formule SQL sur cette colonne', 'orange'); return; }
  toast(`Recalcul de "${col}"…`, 'blue');
  try {
    const r = await api('/formula/apply', {
      method: 'POST',
      body: JSON.stringify({ table: state.table, column: col, formula }),
    });
    toast(`✓ "${col}" recalculée (${r.updated} ligne(s))`, 'green');
    await loadTable(state.table, { resetOffset: false });
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

// ============================================================
//  Utils
// ============================================================
function closeModal(id) { $(id).classList.add('hidden'); }

function formatNum(n) {
  if (isNaN(n)) return '—';
  return n % 1 === 0
    ? n.toLocaleString('fr-FR')
    : n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}

function toast(msg, color) {
  const colors = { green: '#22c55e', blue: '#4f7cff', orange: '#f97316', red: '#ef4444' };
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span style="color:${colors[color] || colors.blue}">●</span> ${escapeHTML(msg)}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ============================================================
//  Global event bindings
// ============================================================
function bindGlobalEvents() {
  // Header
  $('tableSelect').addEventListener('change', (e) => loadTable(e.target.value));
  $('btnAddCol').addEventListener('click', openAddColModal);
  $('btnAddRow').addEventListener('click', openAddRowModal);
  $('saveBtn').addEventListener('click', saveAllChanges);
  $('btnRefresh').addEventListener('click', () => loadTable(state.table, { resetOffset: false }));
  $('btnHelp').addEventListener('click', () => $('helpModal').classList.remove('hidden'));
  $('btnLib').addEventListener('click', openLibModal);
  $('libSearch').addEventListener('input', (e) => { lib.search = e.target.value; libRenderList(); });
  $('btnSearch').addEventListener('click', openSearch);
  $('btnExport').addEventListener('click', exportCSV);
  $('btnViews').addEventListener('click', toggleViewsPanel);

  // Search bar
  $('searchInput').addEventListener('input', (e) => runSearch(e.target.value));
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prevMatch() : nextMatch(); }
    if (e.key === 'Escape') closeSearch();
  });
  $('searchPrev').addEventListener('click', prevMatch);
  $('searchNext').addEventListener('click', nextMatch);
  $('searchClose').addEventListener('click', closeSearch);

  // Pager
  $('prevPage').addEventListener('click', () => changePage(-1));
  $('nextPage').addEventListener('click', () => changePage(+1));
  $('pageOffset').addEventListener('change', applyPager);
  $('pageLimit').addEventListener('change', applyPager);

  // Formula bar
  $('formulaInput').addEventListener('keydown', onFormulaKey);

  // Sidebar
  $('btnEditFormula').addEventListener('click', openFormulaModal);
  $('btnToggleSidebar').addEventListener('click', toggleSidebar);

  // Modals
  $('btnCreateColumn').addEventListener('click', createColumn);
  $('btnInsertRow').addEventListener('click', insertRow);
  $('btnSaveFormula').addEventListener('click', saveFormula);
  $('btnDeleteFormula').addEventListener('click', deleteFormula);
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => closeModal(b.dataset.close))
  );
  document.querySelectorAll('.formula-example[data-formula]').forEach((el) =>
    el.addEventListener('click', () => { $('newColFormula').value = el.dataset.formula; })
  );

  // Keyboard navigation
  document.addEventListener('keydown', onGlobalKey);

  // Save on Ctrl+S, Search on Ctrl+F, Undo on Ctrl+Z
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveAllChanges();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      // Ne pas undo si on est dans un input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      undo();
    }
  });

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
      if (e.target === ov) ov.classList.add('hidden');
    });
  });
}

function onGlobalKey(e) {
  if (state.editingCell) return;
  if (!state.selectedCell) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  const { ri, ci, td } = state.selectedCell;
  let nr = ri, nc = ci;
  if (e.key === 'ArrowDown') nr = Math.min(ri + 1, state.rows.length - 1);
  else if (e.key === 'ArrowUp') nr = Math.max(ri - 1, 0);
  else if (e.key === 'ArrowRight') nc = Math.min(ci + 1, state.colNames.length - 1);
  else if (e.key === 'ArrowLeft') nc = Math.max(ci - 1, 0);
  else if (e.key === 'Enter' || e.key === 'F2') {
    if (td) startEdit(ri, ci, td);
    return;
  } else if (e.key === 'Delete') {
    if (state.rows[ri]) {
      const col = state.colNames[ci];
      if (state.formulas[col]) return;
      const prev = state.rows[ri][col] ?? '';
      if (prev !== '') recordUndo(ri, ci, prev);
      state.rows[ri][col] = '';
      updateHFCell(ri, ci, '');
      const k = state.rowKeys[ri];
      state.pending.set(`${k}::${col}`, { primary_val: k, column: col, value: null });
      markModified();
      renderTable();
    }
    return;
  } else return;

  e.preventDefault();
  const cell = document.querySelector(`td.cell[data-row="${nr}"][data-col="${nc}"]`);
  if (cell) selectCell(nr, nc, cell);
}

// ─── Go ─────────────────────────────────────────────────────
init();
