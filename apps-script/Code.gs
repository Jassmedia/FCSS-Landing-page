/** @OnlyCurrentDoc */
/**
 * ASTS Oracle FCCS Free Demo: saves registrations from the landing page.
 *
 * ONE Google Apps Script Web App + ONE Google Sheet (the single source of truth):
 *
 *   FCCS landing page (index.html) --POST lead as JSON--> this script --> Google Sheet
 *
 * Tab (created by setup()):
 *   Leads  one row per saved registration
 *
 * The website can only add rows. Nothing in the Sheet is ever sent back.
 *
 * Deploy: Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
 * Full instructions: apps-script/README.md in the website project.
 */

// ---------------------------------------------------------------------------
// Sheet structure
// ---------------------------------------------------------------------------

const LEADS_SHEET = 'Leads';

const LEAD_HEADERS = [
  'Lead ID', 'Submitted At', 'Name', 'Phone', 'Email', 'Country', 'Country Code', 'Role',
  'Availability', 'Course', 'Consent', 'UTM Source', 'UTM Medium', 'UTM Campaign', 'UTM Term',
  'GCLID', 'Page URL', 'Source'
];

// The same choices as the "Select Your Current Role" list on the website
const ROLES = [
  'Student / Fresher',
  'Finance Professional (CA, MBA, M.Com, B.Com)',
  'IT Professional',
  'Working Professional (switching to FCCS)',
  'Oracle EPM Consultant',
  'Other'
];

const DEFAULT_COURSE = 'FCCS';
const MAX_BODY_CHARS = 20000;
// The same person sending the same details again this soon (a retry after a
// slow answer) gets the lead that was already saved instead of a second row
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const DUPLICATE_ROWS_CHECKED = 50;

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/** Health check only: opening the /exec URL in a browser shows {"ok":true,...}. No data is returned. */
function doGet() {
  return json_({
    ok: true,
    service: 'ASTS FCCS registrations',
    status: 'ok',
    time: new Date().toISOString()
  });
}

/**
 * Saves one registration. The body is JSON sent as plain text, which browsers
 * can POST cross-origin without a CORS pre-check.
 */
function doPost(e) {
  let request;
  try {
    const raw = e && e.postData ? String(e.postData.contents || '') : '';
    if (!raw) return json_(fail_('The request was empty.'));
    if (raw.length > MAX_BODY_CHARS) return json_(fail_('The request is too large.'));
    request = JSON.parse(raw);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('not an object');
  } catch (err) {
    return json_(fail_('The request must be a JSON object.'));
  }

  try {
    return json_(saveLead_(request));
  } catch (err) {
    // Never log the request itself: it holds personal details
    console.error('doPost failed: ' + (err && err.stack ? err.stack : err));
    return json_(fail_('Something went wrong on our side. Please try again.'));
  }
}

// ---------------------------------------------------------------------------
// Saving a registration
// ---------------------------------------------------------------------------

function saveLead_(req) {
  // Honeypot: people never see this field, so anything in it means a bot
  if (text_(req.hp, 200)) return fail_('This registration could not be accepted.');

  const name = text_(req.name, 80);
  const phone = String(req.phone === null || req.phone === undefined ? '' : req.phone).replace(/\D/g, '');
  const email = text_(req.email, 254);
  const country = text_(req.country, 60);
  const countryCode = text_(req.country_code, 2).toUpperCase();
  const role = text_(req.role, 80);
  const availability = text_(req.availability, 80);
  const course = text_(req.course, 100) || DEFAULT_COURSE;

  // The same rules as the form on the website
  const errors = {};
  if (!/^[A-Za-z][A-Za-z\s.'-]{1,79}$/.test(name)) errors.name = 'Enter your full name';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Enter a valid email address';
  if (!/^\d{9,15}$/.test(phone) || (countryCode === 'IN' && !/^91[6-9]\d{9}$/.test(phone))) {
    errors.phone = 'Enter a valid WhatsApp number';
  }
  if (ROLES.indexOf(role) === -1) errors.role = 'Select your current role';
  if (availability.length < 2) errors.availability = 'Tell us if you are available for the demo';
  if (!/^[\w .,&()+\/-]{2,100}$/.test(course)) errors.course = 'The course is missing';
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) errors.country = 'Choose your country';
  if (req.consent !== true) errors.consent = 'Tick the consent box';
  if (Object.keys(errors).length) {
    return fail_('Please check your details: ' + Object.keys(errors).map(k => errors[k]).join('. ') + '.', { errors: errors });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fail_('The registration system is busy. Please try again in a moment.');

  try {
    const leads = sheetInfo_(LEADS_SHEET, LEAD_HEADERS);
    const savedAt = new Date();

    const earlierId = recentDuplicate_(leads, phone, email, course, savedAt);
    if (earlierId) return { ok: true, leadId: earlierId, duplicate: true };

    const leadId = newLeadId_(leads, savedAt);
    appendRow_(leads, {
      'Lead ID': leadId,
      'Submitted At': savedAt, // the visitor's device clock is not trusted
      'Name': name,
      'Phone': phone,
      'Email': email,
      'Country': country,
      'Country Code': countryCode,
      'Role': role,
      'Availability': availability,
      'Course': course,
      'Consent': 'Yes',
      'UTM Source': text_(req.utm_source, 200),
      'UTM Medium': text_(req.utm_medium, 200),
      'UTM Campaign': text_(req.utm_campaign, 200),
      'UTM Term': text_(req.utm_term, 200),
      'GCLID': text_(req.gclid, 300),
      'Page URL': url_(req.page_url),
      'Source': text_(req.source, 40)
    });
    SpreadsheetApp.flush(); // the row is written before the website is told "saved"
    return { ok: true, leadId: leadId };
  } finally {
    lock.releaseLock();
  }
}

// Lead ID of a row with the same phone, email and course saved moments ago, or ''
function recentDuplicate_(leads, phone, email, course, now) {
  const last = leads.sheet.getLastRow();
  if (last < 2) return '';
  const count = Math.min(last - 1, DUPLICATE_ROWS_CHECKED);
  const rows = leads.sheet.getRange(last - count + 1, 1, count, leads.width).getValues();
  const C = leads.columns;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const when = row[C['Submitted At']];
    if (!(when instanceof Date) || now.getTime() - when.getTime() > DUPLICATE_WINDOW_MS) continue;
    if (cellText_(row, C['Phone']) === phone &&
        cellText_(row, C['Email']).toLowerCase() === email.toLowerCase() &&
        cellText_(row, C['Course']) === course) {
      return cellText_(row, C['Lead ID']);
    }
  }
  return '';
}

// FCCS-20261010-7F3A1C (the date uses the Sheet's time zone)
function newLeadId_(leads, when) {
  const day = Utilities.formatDate(when, sheetTimeZone_(), 'yyyyMMdd');
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = 'FCCS-' + day + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
    if (!findRow_(leads, 'Lead ID', id)) return id;
  }
  throw new Error('Could not create a unique lead ID');
}

// ---------------------------------------------------------------------------
// Setup (run once from the Apps Script editor)
// ---------------------------------------------------------------------------

/** Creates the Leads tab with its headers. Safe to run again: it never removes data. */
function setup() {
  const leads = sheetInfo_(LEADS_SHEET, LEAD_HEADERS);
  const sheet = leads.sheet;
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, leads.width).setFontWeight('bold');
  if (sheet.getMaxRows() > 1) {
    sheet.getRange(2, leads.columns['Submitted At'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  console.log('Setup complete. The "' + LEADS_SHEET + '" tab is ready.');
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

const SHEET_CACHE_ = {};

/**
 * The tab plus a header -> column map. Creates the tab if it is missing and
 * adds any missing header at the end, so columns can be reordered safely.
 */
function sheetInfo_(name, headers) {
  if (SHEET_CACHE_[name]) return SHEET_CACHE_[name];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from the Google Sheet: Extensions > Apps Script.');

  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    try {
      sheet = ss.insertSheet(name);
    } catch (err) {
      sheet = ss.getSheetByName(name); // created at the same moment by another request
      if (!sheet) throw err;
    }
  }

  let current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
    .map(h => String(h).trim());
  if (current.every(h => h === '')) current = [];
  const missing = headers.filter(h => current.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
    current = current.concat(missing);
    sheet.getRange(1, 1, 1, current.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  const columns = {};
  current.forEach((h, i) => { if (h && !(h in columns)) columns[h] = i; });
  return (SHEET_CACHE_[name] = { sheet: sheet, columns: columns, width: current.length });
}

function appendRow_(info, record) {
  const row = new Array(info.width).fill('');
  Object.keys(record).forEach(header => {
    const i = info.columns[header];
    if (i !== undefined) row[i] = cell_(record[header]);
  });
  info.sheet.appendRow(row);
}

/**
 * Text is stored as plain text: the leading apostrophe stops Sheets from
 * running "=..." as a formula or turning "919876543210" into a number.
 * The apostrophe is not part of the stored value. Dates stay real dates.
 */
function cell_(value) {
  if (value instanceof Date) return value;
  if (value === null || value === undefined || value === '') return '';
  return "'" + String(value);
}

// Row number (2+) whose cell under `header` equals `value` exactly, or 0
function findRow_(info, header, value) {
  const last = info.sheet.getLastRow();
  if (last < 2 || !value) return 0;
  const match = info.sheet.getRange(2, info.columns[header] + 1, last - 1, 1)
    .createTextFinder(value).matchCase(true).matchEntireCell(true).findNext();
  return match ? match.getRow() : 0;
}

function sheetTimeZone_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
}

// ---------------------------------------------------------------------------
// Input and value helpers
// ---------------------------------------------------------------------------

// One line of text: control characters removed, spaces collapsed, length capped
function text_(value, max) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function url_(value) {
  const s = text_(value, 500);
  return /^https?:\/\//i.test(s) ? s : '';
}

function cellText_(row, index) {
  if (index === undefined) return '';
  const value = row[index];
  return value === null || value === undefined ? '' : String(value).trim();
}

function fail_(message, extra) {
  return Object.assign({ ok: false, error: message }, extra || {});
}

function json_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
