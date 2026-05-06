/**
 * Shiptify webhook relay → MHP DataSheet
 * Remplace le doPost() qui écrivait dans Google Sheet.
 *
 * Cette WebApp Apps Script reçoit les webhooks Shiptify et les forwarde
 * vers POST /api/webhook/shiptify de MHP DataSheet.
 *
 * 💡 Encore mieux : configurer Shiptify pour POSTer DIRECTEMENT vers
 *    http://192.168.1.7:8081/api/webhook/shiptify  (URL accessible depuis internet
 *    via reverse proxy / DynDNS / Cloudflare Tunnel). Si pas possible (LAN privé),
 *    cette WebApp Apps Script reste utile comme relais public.
 */

function doGet(e) {
  return ContentService.createTextOutput("OK GET — Shiptify relay opérationnel");
}

function doPost(e) {
  const rawBody = (e && e.postData && e.postData.contents) || '';

  // Cas particulier : test initial Shiptify (renvoie "Pending")
  if (rawBody === 'Pending') {
    Logger.log('Test Shiptify "Pending"');
    return ContentService.createTextOutput("OK test");
  }

  // Forward du payload tel quel vers MHP DataSheet
  try {
    UrlFetchApp.fetch(MHP_API + '/webhook/shiptify', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-API-Token': MHP_TOKEN },
      payload: rawBody,
      muteHttpExceptions: true
    });
    Logger.log('Shiptify → MHP forwarded (' + rawBody.length + ' chars)');
    return ContentService.createTextOutput("OK");
  } catch (err) {
    Logger.log('❌ Forward MHP failed: ' + err.message);
    return ContentService.createTextOutput("Forward failed: " + err.message);
  }
}
