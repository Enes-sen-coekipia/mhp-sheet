/**
 * Stock It preparateur → MHP DataSheet
 * Remplace importStockitPreparateur().
 *
 * Lit le mail le plus récent labellisé 'stockitpreparateur', extrait la pièce jointe,
 * et POST vers la table 'suivi_equipe'.
 */
function importStockitPreparateur() {
  const LABEL_NAME = 'stockitpreparateur';
  const TABLE      = 'suivi_equipe';
  const HEADERS = [
    'code', 'date', 'operation', 'client', 'duree',
    'n_bl_n_palette', 'um_consolide', 'productivite', 'alerte', 'duree_nbr'
  ];

  const props = PropertiesService.getScriptProperties();
  const lastImportTime = props.getProperty('LAST_IMPORT_TIME');

  const threads = GmailApp.search('label:' + LABEL_NAME + ' has:attachment', 0, 1);
  if (threads.length === 0) { Logger.log('Aucun mail trouvé'); return; }

  const message = threads[0].getMessages().pop();
  const messageDate = message.getDate().getTime();

  // Idempotence : skip si déjà traité
  if (lastImportTime && messageDate <= Number(lastImportTime)) {
    Logger.log('Aucun nouveau fichier');
    return;
  }

  const attachments = message.getAttachments();
  attachments.forEach(function (file) {
    // Conversion XLSX → Google Sheets
    const tempFile = Drive.Files.insert(
      { title: file.getName(), mimeType: MimeType.GOOGLE_SHEETS },
      file.copyBlob()
    );
    const sourceSheet = SpreadsheetApp.openById(tempFile.id).getSheets()[0];
    const data = sourceSheet.getDataRange().getDisplayValues();
    data.shift();  // skip header

    // Push vers MHP DataSheet
    const rows = rowsToObjects(data, HEADERS);
    mhpPost(TABLE, rows, { mode: 'append' });

    DriveApp.getFileById(tempFile.id).setTrashed(true);
  });

  props.setProperty('LAST_IMPORT_TIME', messageDate.toString());
  Logger.log('Import suivi_equipe effectué avec succès');
}
