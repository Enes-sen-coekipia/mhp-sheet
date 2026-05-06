/**
 * Helper partagé — à coller UNE SEULE FOIS dans le projet Apps Script.
 * Tous les autres scripts (stock_it.gs, dashdoc_kpi.gs, etc.) appellent mhpPost(...).
 *
 * ⚠️ À METTRE À JOUR avec les valeurs de TON serveur :
 *    - MHP_API   : URL de l'API (sans / final)
 *    - MHP_TOKEN : token configuré dans .env côté serveur (INGEST_API_TOKEN)
 */
const MHP_API   = 'http://192.168.1.7:8081/api';   // ← prod : adapter l'IP
// const MHP_API = 'http://localhost:3000/api';     // ← dev (sur le PC du dev)

const MHP_TOKEN = 'REMPLACER_PAR_LE_TOKEN_INGEST'; // ← copier depuis .env (INGEST_API_TOKEN)

/**
 * Envoie un batch de lignes vers une table de MHP DataSheet.
 *
 * @param {string} tableName  Nom de la table PG (ex: 'stock_it')
 * @param {Array<Object>} rows  Liste d'objets {col1: val, col2: val, ...}
 * @param {Object} [options]
 * @param {string} [options.mode='append']  'append' | 'upsert' | 'replace_all'
 * @param {Array<string>} [options.primaryKeys]  requis si mode='upsert'
 * @param {string} [options.truncateWhere]  optionnel pour replace_all partiel
 * @returns {Object} réponse JSON {table, mode, submitted, inserted, deleted}
 */
function mhpPost(tableName, rows, options) {
  options = options || {};
  if (!rows || rows.length === 0) {
    Logger.log('mhpPost: aucune ligne à envoyer pour ' + tableName);
    return { submitted: 0, inserted: 0 };
  }

  const payload = {
    rows: rows,
    mode: options.mode || 'append'
  };
  if (options.primaryKeys) payload.primary_keys = options.primaryKeys;
  if (options.truncateWhere) payload.truncate_where = options.truncateWhere;

  const url = MHP_API + '/table/' + encodeURIComponent(tableName) + '/rows';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-API-Token': MHP_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    Logger.log('❌ mhpPost ' + tableName + ' HTTP ' + code + ': ' + body.slice(0, 500));
    throw new Error('mhpPost failed: ' + code + ' ' + body.slice(0, 200));
  }

  const result = JSON.parse(body);
  Logger.log('✅ mhpPost ' + tableName + ' [' + payload.mode + '] '
             + result.submitted + ' soumises, '
             + result.inserted + ' inserted, '
             + result.deleted + ' deleted');
  return result;
}

/**
 * Convertit un Array<Array> (lignes brutes type Sheets) en Array<Object>
 * en utilisant les en-têtes fournis.
 *
 * @param {Array<Array>} matrix  ex: [['A','B'], ['C','D']]
 * @param {Array<string>} headers ex: ['col1','col2']
 * @returns {Array<Object>} ex: [{col1:'A',col2:'B'}, {col1:'C',col2:'D'}]
 */
function rowsToObjects(matrix, headers) {
  return matrix.map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) {
      obj[h] = (row[i] === undefined || row[i] === null) ? null : String(row[i]);
    });
    return obj;
  });
}
