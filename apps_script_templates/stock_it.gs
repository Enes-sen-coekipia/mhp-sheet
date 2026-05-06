/**
 * Stock_It → MHP DataSheet
 * Remplace importStockItReport() qui écrivait dans Google Sheets.
 *
 * Lit le mail le plus récent labellisé 'stockit', extrait la pièce jointe XLSX,
 * la convertit en CSV via Drive, et POST vers PostgreSQL.
 */
function importStockItReport() {
  const GMAIL_LABEL = 'stockit';
  const TABLE       = 'stock_it';
  const HEADERS = [
    'date', 'nbr_bl_entree', 'palettes_entree', 'pal_livree_sortie',
    'palettes_en_stock', 'references_en_stock', 'volume_picking',
    'taux_prepa_homogene', 'client', 'fiabilite_de_stock'
  ];

  // 1) Récupère le dernier mail
  const threads = GmailApp.search('label:' + GMAIL_LABEL + ' newer_than:2d');
  if (threads.length === 0) { Logger.log('❌ Aucun mail trouvé'); return; }
  const message = threads[0].getMessages().pop();
  const attachments = message.getAttachments();
  if (attachments.length === 0) { Logger.log('❌ Pas de pièce jointe'); return; }
  const attachment = attachments[0];

  // 2) Convertit XLSX → Google Sheets temporaire
  const fileName = 'Temp_StockIt_' + new Date().toISOString();
  const tempExcel = DriveApp.createFile(attachment.copyBlob());
  tempExcel.setName(fileName + '.xlsx');
  const converted = Drive.Files.copy(
    { title: fileName, mimeType: MimeType.GOOGLE_SHEETS },
    tempExcel.getId(),
    { convert: true }
  );

  // 3) Exporte en CSV
  const csv = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v2/files/' + converted.id + '/export?mimeType=text/csv&alt=media',
    { method: 'get', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }
  ).getContentText();

  // 4) Cleanup
  Drive.Files.remove(converted.id);
  tempExcel.setTrashed(true);

  // 5) Parse + push vers MHP DataSheet (skip header CSV)
  const matrix = Utilities.parseCsv(csv).slice(1);
  const rows = rowsToObjects(matrix, HEADERS);

  // mode 'append' : on ajoute les nouvelles lignes (pas de dédoublonnage côté API)
  // → si tu veux éviter les doublons, passer en mode 'upsert' avec une PK
  mhpPost(TABLE, rows, { mode: 'append' });
}
