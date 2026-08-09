/**
 * Inbound CBT - MotherDuck to Google Sheets mirror.
 * Deploy as a Web App (execute as owner, access: anyone) and set these Script Properties:
 *   GSHEET_SYNC_SECRET = a long random secret shared only with Vercel
 */

var GSHEET_SYNC_SPREADSHEET_ID = "1Q9R1TQuksL5pCc94vWfwKFUrzdN9nQlwXJZvtBxRbfE";
var GSHEET_SYNC_SHEET_NAME = "Output form";

var GSHEET_SYNC_HEADERS = [
  "ticket_po_id", "ticket_id", "queue_no", "ticket_type", "status",
  "vendor_name", "po_number", "total_po_qty", "actual_quantity", "count_po_sku",
  "fleet_type", "plat_number", "driver_name", "phone_number", "ktp_6_digit",
  "gate", "slot", "operational_date", "registered_by", "unload_sla", "source",
  "register_time", "created_at", "updated_at", "called_at", "arrived_at",
  "start_unloading_at", "finish_unloading_at", "expired_at", "expired_reason",
  "call_count", "last_call_at", "checker_status", "gr_status", "checker_id",
  "checker_name", "checker_started_at", "checker_done_at", "done_gr_at",
  "handover_grn_at", "po_updated_at"
];

function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || "").trim();
  if (action !== "health") return gsheetSyncJson_({ status: "error", message: "Unknown action" });
  return gsheetSyncJson_({
    status: "success",
    service: "Inbound CBT GSheet Sync",
    sheet: GSHEET_SYNC_SHEET_NAME,
    timestamp: new Date().toISOString()
  });
}

function doPost(e) {
  try {
    var body = gsheetSyncParseBody_(e);
    var action = String((e && e.parameter && e.parameter.action) || body.action || "").trim();
    if (action !== "submitSecurity" && action !== "syncInboundRows") {
      throw new Error("Unknown action: " + action);
    }

    var payload = body.payload || body;
    gsheetSyncAuthorize_(payload.sync_secret);
    var rows = Array.isArray(payload.rows) ? payload.rows : [];
    var result = gsheetSyncUpsertRows_(rows);
    return gsheetSyncJson_({
      status: "success",
      action: action,
      received_rows: rows.length,
      inserted_rows: result.inserted,
      updated_rows: result.updated,
      skipped_rows: result.skipped
    });
  } catch (error) {
    return gsheetSyncJson_({ status: "error", message: String(error && error.message || error) });
  }
}

function gsheetSyncAuthorize_(suppliedSecret) {
  var expected = String(
    PropertiesService.getScriptProperties().getProperty("GSHEET_SYNC_SECRET") || ""
  ).trim();
  if (!expected) throw new Error("GSHEET_SYNC_SECRET belum diset di Script Properties");
  if (String(suppliedSecret || "").trim() !== expected) throw new Error("Unauthorized");
}

function gsheetSyncUpsertRows_(rows) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var spreadsheet = SpreadsheetApp.openById(GSHEET_SYNC_SPREADSHEET_ID);
    var sheet = spreadsheet.getSheetByName(GSHEET_SYNC_SHEET_NAME);
    if (!sheet) sheet = spreadsheet.insertSheet(GSHEET_SYNC_SHEET_NAME);
    var headers = gsheetSyncEnsureHeaders_(sheet);
    var keyIndex = headers.indexOf("ticket_po_id");
    if (keyIndex < 0) throw new Error("Header ticket_po_id tidak tersedia");

    var lastRow = sheet.getLastRow();
    var existingKeys = {};
    if (lastRow > 1) {
      var keyValues = sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getDisplayValues();
      keyValues.forEach(function(value, index) {
        var key = String(value[0] || "").trim();
        if (key) existingKeys[key] = { rowNumber: index + 2, appendIndex: -1 };
      });
    }

    var appended = [];
    var updated = 0;
    var skipped = 0;
    rows.forEach(function(row) {
      var key = String(row && row.ticket_po_id || "").trim();
      if (!key) {
        skipped += 1;
        return;
      }
      var values = headers.map(function(header) {
        return gsheetSyncSafeCell_(row[header]);
      });
      var existing = existingKeys[key];
      if (existing && existing.rowNumber > 0) {
        sheet.getRange(existing.rowNumber, 1, 1, headers.length).setValues([values]);
        updated += 1;
      } else if (existing && existing.appendIndex >= 0) {
        appended[existing.appendIndex] = values;
      } else {
        existingKeys[key] = { rowNumber: 0, appendIndex: appended.length };
        appended.push(values);
      }
    });

    if (appended.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, appended.length, headers.length).setValues(appended);
    }
    return { inserted: appended.length, updated: updated, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

function gsheetSyncEnsureHeaders_(sheet) {
  var lastColumn = sheet.getLastColumn();
  var headers = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(function(value) {
        return String(value || "").trim();
      })
    : [];
  if (!headers.some(function(value) { return Boolean(value); })) {
    headers = GSHEET_SYNC_HEADERS.slice();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return headers;
  }
  GSHEET_SYNC_HEADERS.forEach(function(header) {
    if (headers.indexOf(header) < 0) headers.push(header);
  });
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return headers;
}

function gsheetSyncSafeCell_(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" && /^[=+@]/.test(value)) return "'" + value;
  return value;
}

function gsheetSyncParseBody_(e) {
  var raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
  try {
    return JSON.parse(raw || "{}");
  } catch (error) {
    throw new Error("Body JSON tidak valid");
  }
}

function gsheetSyncJson_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
