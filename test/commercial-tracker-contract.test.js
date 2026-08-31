const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const commercialSection = (source) => source.slice(
  source.indexOf("V23 — COMERCIAL"),
  source.indexOf("/* V19 — bulk Actual Qty", source.indexOf("V23 — COMERCIAL")),
);

test("COMERCIAL has desktop and mobile navigation with a dedicated read-only role", () => {
  const html = read("index.html");
  const app = read("js/app.js");

  assert.equal((html.match(/data-page="commercial"/g) || []).length, 2);
  assert.match(app, /ROLE_ACCESS\.COMERCIAL\s*=\s*\["commercial"\]/);
  assert.match(app, /ROLE_DEFAULT_PAGE\.COMERCIAL\s*=\s*"commercial"/);
  assert.match(app, /COMERCIAL Ticket Tracker/);
  assert.doesNotMatch(
    commercialSection(app),
    /phone_number|ktp_6_digit|updateCheckerToBackend|advanceDropoffTicket/,
  );
});

test("COMERCIAL reuses the QR driver dataset and tracking helpers", () => {
  const app = read("js/app.js");
  const section = commercialSection(app);

  assert.match(section, /state\.dashboard\?\.queue/);
  assert.match(section, /getInboundSlaInfo\(row\)/);
  assert.match(section, /getUnloadingEstimateInfo\(row\)/);
  assert.match(section, /makeDriverTrackUrl\(row\)/);
  assert.match(section, /checker_progress/);
  assert.match(section, /gr_progress/);
  assert.match(section, /po_rows/);
  assert.match(section, /id="commercial-date-filter" type="date"/);
  assert.match(section, /operationalDateOf\(row\) !== view\.date/);
  assert.match(section, /timeZone: "Asia\/Jakarta"/);
});

test("Supabase grants COMERCIAL only read actions", () => {
  const source = read("supabase/functions/inbound-api/index.ts");
  const readBlock = source.match(
    /if \(\["state", "state_delta", "realtime_config", "tickets", "export_rows"\][\s\S]*?\n  }/,
  );
  const writeBlock = source.match(
    /if \(\["create_ticket", "create_tickets_bulk"\][\s\S]*?\n  }/,
  );

  assert.ok(readBlock, "read authorization block must exist");
  assert.ok(writeBlock, "write authorization block must exist");
  assert.match(readBlock[0], /"COMERCIAL"/);
  assert.doesNotMatch(writeBlock[0], /"COMERCIAL"/);
});
