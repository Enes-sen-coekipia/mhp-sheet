/**
 * Dashdoc Livraisons CP → MHP DataSheet
 * Remplace importDashdocLivraisonsCP() (et son cousin importDashdocLivraisonsCPmois).
 *
 * Récupère les transports créés sur une période, extrait code postal + pays + palettes
 * pour chaque livraison, et upsert par clé composite (date + sequential_id + delivery_index).
 */
function importDashdocLivraisonsCP() {
  const TABLE     = 'dashdoc_livraisons_cp';
  const API_TOKEN = 'cb06c3fa3ee8758b75f99cff738becc6b2d4ea99';
  const BASE_URL  = 'https://api.dashdoc.eu/api/v4';
  const INTERNAL  = ['MHP', 'MHP LOG'];

  const tz = Session.getScriptTimeZone();
  const now = new Date();
  if (now.getDay() === 0 || now.getDay() === 6) { Logger.log('⏭ Week-end'); return; }

  const start = new Date(now); start.setHours(0,0,0,0);
  const end   = new Date(start); end.setDate(end.getDate() + 1);

  const dayStr   = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  const startIso = Utilities.formatDate(start, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  const endIso   = Utilities.formatDate(end,   'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");

  const transports = fetchAllTransports(BASE_URL, API_TOKEN, {
    created__gte: startIso, created__lt: endIso, page_size: 200
  }, 10);

  const rows = [];
  transports.forEach(function (t) {
    if (!isInternalTransport(t, INTERNAL)) return;
    if (!Array.isArray(t.deliveries)) return;
    const seq = t.sequential_id || '';
    t.deliveries.forEach(function (d, idx) {
      let cp = '', pays = '', palettes = 0;
      if (d.destination && d.destination.address) {
        cp = d.destination.address.postcode || '';
        pays = normalizeCountry(
          d.destination.address.country_code || d.destination.address.country || ''
        );
      }
      const loads = (d.loads && d.loads.length) ? d.loads : (d.planned_loads || []);
      loads.forEach(function (l) { palettes += extractPalletsFromLoad(l); });
      rows.push({
        date: dayStr,
        sequential_id: seq,
        delivery_index: idx + 1,
        code_postal_livraison: cp,
        pays_livraison: pays,
        palettes_livrees: palettes
      });
    });
  });

  // UPSERT par clé composite : si (date, sequential_id, delivery_index) existe déjà → réécrit
  mhpPost(TABLE, rows, {
    mode: 'upsert',
    primaryKeys: ['date', 'sequential_id', 'delivery_index']
  });
}

function isInternalTransport(t, INTERNAL) {
  if (!t) return false;
  const c = (t.charter && t.charter.carrier) || t.carrier ||
            (t.carrier_address && t.carrier_address.company);
  return c && c.remote_id && INTERNAL.indexOf(String(c.remote_id)) !== -1;
}

function normalizeCountry(value) {
  const map = {
    FR:'France', PT:'Portugal', ES:'Espagne', DE:'Allemagne', BE:'Belgique',
    IT:'Italie', CH:'Suisse', LU:'Luxembourg', NL:'Pays-Bas', GB:'Royaume-Uni',
    IE:'Irlande', PL:'Pologne', AT:'Autriche', CZ:'République tchèque', SK:'Slovaquie'
  };
  const v = String(value || '').trim();
  return /^[A-Z]{2}$/i.test(v) ? (map[v.toUpperCase()] || v.toUpperCase()) : v;
}

// fetchAllTransports + extractPalletsFromLoad sont fournis par dashdoc_kpi.gs
// (ne pas les redéfinir si vous gardez les 2 scripts dans le même projet)
