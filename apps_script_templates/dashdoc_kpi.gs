/**
 * Dashdoc KPI → MHP DataSheet
 * Remplace importDashdocKPI().
 *
 * Récupère les transports du jour via l'API Dashdoc, agrège (internes vs affrétés),
 * et upsert dans la table 'dashdoc_kpi' (clé : date).
 */
function importDashdocKPI() {
  const TABLE     = 'dashdoc_kpi';
  const API_TOKEN = 'cb06c3fa3ee8758b75f99cff738becc6b2d4ea99';  // ⚠️ token Dashdoc
  const BASE_URL  = 'https://api.dashdoc.eu/api/v4';

  const tz = Session.getScriptTimeZone();
  const today = new Date();

  if (isNonWorkingDay(today)) { Logger.log('⏭ Jour non ouvré'); return; }

  const start = new Date(today); start.setHours(0,0,0,0);
  const end = new Date(start); end.setDate(end.getDate() + 1);

  const dateStr  = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  const startIso = Utilities.formatDate(start, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  const endIso   = Utilities.formatDate(end,   'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");

  const transports = fetchAllTransports(BASE_URL, API_TOKEN, {
    created__gte: startIso, created__lt: endIso, page_size: 200, archived: 'false'
  }, 10);

  let nbInternes = 0, totalPalettesInternes = 0, nbAffretes = 0;

  transports.forEach(function (t) {
    let palettes = 0;
    if (Array.isArray(t.deliveries)) {
      t.deliveries.forEach(function (d) {
        (d.planned_loads || []).forEach(function (l) { palettes += extractPalletsFromLoad(l); });
        (d.loads || []).forEach(function (l) { palettes += extractPalletsFromLoad(l); });
      });
    }
    if (isAffretement(t)) {
      nbAffretes++;
    } else {
      nbInternes++;
      totalPalettesInternes += palettes;
    }
  });

  // UPSERT par 'date' : si la ligne du jour existe déjà, elle est remplacée
  mhpPost(TABLE, [{
    date: dateStr,
    nb_transports_crees: nbInternes,
    total_palettes_crees: totalPalettesInternes,
    nb_transports_affretes_crees: nbAffretes
  }], { mode: 'upsert', primaryKeys: ['date'] });
}

// ─── Helpers (copiés tels quels du script original) ───
function fetchAllTransports(BASE_URL, API_TOKEN, params, maxPages) {
  let results = [];
  let url = BASE_URL + '/transports/?' + Object.keys(params)
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
  const opts = { method: 'get', headers: { Authorization: 'Token ' + API_TOKEN, Accept: 'application/json' }, muteHttpExceptions: true };
  let page = 0;
  while (url && page < maxPages) {
    page++;
    const r = UrlFetchApp.fetch(url, opts);
    if (r.getResponseCode() !== 200) break;
    const json = JSON.parse(r.getContentText());
    results = results.concat(json.results || []);
    url = json.next || null;
  }
  return results;
}

function extractPalletsFromLoad(load) {
  if (!load) return 0;
  const c = (load.category || '').toString().toLowerCase();
  if (c !== 'pallets' && c !== 'pallet') return 0;
  let q = load.quantity || load.pallets || 0;
  if (typeof q === 'string') q = parseFloat(q.replace(',', '.')) || 0;
  if (typeof q !== 'number') return 0;
  return q / 2;  // correction doublon (cf. script original)
}

function isAffretement(transport) {
  if (!transport) return false;
  const INTERNAL = ['MHP', 'MHP LOG'];
  let carrier = (transport.charter && transport.charter.carrier) ||
                transport.carrier ||
                (transport.carrier_address && transport.carrier_address.company);
  if (!carrier) return false;
  return !(carrier.remote_id && INTERNAL.indexOf(String(carrier.remote_id)) !== -1);
}

// ─── Jours fériés FR ───
function isNonWorkingDay(date) {
  const d = date.getDay();
  if (d === 0 || d === 6) return true;
  return isFrenchPublicHoliday(date);
}

function isFrenchPublicHoliday(date) {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  const fixed = [[1,1],[1,5],[8,5],[14,7],[15,8],[1,11],[11,11],[25,12]];
  if (fixed.some(function (f) { return f[0]===d && f[1]===m; })) return true;
  const e = getEasterDate(y);
  return isSameDay(date, addDays(e,1)) || isSameDay(date, addDays(e,39)) || isSameDay(date, addDays(e,50));
}

function getEasterDate(year) {
  const a = year % 19, b = Math.floor(year/100), c = year % 100;
  const d2 = Math.floor(b/4), e = b % 4, f = Math.floor((b+8)/25);
  const g = Math.floor((b-f+1)/3);
  const h = (19*a+b-d2-g+15) % 30;
  const i = Math.floor(c/4), k = c % 4;
  const l = (32+2*e+2*i-h-k) % 7;
  const m = Math.floor((a+11*h+22*l)/451);
  const month = Math.floor((h+l-7*m+114)/31);
  const day = ((h+l-7*m+114) % 31) + 1;
  return new Date(year, month-1, day);
}

function addDays(date, n) { const d = new Date(date.getTime()); d.setDate(d.getDate()+n); return d; }
function isSameDay(a, b) { return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
