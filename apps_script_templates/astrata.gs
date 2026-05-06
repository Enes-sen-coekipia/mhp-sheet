/**
 * Astrata FleetVisor → MHP DataSheet
 * Remplace recupererVehiculesCompteurs() / recupererAssets() / recupererChauffeursAssets().
 *
 * - Lit les positions de véhicules via XML (mailbox + retrieve)
 * - Upsert dans 'vehicules_compteurs' par (vehicle_id + date_pos)
 * - Replace_all sur 'referentiel_vehicules' et 'referentiel_chauffeurs'
 * - Purge AddSecure après traitement
 */
const ASTRATA_BASE_URL = 'https://export.fleetvisor.eu/wstpi/Service.svc/rest/';
const ASTRATA_CUSTOMER = 'essentiel';
const ASTRATA_USERNAME = 'aperrichon';
const ASTRATA_PASSWORD = 'MHPgroupe42!';

function recupererVehiculesCompteurs() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const props = PropertiesService.getScriptProperties();
    const lastPacket = Number(props.getProperty('LAST_PACKET_ID')) || 0;

    // 1) Mailbox
    const mailboxXml = XmlService.parse(UrlFetchApp.fetch(
      ASTRATA_BASE_URL + 'getmailboxinfo?customer=' + ASTRATA_CUSTOMER +
      '&username=' + ASTRATA_USERNAME + '&password=' + ASTRATA_PASSWORD
    ).getContentText());
    const ns0 = mailboxXml.getRootElement().getNamespace();
    const count = Number(mailboxXml.getRootElement().getChild('Count', ns0).getText());
    if (count === 0) { Logger.log('Aucune nouvelle donnée'); return; }

    // 2) Retrieve
    const xml = XmlService.parse(UrlFetchApp.fetch(
      ASTRATA_BASE_URL + 'retrieve?customer=' + ASTRATA_CUSTOMER +
      '&username=' + ASTRATA_USERNAME + '&password=' + ASTRATA_PASSWORD +
      '&markasread=false&maxcount=1000'
    ).getContentText());
    const root = xml.getRootElement();
    const ns = root.getNamespace();
    const positionsNode = root.getChild('Positions', ns);
    if (!positionsNode) return;

    const rows = [];
    let minPacket = null, maxPacket = lastPacket;

    positionsNode.getChildren('Pos', ns).forEach(function (p) {
      const packetId = Number(p.getChild('PacketId', ns).getText());
      if (packetId <= lastPacket) return;  // anti-doublon

      rows.push({
        vehicle_id: p.getChild('AssetId', ns).getText() || '',
        date_pos:   p.getChild('DT', ns).getText() || '',
        odometer:   p.getChild('Odometer', ns).getText() || '',
        fuel_used:  p.getChild('FuelUsed', ns).getText() || ''
      });

      if (minPacket === null || packetId < minPacket) minPacket = packetId;
      if (packetId > maxPacket) maxPacket = packetId;
    });

    if (rows.length > 0) {
      // UPSERT par (vehicle_id + date_pos) → pas de doublon possible
      mhpPost('vehicules_compteurs', rows, {
        mode: 'upsert',
        primaryKeys: ['vehicle_id', 'date_pos']
      });
    }

    // 3) Sauvegarde dernier packet
    if (maxPacket > lastPacket) {
      props.setProperty('LAST_PACKET_ID', String(maxPacket));
    }

    // 4) Purge AddSecure
    if (minPacket !== null) {
      UrlFetchApp.fetch(
        ASTRATA_BASE_URL + 'purge?customer=' + ASTRATA_CUSTOMER +
        '&username=' + ASTRATA_USERNAME + '&password=' + ASTRATA_PASSWORD +
        '&minpacketid=' + minPacket + '&maxpacketid=' + maxPacket
      );
    }

    Logger.log('Astrata OK — dernier PacketId = ' + maxPacket);
  } finally {
    lock.releaseLock();
  }

  // Sync référentiels
  recupererAssets();
  recupererChauffeursAssets();
}

function recupererAssets() {
  const xml = XmlService.parse(UrlFetchApp.fetch(
    ASTRATA_BASE_URL + 'getassets?customer=' + ASTRATA_CUSTOMER +
    '&username=' + ASTRATA_USERNAME + '&password=' + ASTRATA_PASSWORD +
    '&assets=vehicle=all'
  ).getContentText());
  const root = xml.getRootElement();
  const ns = root.getNamespace();

  const rows = [];
  root.getChildren('Asset', ns).forEach(function (a) {
    if (a.getChild('AssetType', ns).getText() === 'Vehicle') {
      rows.push({
        vehicle_id: a.getChild('Id', ns).getText() || '',
        plaque:     a.getChild('Alias', ns).getText() || ''
      });
    }
  });

  // Le référentiel est entièrement remplacé à chaque sync
  mhpPost('referentiel_vehicules', rows, { mode: 'replace_all' });
}

function recupererChauffeursAssets() {
  const xml = XmlService.parse(UrlFetchApp.fetch(
    ASTRATA_BASE_URL + 'getassets?customer=' + ASTRATA_CUSTOMER +
    '&username=' + ASTRATA_USERNAME + '&password=' + ASTRATA_PASSWORD +
    '&assets=driver=all'
  ).getContentText());
  const root = xml.getRootElement();
  const ns = root.getNamespace();

  const rows = [];
  root.getChildren('Asset', ns).forEach(function (a) {
    if (a.getChild('AssetType', ns).getText() === 'Driver') {
      const id    = a.getChild('Id', ns).getText() || '';
      const first = a.getChild('FirstName', ns).getText() || '';
      const last  = a.getChild('LastName', ns).getText() || '';
      rows.push({ driver_id: id, chauffeur: (first + ' ' + last).trim() });
    }
  });

  mhpPost('referentiel_chauffeurs', rows, { mode: 'replace_all' });
}
