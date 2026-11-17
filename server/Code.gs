/**
 * Receipt Photobooth — sharing server (Google Apps Script).
 *
 * Stores each session's colour copy in Google Drive, serves the download page a guest reaches
 * from the QR code, emails photos, lists event galleries and hands vouchers to the booth.
 *
 * SETUP
 * 1. script.google.com > New project. Replace everything in Code.gs with this file.
 * 2. Change BOOTH_KEY below to your own secret text.
 * 3. Choose the function "setup" in the toolbar and press Run. Approve the permissions.
 * 4. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone. Deploy.
 * 5. Copy the Web app URL (it ends in /exec) into the booth: Settings > Sharing > Server address,
 *    and type the same BOOTH_KEY into Settings > Sharing > Booth key.
 * After editing this file later: Deploy > Manage deployments > edit > Version: New version.
 */

var BOOTH_KEY = 'CHANGE-THIS-KEY';
var FOLDER_NAME = 'Receipt Photobooth';
var BOOK_NAME = 'Receipt Photobooth Data';
var MAX_EMAILS_PER_PHOTO = 5;

var SESSION_HEAD = ['id', 'event', 'fileId', 'created', 'gallery', 'emails'];
var VOUCHER_HEAD = ['code', 'status', 'created', 'usedAt'];

/* ---------- storage ---------- */

function props_() { return PropertiesService.getScriptProperties(); }

function folder_() {
  var id = props_().getProperty('FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var f = DriveApp.createFolder(FOLDER_NAME);
  props_().setProperty('FOLDER', f.getId());
  return f;
}

function book_() {
  var id = props_().getProperty('BOOK');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  var b = SpreadsheetApp.create(BOOK_NAME);
  props_().setProperty('BOOK', b.getId());
  return b;
}

function sheet_(name, head) {
  var b = book_();
  var s = b.getSheetByName(name);
  if (!s) {
    s = b.insertSheet(name);
    s.appendRow(head);
    s.getRange('A:A').setNumberFormat('@'); // ids and codes stay text
  }
  return s;
}

function rows_(s) {
  var v = s.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < v.length; i++) out.push({ row: i + 1, v: v[i] });
  return out;
}

function find_(s, value) {
  var all = rows_(s);
  for (var i = 0; i < all.length; i++) if (String(all[i].v[0]) === String(value)) return all[i];
  return null;
}

/** Run once from the editor to create the folder and spreadsheet and grant permissions. */
function setup() {
  folder_();
  sheet_('Sessions', SESSION_HEAD);
  sheet_('Vouchers', VOUCHER_HEAD);
  MailApp.getRemainingDailyQuota();
  Logger.log('Ready. Folder: ' + folder_().getUrl() + '  Data: ' + book_().getUrl());
}

/* ---------- booth API (POST, JSON sent as text/plain) ---------- */

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var b = JSON.parse(e.postData.contents);
    if (b.key !== BOOTH_KEY) return json_({ ok: false, error: 'Wrong booth key.' });
    if (b.action === 'ping') return json_({ ok: true });
    if (b.action === 'upload') return json_(upload_(b));
    if (b.action === 'email') return json_(email_(b.id, b.to));
    if (b.action === 'vouchers') return json_(queued_());
    if (b.action === 'voucherAck') return json_(ack_(b.codes || []));
    if (b.action === 'redeem') return json_(redeem_(b.code));
    return json_({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function upload_(b) {
  if (!/^[A-Za-z][A-Za-z0-9]{7,19}$/.test(String(b.id))) throw new Error('Bad photo id.');
  var bytes = Utilities.base64Decode(b.jpeg);
  var blob = Utilities.newBlob(bytes, 'image/jpeg', String(b.name || b.id).replace(/[^\w.\-]/g, '_'));
  var event = String(b.event || '').slice(0, 40);
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var s = sheet_('Sessions', SESSION_HEAD);
    var hit = find_(s, b.id);
    var file = folder_().createFile(blob);
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
    if (hit) {
      try { DriveApp.getFileById(hit.v[2]).setTrashed(true); } catch (e) {}
      s.getRange(hit.row, 2, 1, 2).setValues([[event, file.getId()]]);
      s.getRange(hit.row, 5).setValue(b.gallery ? 'yes' : '');
    } else {
      s.appendRow([String(b.id), event, file.getId(), new Date(), b.gallery ? 'yes' : '', 0]);
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true, id: b.id };
}

function email_(id, to) {
  to = String(to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw new Error('That email address does not look right.');
  var s = sheet_('Sessions', SESSION_HEAD);
  var hit = find_(s, id);
  if (!hit) throw new Error('This photo has not finished uploading yet. Try again in a moment.');
  var sent = Number(hit.v[5]) || 0;
  if (sent >= MAX_EMAILS_PER_PHOTO) throw new Error('This photo has already been emailed the maximum number of times.');
  if (MailApp.getRemainingDailyQuota() < 1) throw new Error('The daily email limit has been reached. Use the QR code instead.');
  var file = DriveApp.getFileById(hit.v[2]);
  var link = pageUrl_(id);
  MailApp.sendEmail({
    to: to,
    subject: 'Your photobooth photo',
    htmlBody: '<p>Thanks for stopping by! Your photo is attached.</p><p>You can also open it here: <a href="' + link + '">' + link + '</a></p>',
    attachments: [file.getBlob()]
  });
  s.getRange(hit.row, 6).setValue(sent + 1);
  return { ok: true };
}

/* ---------- vouchers ---------- */

/** Called from the phone page. Queues new voucher codes for the booth to print. */
function createVouchers(key, count) {
  if (key !== BOOTH_KEY) throw new Error('Wrong booth key.');
  count = Math.max(1, Math.min(20, Number(count) || 1));
  var s = sheet_('Vouchers', VOUCHER_HEAD);
  var taken = {};
  rows_(s).forEach(function (r) { taken[String(r.v[0])] = true; });
  var codes = [];
  while (codes.length < count) {
    var code = String(100000 + Math.floor(Math.random() * 900000));
    if (taken[code]) continue;
    taken[code] = true;
    codes.push(code);
    s.appendRow([code, 'queued', new Date(), '']);
  }
  return codes;
}

function queued_() {
  var codes = [];
  rows_(sheet_('Vouchers', VOUCHER_HEAD)).forEach(function (r) {
    if (r.v[1] === 'queued') codes.push(String(r.v[0]));
  });
  return { ok: true, codes: codes };
}

function ack_(codes) {
  var s = sheet_('Vouchers', VOUCHER_HEAD);
  var want = {};
  codes.forEach(function (c) { want[String(c)] = true; });
  rows_(s).forEach(function (r) {
    if (want[String(r.v[0])] && r.v[1] === 'queued') s.getRange(r.row, 2).setValue('printed');
  });
  return { ok: true };
}

function redeem_(code) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var s = sheet_('Vouchers', VOUCHER_HEAD);
    var hit = find_(s, String(code || '').trim());
    if (!hit) throw new Error('That voucher code was not found.');
    if (hit.v[1] === 'used') throw new Error('That voucher has already been used.');
    s.getRange(hit.row, 2).setValue('used');
    s.getRange(hit.row, 4).setValue(new Date());
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/* ---------- pages (GET) ---------- */

function baseUrl_() { return ScriptApp.getService().getUrl(); }
function pageUrl_(id) { return baseUrl_() + '?p=' + encodeURIComponent(id); }
function esc_(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var STYLE = '<style>' +
  'body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f1e8;color:#141414;line-height:1.5}' +
  'main{max-width:560px;margin:0 auto;padding:24px 16px 48px;display:grid;gap:16px}' +
  'h1{font-size:26px;margin:0}p{margin:0}' +
  '.card{background:#fffdf8;border:1.5px solid #dcd7c9;border-radius:18px;padding:16px;display:grid;gap:12px}' +
  'img.photo{width:100%;height:auto;border-radius:10px;display:block;background:#fff}' +
  'a.btn,button{font:700 16px inherit;display:block;text-align:center;text-decoration:none;min-height:48px;line-height:28px;padding:10px 20px;border-radius:999px;border:2px solid #141414;background:#141414;color:#fff;cursor:pointer;box-sizing:border-box;width:100%}' +
  'a.btn.ghost{background:#fffdf8;color:#141414}' +
  'input{font:16px inherit;padding:12px;border:1.5px solid #dcd7c9;border-radius:10px;width:100%;box-sizing:border-box}' +
  'label{display:grid;gap:6px;font-weight:600;font-size:14px}' +
  '.note{font-size:14px;color:#6e6a5f}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}' +
  '.grid img{width:100%;border-radius:10px;display:block;border:1.5px solid #dcd7c9;background:#fff}' +
  '.codes{font:700 22px ui-monospace,monospace;letter-spacing:.1em;display:grid;gap:4px}' +
  '</style>';

function page_(title, body) {
  return HtmlService.createHtmlOutput('<!doctype html><html><head><base target="_top">' + STYLE + '</head><body><main>' + body + '</main></body></html>')
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doGet(e) {
  var q = (e && e.parameter) || {};
  if (q.p) return photoPage_(String(q.p));
  if (q.g) return galleryPage_(String(q.g));
  if (q.admin) return adminPage_();
  return page_('Receipt Photobooth', '<h1>Receipt Photobooth</h1><p class="note">The sharing server is running.</p>');
}

function photoPage_(id) {
  var hit = find_(sheet_('Sessions', SESSION_HEAD), id);
  if (!hit) {
    return page_('Your photo', '<h1>Almost there</h1><div class="card"><p>Your photo is still uploading from the booth. Give it a minute, then try again.</p>' +
      '<a class="btn" href="' + esc_(pageUrl_(id)) + '">Try again</a></div>');
  }
  var file = DriveApp.getFileById(hit.v[2]);
  var data = Utilities.base64Encode(file.getBlob().getBytes());
  var body = '<h1>Your photo</h1><div class="card">' +
    '<img class="photo" alt="Your photobooth photo" src="data:image/jpeg;base64,' + data + '">' +
    '<a class="btn" target="_blank" href="https://drive.google.com/uc?export=download&id=' + esc_(file.getId()) + '">Download</a>' +
    '<p class="note">On a phone you can also press and hold the photo to save it.</p></div>' +
    '<div class="card"><label>Email me my photo<input id="to" type="email" inputmode="email" placeholder="name@example.com"></label>' +
    '<button id="send">Send</button><p class="note" id="msg" role="status"></p></div>';
  if (hit.v[4] === 'yes' && hit.v[1]) {
    body += '<a class="btn ghost" href="' + esc_(baseUrl_() + '?g=' + encodeURIComponent(hit.v[1])) + '">See the event gallery</a>';
  }
  body += '<script>var id=' + JSON.stringify(id) + ';var b=document.getElementById("send"),m=document.getElementById("msg");' +
    'b.onclick=function(){var to=document.getElementById("to").value;b.disabled=true;m.textContent="Sending...";' +
    'google.script.run.withSuccessHandler(function(){m.textContent="Sent. Check your inbox.";b.disabled=false;})' +
    '.withFailureHandler(function(e){m.textContent=e.message;b.disabled=false;}).emailPhoto(id,to);};</script>';
  return page_('Your photo', body);
}

/** Called from the photo page. */
function emailPhoto(id, to) {
  email_(id, to);
  return true;
}

function galleryPage_(event) {
  var items = '';
  var all = rows_(sheet_('Sessions', SESSION_HEAD));
  for (var i = all.length - 1; i >= 0; i--) {
    var r = all[i];
    if (r.v[4] === 'yes' && String(r.v[1]) === event) {
      items += '<a href="' + esc_(pageUrl_(r.v[0])) + '"><img loading="lazy" alt="Photo" src="https://drive.google.com/thumbnail?id=' + esc_(r.v[2]) + '&sz=w400"></a>';
    }
  }
  return page_('Event gallery', '<h1>' + esc_(event) + '</h1>' +
    (items ? '<div class="grid">' + items + '</div>' : '<p class="note">No photos in this gallery yet.</p>'));
}

function adminPage_() {
  var body = '<h1>Print vouchers</h1><div class="card">' +
    '<label>Booth key<input id="key" type="password" autocomplete="off"></label>' +
    '<label>How many vouchers (1 to 20)<input id="n" type="number" min="1" max="20" value="1"></label>' +
    '<button id="go">Send to the booth printer</button><p class="note" id="msg" role="status"></p>' +
    '<div class="codes" id="codes"></div>' +
    '<p class="note">The booth prints queued vouchers while it is on its welcome screen.</p></div>' +
    '<script>var b=document.getElementById("go"),m=document.getElementById("msg");b.onclick=function(){b.disabled=true;m.textContent="Sending...";' +
    'google.script.run.withSuccessHandler(function(c){m.textContent=c.length+" voucher(s) queued:";document.getElementById("codes").textContent=c.join("\\n");document.getElementById("codes").style.whiteSpace="pre";b.disabled=false;})' +
    '.withFailureHandler(function(e){m.textContent=e.message;b.disabled=false;})' +
    '.createVouchers(document.getElementById("key").value,document.getElementById("n").value);};</script>';
  return page_('Print vouchers', body);
}
