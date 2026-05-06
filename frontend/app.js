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

function _detectFrenchLangPack() {
  // Le UMD du pack frFR de HyperFormula peut s'attacher à différents endroits
  // selon la version. On essaie tous les emplacements connus.
  if (typeof HyperFormula !== 'undefined') {
    if (HyperFormula.languages && HyperFormula.languages.frFR) return HyperFormula.languages.frFR;
  }
  if (typeof HyperFormulaLanguages !== 'undefined' && HyperFormulaLanguages.frFR) return HyperFormulaLanguages.frFR;
  if (typeof window !== 'undefined' && window.frFR && window.frFR.functions) return window.frFR;
  return null;
}

let _frRegistered = false;
function rebuildHF() {
  if (typeof HyperFormula === 'undefined') {
    hfReady = false;
    return;
  }
  if (hf) { try { hf.destroy(); } catch {} hf = null; }

  // Enregistre le pack FR (une seule fois)
  let useFr = false;
  if (!_frRegistered) {
    const frPack = _detectFrenchLangPack();
    if (frPack) {
      try {
        HyperFormula.registerLanguage('frFR', frPack);
        _frRegistered = true;
        useFr = true;
        console.log('✓ HyperFormula : pack français registered (SOMME, MOYENNE, SI, RECHERCHEV…)');
      } catch (e) {
        console.warn('Pack frFR déjà enregistré ou erreur :', e.message);
        _frRegistered = true;
        useFr = true;
      }
    } else {
      console.warn('⚠️ Pack frFR HyperFormula non trouvé — fonctions en anglais (SUM, AVERAGE, IF, VLOOKUP)');
    }
  } else {
    useFr = true;
  }

  try {
    const data2d = state.rows.map((row) =>
      state.colNames.map((col) => toHFValue(row[col]))
    );
    hf = HyperFormula.buildFromArray(data2d, {
      licenseKey: 'gpl-v3',
      language: useFr ? 'frFR' : 'enGB',
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

  // Fonctions (recherche FR + EN)
  const fnMatches = FORMULAS
    .filter((f) => f.name.startsWith(upper) || f.en.startsWith(upper))
    .slice(0, 8)
    .map((f) => ({ kind: 'fn', ...f }));

  // Colonnes : match par LETTRE (B, AA…) OU par NOM (nb_…)
  const colMatches = [];
  state.colNames.forEach((col, ci) => {
    const letter = colLetter(ci);
    const matchedByLetter = letter.startsWith(upper);
    const matchedByName = col.toLowerCase().startsWith(lower);
    if (!matchedByLetter && !matchedByName) return;
    // Insertion : si l'utilisateur tapait des lettres (B, AA…) → insère 'B1' (ref de cellule)
    //             sinon (a tapé le début du nom) → insère le nom (named range)
    const insertText = matchedByLetter && !matchedByName ? `${letter}1` : col;
    colMatches.push({
      kind: 'col',
      name: col,
      letter: letter,
      type_pg: state.colTypes[col] || 'text',
      matchedBy: matchedByLetter && !matchedByName ? 'letter' : 'name',
      insertText: insertText,
    });
  });

  // Cas spécial : si l'utilisateur tape juste 1 lettre (B, AA), proposer aussi B:B (colonne entière)
  if (/^[A-Z]+$/i.test(t)) {
    state.colNames.forEach((col, ci) => {
      const letter = colLetter(ci);
      if (letter.startsWith(upper)) {
        colMatches.push({
          kind: 'col',
          name: col,
          letter: letter,
          type_pg: state.colTypes[col] || 'text',
          matchedBy: 'range',
          insertText: `${letter}:${letter}`,
          rangeNote: 'colonne entière',
        });
      }
    });
  }

  // Ordre : si lettre majuscule en 1er → fonctions+lettre prioritaire, sinon colonnes par nom
  const isUpperFirst = t[0] === t[0].toUpperCase() && /[A-Z]/.test(t[0]);
  if (isUpperFirst) {
    return [...fnMatches, ...colMatches.slice(0, 10)];
  }
  return [...colMatches.slice(0, 10), ...fnMatches.slice(0, 6)];
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
    // Colonne : affiche "B · nb_transports_crees"
    const isRange = it.matchedBy === 'range';
    const labelLetter = isRange ? `${it.letter}:${it.letter}` : it.letter;
    const desc = isRange ? `colonne ${it.letter} entière (${it.name})` : `${it.name}`;
    return `
      <div class="ac-item ${active}" data-idx="${i}">
        <span class="ac-icon ac-col">${isRange ? '▥' : '▦'}</span>
        <span class="ac-name"><strong>${escapeHTML(labelLetter)}</strong> · ${escapeHTML(it.name)}</span>
        <span class="ac-sig">${escapeHTML(it.type_pg)}</span>
        <span class="ac-desc">${escapeHTML(desc)}</span>
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
    // Pour les colonnes : insertText calculé côté buildSuggestions
    // (B1 si match par lettre, nom si match par nom, B:B si range)
    insertion = it.insertText || it.name;
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
    const letter = colLetter(ci);
    const hasSqlFormula = !!state.formulas[col];
    const sorted = state.sort && state.sort.ci === ci;
    const filtered = !!state.filters[ci];
    if (hasSqlFormula) th.classList.add('formula-header');
    if (sorted) th.classList.add('sorted');
    if (filtered) th.classList.add('filtered');
    const sortIcon = sorted ? `<span class="h-icon sort">${state.sort.dir === 'asc' ? '↑' : '↓'}</span>` : '';
    const filterIcon = filtered ? '<span class="h-icon filter">🔍</span>' : '';
    th.innerHTML = `
      <div class="th-letter">${letter}</div>
      <div class="th-name">${(hasSqlFormula ? '⚡ ' : '') + escapeHTML(col) + sortIcon + filterIcon}</div>
    `;
    th.title = `${letter} · ${col}${hasSqlFormula ? '\n= ' + state.formulas[col] : ''}\n${state.colTypes[col] || ''}\n\nClic : trier / filtrer`;
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
  document.querySelectorAll('.cell-fill-handle').forEach((h) => h.remove());
  td.classList.add('selected');
  state.selectedCell = { ri, ci, td };
  // Poignée de recopie (sauf sur colonnes calculées par formule SQL)
  const colName = state.colNames[ci];
  if (!state.formulas[colName]) attachFillHandle(td, ri, ci);

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
      ${!hasSql ? '<button class="cm-item" data-act="fill-from-first">📥 Recopier 1ʳᵉ ligne sur toute la colonne</button>' : ''}
    </div>
    <div class="cm-section">
      <button class="cm-item danger" data-act="drop-col">🗑 Supprimer cette colonne</button>
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
    case 'fill-from-first': closeColumnMenu(); fillColumnFromFirst(ci); break;
    case 'drop-col': closeColumnMenu(); dropColumn(ci); break;
  }
}

async function dropColumn(ci) {
  const col = state.colNames[ci];
  if (!confirm(`Supprimer définitivement la colonne "${col}" de la table "${state.table}" ?\n\nLes formules SQL qui la référencent (autres colonnes/tables) seront aussi supprimées.\n\nCette action est IRRÉVERSIBLE.`)) return;
  try {
    const r = await api(`/table/${encodeURIComponent(state.table)}/column?column=${encodeURIComponent(col)}`, { method: 'DELETE' });
    let msg = `✓ Colonne "${col}" supprimée`;
    if (r.broken_formulas_removed && r.broken_formulas_removed.length > 0) {
      msg += ` (formules cassées nettoyées : ${r.broken_formulas_removed.join(', ')})`;
    }
    toast(msg, 'green');
    await loadTable(state.table, { resetOffset: false });
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

async function dropTable() {
  if (!state.table) return;
  const name = state.table;
  if (!confirm(`Supprimer définitivement la TABLE ENTIÈRE "${name}" et toutes ses données ?\n\nLes formules SQL d'autres tables qui la référencent seront aussi supprimées.\n\nCette action est IRRÉVERSIBLE.`)) return;
  // Double confirmation pour les tables
  const typed = prompt(`Pour confirmer, retape exactement le nom de la table : ${name}`);
  if (typed !== name) { toast('Suppression annulée', 'orange'); return; }
  try {
    const r = await api(`/table/${encodeURIComponent(name)}`, { method: 'DELETE' });
    let msg = `✓ Table "${name}" supprimée`;
    if (r.broken_formulas_removed && r.broken_formulas_removed.length > 0) {
      msg += ` (formules cassées nettoyées : ${r.broken_formulas_removed.join(', ')})`;
    }
    toast(msg, 'green');
    await loadTables(); // recharge la liste des tables
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
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
  closeToolsPanel();
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

// ─── Outils dropdown (kebab) ────────────────────────────────
function toggleToolsPanel() {
  // Ferme l'autre dropdown si ouvert
  $('viewsPanel').classList.add('hidden');
  document.removeEventListener('mousedown', closeViewsOutside, true);
  const panel = $('toolsPanel');
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    setTimeout(() => document.addEventListener('mousedown', closeToolsOutside, true), 50);
  } else {
    panel.classList.add('hidden');
    document.removeEventListener('mousedown', closeToolsOutside, true);
  }
}

function closeToolsPanel() {
  const panel = $('toolsPanel');
  if (panel) panel.classList.add('hidden');
  document.removeEventListener('mousedown', closeToolsOutside, true);
}

function closeToolsOutside(e) {
  const panel = $('toolsPanel');
  const wrap = $('toolsWrap');
  if (!panel || panel.classList.contains('hidden')) return;
  if (!wrap.contains(e.target)) closeToolsPanel();
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
//  MODULE SCRIPTS (équivalent Apps Script — Python sandbox)
// ============================================================
const scr = {
  list: [],
  current: null,         // script en cours d'édition
  editor: null,          // instance Monaco
  monacoLoading: false,
  outputTab: 'output',
};

const SCR_TEMPLATE = `# Script Python — bibliothèque mhp disponible automatiquement
import mhp

mhp.log("Démarrage")

# Exemple : compter les lignes de stock_it
t = mhp.table('stock_it')
mhp.log(f"Lignes : {t.count()}")

# Exemple HTTP
# r = mhp.http.get('https://api.example.com/data',
#                  headers={'Authorization': 'Bearer xxx'})
# data = r.json()
# mhp.log(f"Reçu : {len(data)} éléments")

mhp.log("Terminé")
`;

async function openScriptsModal() {
  $('scriptsModal').classList.remove('hidden');
  // Remplit le select des tables pour les triggers on_edit / on_row_add
  try {
    const d = await api('/tables');
    const sel = $('scrTriggerTable');
    sel.innerHTML = '<option value="">— toutes les tables —</option>'
      + d.tables.map((t) => `<option value="${escapeHTML(t)}">${escapeHTML(t)}</option>`).join('');
  } catch {}
  await loadMonaco();
  await refreshScriptsList();
}

function updateTriggerInputs(triggerType) {
  $('scrCron').style.display           = triggerType === 'cron' ? '' : 'none';
  $('scrTriggerTable').style.display   = (triggerType === 'on_edit' || triggerType === 'on_row_add') ? '' : 'none';
  $('scrTriggerWebhook').style.display = triggerType === 'on_webhook' ? '' : 'none';
}

function closeScriptsModal() {
  $('scriptsModal').classList.add('hidden');
}

function loadMonaco() {
  return new Promise((resolve) => {
    if (scr.monacoLoading) {
      // Attend que le précédent chargement finisse
      const wait = setInterval(() => {
        if (scr.editor || !scr.monacoLoading) { clearInterval(wait); resolve(); }
      }, 50);
      return;
    }
    if (scr.editor) return resolve();
    if (typeof require === 'undefined') { console.warn('Monaco loader pas chargé'); return resolve(); }
    scr.monacoLoading = true;
    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
    require(['vs/editor/editor.main'], function () {
      scr.editor = monaco.editor.create($('scrEditor'), {
        value: '',
        language: 'python',
        theme: 'vs-dark',
        fontSize: 13,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        tabSize: 4,
        insertSpaces: true,
      });
      scr.monacoLoading = false;
      resolve();
    });
  });
}

async function refreshScriptsList() {
  try {
    const d = await api('/scripts');
    scr.list = d.scripts;
    renderScriptsList();
  } catch (e) {
    toast('Erreur chargement scripts : ' + e.message, 'red');
  }
}

function renderScriptsList() {
  const el = $('scrList');
  if (scr.list.length === 0) {
    el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px;">Aucun script</div>';
    return;
  }
  el.innerHTML = scr.list.map((s) => {
    const trig = s.trigger_type === 'cron' ? `⏱ ${s.trigger_cron || '?'}` : '▶ Manuel';
    const cls = (scr.current && scr.current.id === s.id) ? 'active' : '';
    return `<div class="scr-item ${cls} ${s.enabled ? '' : 'scr-disabled'}" data-id="${s.id}">
      <span class="scr-name">${escapeHTML(s.name)}</span>
      <span class="scr-trig" title="${escapeHTML(trig)}">${escapeHTML(s.trigger_type === 'cron' ? '⏱' : '▶')}</span>
    </div>`;
  }).join('');
  el.querySelectorAll('.scr-item').forEach((it) => {
    it.addEventListener('click', () => loadScript(parseInt(it.dataset.id, 10)));
  });
}

async function loadScript(id) {
  try {
    const s = await api(`/scripts/${id}`);
    scr.current = s;
    $('scrPlaceholder').classList.add('hidden');
    $('scrEditorPane').classList.remove('hidden');
    $('scrName').value = s.name;
    $('scrTriggerType').value = s.trigger_type;
    $('scrCron').value = s.trigger_cron || '';
    $('scrTriggerTable').value = s.trigger_table || '';
    $('scrTriggerWebhook').value = s.trigger_webhook_slug || '';
    updateTriggerInputs(s.trigger_type);
    $('scrEnabled').checked = !!s.enabled;
    $('scrSandboxed').checked = !!s.sandboxed;
    if (scr.editor) scr.editor.setValue(s.code || '');
    $('scrOutput').textContent = '— Pas d\'exécution depuis le chargement —';
    $('scrOutput').classList.remove('error');
    renderScriptsList();
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

function newScript() {
  const name = prompt('Nom du nouveau script :');
  if (!name || !name.trim()) return;
  api('/scripts', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim(), code: SCR_TEMPLATE, trigger_type: 'manual', enabled: true }),
  }).then(async (s) => {
    await refreshScriptsList();
    loadScript(s.id);
    toast(`✓ Script "${name}" créé`, 'green');
  }).catch((e) => toast('Erreur : ' + e.message, 'red'));
}

async function saveScript() {
  if (!scr.current) return;
  const payload = {
    name: $('scrName').value.trim(),
    code: scr.editor ? scr.editor.getValue() : '',
    trigger_type: $('scrTriggerType').value,
    trigger_cron: $('scrCron').value.trim() || null,
    trigger_table: $('scrTriggerTable').value || null,
    trigger_webhook_slug: $('scrTriggerWebhook').value.trim() || null,
    enabled: $('scrEnabled').checked,
    sandboxed: $('scrSandboxed').checked,
  };
  try {
    await api(`/scripts/${scr.current.id}`, { method: 'PUT', body: JSON.stringify(payload) });
    toast('✓ Script sauvegardé', 'green');
    await refreshScriptsList();
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

async function runScript() {
  if (!scr.current) return;
  // Auto-save avant exécution pour ne pas perdre le code modifié
  await saveScript();
  $('scrOutput').textContent = '⏳ Exécution en cours...';
  $('scrOutput').classList.remove('error');
  try {
    const r = await api(`/scripts/${scr.current.id}/run`, { method: 'POST' });
    let txt = r.output || '(aucune sortie)';
    if (r.status !== 'success') {
      txt += '\n\n--- ERREUR ---\n' + (r.error || '(pas de message)');
      $('scrOutput').classList.add('error');
    } else {
      $('scrOutput').classList.remove('error');
    }
    txt += `\n\n[${r.status} en ${r.duration_ms}ms]`;
    $('scrOutput').textContent = txt;
    if (scr.outputTab === 'runs') refreshRuns();
  } catch (e) {
    $('scrOutput').textContent = 'Erreur appel : ' + e.message;
    $('scrOutput').classList.add('error');
  }
}

async function deleteCurrentScript() {
  if (!scr.current) return;
  if (!confirm(`Supprimer le script "${scr.current.name}" ?`)) return;
  try {
    await api(`/scripts/${scr.current.id}`, { method: 'DELETE' });
    toast('Script supprimé', 'green');
    scr.current = null;
    $('scrEditorPane').classList.add('hidden');
    $('scrPlaceholder').classList.remove('hidden');
    await refreshScriptsList();
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

async function refreshRuns() {
  if (!scr.current) return;
  try {
    const d = await api(`/scripts/${scr.current.id}/runs?limit=20`);
    const el = $('scrRuns');
    if (d.runs.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px;">Aucune exécution</div>';
      return;
    }
    el.innerHTML = d.runs.map((r) => {
      const dur = r.duration_ms != null ? `${r.duration_ms}ms` : '—';
      const time = r.started_at ? new Date(r.started_at).toLocaleString('fr-FR') : '?';
      return `<div class="scr-run" data-id="${r.id}">
        <span class="scr-run-status ${escapeHTML(r.status)}">${escapeHTML(r.status)}</span>
        <span class="scr-run-time">${escapeHTML(time)}</span>
        <span class="scr-run-dur">${escapeHTML(dur)}</span>
      </div>`;
    }).join('');
    el.querySelectorAll('.scr-run').forEach((it) => {
      it.addEventListener('click', () => loadRun(parseInt(it.dataset.id, 10)));
    });
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

async function loadRun(runId) {
  if (!scr.current) return;
  try {
    const r = await api(`/scripts/${scr.current.id}/runs/${runId}`);
    let txt = r.output || '(aucune sortie)';
    if (r.error) txt += '\n\n--- ERREUR ---\n' + r.error;
    txt += `\n\n[${r.status} en ${r.duration_ms || 0}ms — ${new Date(r.started_at).toLocaleString('fr-FR')}]`;
    setScriptTab('output');
    $('scrOutput').textContent = txt;
    $('scrOutput').classList.toggle('error', r.status !== 'success');
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

function setScriptTab(tab) {
  scr.outputTab = tab;
  document.querySelectorAll('.scr-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('scrOutput').classList.toggle('hidden', tab !== 'output');
  $('scrRuns').classList.toggle('hidden', tab !== 'runs');
  if (tab === 'runs') refreshRuns();
}

// ============================================================
//  INTEGRATIONS — OAuth Google (Gmail/Drive/Sheets)
// ============================================================
async function openIntegrationsModal() {
  $('integrationsModal').classList.remove('hidden');
  await refreshGoogleStatus();
}

async function refreshGoogleStatus() {
  const statusEl = $('googleStatus');
  const bodyEl = $('googleBody');
  const helpEl = $('googleHelp');
  statusEl.innerHTML = '<span class="ig-pill ig-loading">…</span>';
  bodyEl.innerHTML = '';
  helpEl.style.display = 'none';

  let s;
  try {
    s = await api('/integrations/google/status');
  } catch (e) {
    statusEl.innerHTML = '<span class="ig-pill ig-bad">Erreur</span>';
    bodyEl.innerHTML = `<div style="color:var(--red);font-size:12px;">${escapeHTML(e.message)}</div>`;
    return;
  }

  if (!s.configured) {
    statusEl.innerHTML = '<span class="ig-pill ig-off">Non configuré</span>';
    helpEl.style.display = '';
    bodyEl.innerHTML = `<div class="ig-row"><strong>Redirect URI à configurer dans GCP :</strong></div>
      <div><code>${escapeHTML(s.redirect_uri || '?')}</code></div>`;
    return;
  }

  if (!s.connected) {
    statusEl.innerHTML = '<span class="ig-pill ig-off">Non connecté</span>';
    bodyEl.innerHTML = `
      <div class="ig-row"><strong>Redirect URI configurée :</strong></div>
      <div><code>${escapeHTML(s.redirect_uri)}</code></div>
      <div style="margin-top:10px;">
        <button class="btn btn-primary" id="googleBtnConnect">🔗 Connecter un compte Google</button>
      </div>
      <div class="form-hint" style="margin-top:8px;">
        Une fenêtre Google s'ouvre. Choisis le compte (ex : <code>compte-mhp@gmail.com</code>),
        accepte les permissions Gmail/Drive/Sheets, et reviens ici.
      </div>`;
    $('googleBtnConnect').addEventListener('click', startGoogleConnect);
    return;
  }

  statusEl.innerHTML = '<span class="ig-pill ig-on">✓ Connecté</span>';
  const scopesShort = (s.scopes || []).map((sc) => sc.split('/').pop()).filter(Boolean).join(', ');
  bodyEl.innerHTML = `
    <div class="ig-row"><strong>Compte :</strong> ${escapeHTML(s.account_email || '?')}</div>
    <div class="ig-row"><strong>Connecté le :</strong> ${escapeHTML(s.connected_at ? new Date(s.connected_at).toLocaleString('fr-FR') : '?')}</div>
    ${s.refreshed_at ? `<div class="ig-row"><strong>Dernier refresh :</strong> ${escapeHTML(new Date(s.refreshed_at).toLocaleString('fr-FR'))}</div>` : ''}
    <div class="ig-row"><strong>Scopes :</strong> <span style="font-size:10.5px;color:var(--text3);">${escapeHTML(scopesShort)}</span></div>
    <div style="margin-top:12px;display:flex;gap:8px;">
      <button class="btn btn-ghost" id="googleBtnReconnect">🔄 Reconnecter</button>
      <button class="btn btn-danger" id="googleBtnDisconnect">⏏ Déconnecter</button>
    </div>
    <div class="form-hint" style="margin-top:10px;">
      Les scripts Python peuvent maintenant utiliser :<br>
      <code>mhp.gmail.search('label:stockit has:attachment')</code> · <code>mhp.drive.export_csv(file_id)</code> · <code>mhp.sheets.get_values(...)</code>
    </div>`;
  $('googleBtnReconnect').addEventListener('click', startGoogleConnect);
  $('googleBtnDisconnect').addEventListener('click', disconnectGoogle);
}

async function startGoogleConnect() {
  try {
    const r = await api('/integrations/google/connect');
    // Ouvre Google dans une nouvelle fenêtre
    const win = window.open(r.authorization_url, 'google-oauth', 'width=540,height=720,resizable=yes,scrollbars=yes');
    if (!win) {
      toast('Popup bloquée — autorise les popups pour ce site', 'red');
      return;
    }
    // Poll jusqu'à fermeture
    const poll = setInterval(async () => {
      if (win.closed) {
        clearInterval(poll);
        await refreshGoogleStatus();
      }
    }, 1000);
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

async function disconnectGoogle() {
  if (!confirm('Déconnecter le compte Google ? Les scripts qui utilisent mhp.gmail/drive/sheets ne fonctionneront plus.')) return;
  try {
    await api('/integrations/google', { method: 'DELETE' });
    toast('Compte Google déconnecté', 'orange');
    await refreshGoogleStatus();
  } catch (e) {
    toast('Erreur : ' + e.message, 'red');
  }
}

// ============================================================
//  FILL HANDLE — recopie style Excel/Sheets (drag down, Ctrl+D, etc.)
// ============================================================
const fill = { active: false, srcRi: -1, srcCi: -1, currentRi: -1 };

function attachFillHandle(td, ri, ci) {
  const handle = document.createElement('div');
  handle.className = 'cell-fill-handle';
  handle.title = 'Glisser pour recopier la formule/valeur sur les lignes voulues';
  handle.addEventListener('mousedown', (e) => startFillDrag(e, ri, ci));
  td.appendChild(handle);
}

function startFillDrag(e, srcRi, srcCi) {
  e.preventDefault();
  e.stopPropagation();
  fill.active = true;
  fill.srcRi = srcRi;
  fill.srcCi = srcCi;
  fill.currentRi = srcRi;
  document.body.classList.add('fill-dragging');
  document.addEventListener('mousemove', onFillMove);
  document.addEventListener('mouseup', onFillEnd);
}

function onFillMove(e) {
  if (!fill.active) return;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target || !target.closest) return;
  const td = target.closest('td.cell');
  if (!td) return;
  const ri = parseInt(td.dataset.row, 10);
  const ci = parseInt(td.dataset.col, 10);
  if (isNaN(ri) || ci !== fill.srcCi) return; // même colonne uniquement
  if (ri === fill.currentRi) return;
  fill.currentRi = ri;
  highlightFillRange();
}

function highlightFillRange() {
  document.querySelectorAll('td.cell.fill-preview').forEach((el) => el.classList.remove('fill-preview'));
  const start = Math.min(fill.srcRi, fill.currentRi);
  const end = Math.max(fill.srcRi, fill.currentRi);
  for (let r = start; r <= end; r++) {
    const td = document.querySelector(`td.cell[data-row="${r}"][data-col="${fill.srcCi}"]`);
    if (td) td.classList.add('fill-preview');
  }
}

function onFillEnd() {
  document.body.classList.remove('fill-dragging');
  document.removeEventListener('mousemove', onFillMove);
  document.removeEventListener('mouseup', onFillEnd);
  document.querySelectorAll('td.cell.fill-preview').forEach((el) => el.classList.remove('fill-preview'));
  if (!fill.active) return;
  const { srcRi, srcCi, currentRi } = fill;
  fill.active = false;
  if (srcRi === currentRi) return;
  applyFillRange(srcRi, srcCi, currentRi);
}

function applyFillRange(srcRi, srcCi, endRi) {
  const col = state.colNames[srcCi];
  if (state.formulas[col]) {
    toast('Colonne calculée par formule SQL — édition désactivée', 'orange');
    return;
  }
  const srcValue = state.rows[srcRi] ? state.rows[srcRi][col] : '';
  if (srcValue == null || srcValue === '') {
    toast('Cellule source vide — rien à recopier', 'orange');
    return;
  }

  const isFormula = String(srcValue).trim().startsWith('=');
  const start = Math.min(srcRi, endRi);
  const end = Math.max(srcRi, endRi);
  let count = 0;

  // Si formule : on demande à HyperFormula d'ajuster les références (relatives)
  if (isFormula && hfReady) {
    try { hf.copy({ sheet: 0, col: srcCi, row: srcRi, width: 1, height: 1 }); } catch {}
  }

  for (let r = start; r <= end; r++) {
    if (r === srcRi) continue;
    let newValue;
    if (isFormula && hfReady) {
      try {
        hf.paste({ sheet: 0, col: srcCi, row: r });
        const adjusted = hf.getCellFormula({ sheet: 0, col: srcCi, row: r });
        newValue = adjusted || String(srcValue);
      } catch (e) {
        newValue = String(srcValue);
        updateHFCell(r, srcCi, newValue);
      }
    } else {
      newValue = String(srcValue);
      updateHFCell(r, srcCi, newValue);
    }

    const prev = state.rows[r][col] ?? '';
    if (String(prev) !== String(newValue)) {
      if (prev !== '') recordUndo(r, srcCi, prev);
      state.rows[r][col] = newValue;
      const key = state.rowKeys[r];
      state.pending.set(`${key}::${col}`, {
        primary_val: key, column: col, value: newValue === '' ? null : newValue,
      });
      count++;
    }
  }

  markModified();
  renderTable();
  toast(`✓ Recopié sur ${count} cellule(s) — Ctrl+S pour sauvegarder`, 'green');
}

// Ctrl+D : recopie depuis la cellule au-dessus
function fillDownFromAbove() {
  if (!state.selectedCell) return;
  const { ri, ci } = state.selectedCell;
  if (ri <= 0) { toast('Aucune cellule au-dessus', 'orange'); return; }
  applyFillRange(ri - 1, ci, ri);
}

// Recopie la 1ère ligne de la colonne sur TOUTE la colonne (depuis le menu colonne)
function fillColumnFromFirst(ci) {
  if (state.rows.length < 2) { toast('Pas assez de lignes', 'orange'); return; }
  applyFillRange(0, ci, state.rows.length - 1);
}

// ============================================================
//  CREATE TABLE (modal "Nouvelle table")
// ============================================================
const COL_TYPES = ['TEXT', 'NUMERIC', 'INTEGER', 'BIGINT', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'JSONB'];

function openNewTableModal() {
  $('newTableName').value = '';
  const container = $('newTableColumns');
  container.innerHTML = '';
  // 2 colonnes par défaut (la 1ère sera PK)
  addNewTableColumnRow();
  addNewTableColumnRow();
  $('newTableModal').classList.remove('hidden');
  setTimeout(() => $('newTableName').focus(), 50);
}

function addNewTableColumnRow() {
  const container = $('newTableColumns');
  const i = container.children.length;
  const div = document.createElement('div');
  div.className = 'new-tbl-col';
  div.style.cssText = 'display:flex;gap:6px;margin-bottom:4px;align-items:center;';
  div.innerHTML = `
    <span style="font-size:11px;color:var(--text3);min-width:18px;">${i + 1}.</span>
    <input class="form-input col-name" placeholder="${i === 0 ? 'clé_primaire' : 'nom_colonne'}" style="flex:2;height:30px;font-size:12px;">
    <select class="form-select col-type" style="flex:1;height:30px;font-size:12px;">
      ${COL_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}
    </select>
    <button class="btn btn-ghost col-rm" style="padding:0 8px;height:30px;color:var(--red);">×</button>
  `;
  container.appendChild(div);
  div.querySelector('.col-rm').addEventListener('click', () => {
    if (container.children.length > 1) div.remove();
  });
}

async function createTable() {
  const name = $('newTableName').value.trim();
  if (!name) { toast('Nom de table requis', 'red'); return; }
  const cols = [];
  document.querySelectorAll('#newTableColumns .new-tbl-col').forEach((row) => {
    const n = row.querySelector('.col-name').value.trim();
    const t = row.querySelector('.col-type').value;
    if (n) cols.push({ name: n, col_type: t });
  });
  if (cols.length === 0) { toast('Au moins une colonne requise', 'red'); return; }
  try {
    const r = await api('/tables', { method: 'POST', body: JSON.stringify({ name, columns: cols }) });
    closeModal('newTableModal');
    await loadTables();
    await loadTable(r.created);
    toast(`✓ Table "${r.created}" créée (${r.columns.length} colonnes)`, 'green');
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
  $('btnDropTable').addEventListener('click', dropTable);
  $('btnNewTable').addEventListener('click', openNewTableModal);
  $('btnAddTableColumn').addEventListener('click', addNewTableColumnRow);
  $('btnCreateTable').addEventListener('click', createTable);
  // Tools dropdown — chaque action ferme le panneau avant d'ouvrir son modal
  $('btnTools').addEventListener('click', toggleToolsPanel);
  $('btnHelp').addEventListener('click', () => { closeToolsPanel(); $('helpModal').classList.remove('hidden'); });
  $('btnLib').addEventListener('click', () => { closeToolsPanel(); openLibModal(); });
  $('scrBtnNew').addEventListener('click', newScript);
  $('scrBtnSave').addEventListener('click', saveScript);
  $('scrBtnRun').addEventListener('click', runScript);
  $('scrBtnDel').addEventListener('click', deleteCurrentScript);
  $('scrBtnHelp').addEventListener('click', () => $('scrHelpModal').classList.remove('hidden'));
  $('scrTriggerType').addEventListener('change', (e) => updateTriggerInputs(e.target.value));
  document.querySelectorAll('.scr-tab').forEach((t) =>
    t.addEventListener('click', () => setScriptTab(t.dataset.tab))
  );
  $('libSearch').addEventListener('input', (e) => { lib.search = e.target.value; libRenderList(); });
  $('btnSearch').addEventListener('click', () => { closeToolsPanel(); openSearch(); });
  $('btnExport').addEventListener('click', () => { closeToolsPanel(); exportCSV(); });
  $('btnViews').addEventListener('click', toggleViewsPanel);
  $('btnScripts').addEventListener('click', () => { closeToolsPanel(); openScriptsModal(); });
  $('btnIntegrations').addEventListener('click', () => { closeToolsPanel(); openIntegrationsModal(); });

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
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      fillDownFromAbove();
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
