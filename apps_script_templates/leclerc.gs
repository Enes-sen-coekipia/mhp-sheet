/**
 * Leclerc CSV → MHP DataSheet
 * Remplace importLeclercCSV().
 *
 * Lit les CSV déposés dans Drive/Leclerc/CSV_A_Importer, parse en gérant
 * les encodages (CP1252/UTF-8/ISO-8859-1), et upsert par n° de transaction.
 */
function importLeclercCSV() {
  const FOLDER_SOURCE  = 'CSV_A_Importer';
  const FOLDER_ARCHIVE = 'CSV_Archives';
  const TABLE          = 'suivi_carburant_et_peages';
  const DELIMITER      = ';';
  const HEADERS = [
    'col_a', 'col_b', 'col_c', 'transaction_id', 'col_e', 'col_f',
    'col_g', 'col_h', 'col_i', 'col_j'  // ⚠️ adapter aux vrais noms de colonnes
  ];

  const root = DriveApp.getRootFolder();
  const folders = root.getFoldersByName('Leclerc');
  if (!folders.hasNext()) { Logger.log('Dossier Leclerc introuvable'); return; }

  const leclercFolder = folders.next();
  const sourceFolder  = leclercFolder.getFoldersByName(FOLDER_SOURCE).next();
  const archiveFolder = leclercFolder.getFoldersByName(FOLDER_ARCHIVE).next();
  const files = sourceFolder.getFilesByType(MimeType.CSV);

  let totalRows = 0;
  while (files.hasNext()) {
    const file = files.next();
    const csv = parseCsvWithBestEncoding_(file.getBlob(), DELIMITER);

    if (!csv || csv.length === 0) {
      Logger.log('CSV vide/illisible: ' + file.getName());
      archiveFolder.addFile(file); sourceFolder.removeFile(file);
      continue;
    }

    csv.shift();  // skip header
    if (csv.length === 0) { archiveFolder.addFile(file); sourceFolder.removeFile(file); continue; }

    // Map vers objets
    const rows = rowsToObjects(csv, HEADERS);

    // UPSERT par transaction_id → pas besoin de supprimerDoublonsLeclerc()
    mhpPost(TABLE, rows, { mode: 'upsert', primaryKeys: ['transaction_id'] });
    totalRows += rows.length;

    archiveFolder.addFile(file);
    sourceFolder.removeFile(file);
  }

  Logger.log('Leclerc OK — ' + totalRows + ' lignes traitées');
}

function parseCsvWithBestEncoding_(blob, delimiter) {
  const encodings = ['windows-1252', 'UTF-8', 'ISO-8859-1'];
  let best = null, bestScore = -1;
  encodings.forEach(function (enc) {
    const text = blob.getDataAsString(enc);
    const score = encodingScore_(text);
    if (score > bestScore) { bestScore = score; best = Utilities.parseCsv(text, delimiter); }
  });
  return best;
}

function encodingScore_(s) {
  if (!s) return -999;
  const qmarks  = (s.match(/\?/g) || []).length;
  const repl    = (s.match(/�/g) || []).length;
  const accents = (s.match(/[éèêëàâäîïôöùûüçÉÈÊËÀÂÄÎÏÔÖÙÛÜÇ]/g) || []).length;
  const euros   = (s.match(/€/g) || []).length;
  return (accents * 3) + (euros * 5) - (qmarks * 2) - (repl * 10);
}
