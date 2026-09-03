const test = require("node:test");
const assert = require("node:assert/strict");

const contracts = require("../js/ticket_contracts.js");

test("fleet master exposes the new labels while preserving legacy aliases", () => {
  assert.deepEqual(contracts.FLEET_TYPES, [
    "KR2",
    "MINI BUS/MOBIL",
    "BLIND VAN",
    "PICKUP/L300",
    "CDE",
    "CDEL",
    "CDD",
    "CDDL",
    "TRONTON/FUSO",
    "WINGBOX",
  ]);
  assert.equal(contracts.normalizeFleetType("RODA 2"), "KR2");
  assert.equal(contracts.normalizeFleetType("MOBIL"), "MINI BUS/MOBIL");
  assert.equal(contracts.normalizeFleetType("VAN"), "BLIND VAN");
  assert.equal(contracts.normalizeFleetType("L300 BOX"), "PICKUP/L300");
  assert.equal(contracts.normalizeFleetType("DROP-OFF"), "DROP-OFF");
  assert.equal(contracts.FLEET_TYPES.includes("DROP-OFF"), false);
  assert.equal(contracts.fleetSlaRuleText("KR2"), "SLA 1 jam");
  assert.equal(contracts.fleetSlaRuleText("Blind Van"), "SLA 2 jam");
});

test("manual PO metrics and TKBM quantities reject incomplete input", () => {
  assert.deepEqual(contracts.validateManualPoMetrics("1200", "18"), {
    valid: true,
    totalQty: 1200,
    totalSku: 18,
  });
  assert.equal(contracts.validateManualPoMetrics("0", "18").valid, false);
  assert.equal(contracts.validateManualPoMetrics("1200", "1.5").valid, false);
});

test("TKBM is a direct nonnegative integer count, including zero", () => {
  for (const value of [0, "0", 3, "3", "12"]) {
    assert.deepEqual(contracts.normalizeTkbm(value), { valid: true, count: Number(value) });
  }
  for (const value of ["", " ", null, undefined, false, -1, "-1", "1.5", "abc", Infinity, 2147483648]) {
    assert.deepEqual(contracts.normalizeTkbm(value), { valid: false, count: 0 });
  }
});

test("vehicle form always exposes the TKBM count without a yes/no switch", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  const input = app.match(/<input data-vehicle-field="tkbm_count"[^>]+>/)?.[0];
  assert.ok(input);
  assert.match(input, /type="number" min="0"/);
  assert.match(input, /step="1"/);
  assert.match(input, /required/);
  assert.doesNotMatch(input, /disabled/);
  assert.doesNotMatch(app, /has_tkbm|toggleVehicleTkbm|data-tkbm-count-wrap/);
  assert.match(app, /tkbm_count: tkbmResult.count/);
});

test("vehicle collection preserves each vehicle's own TKBM count", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const app = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  const source = app.slice(app.indexOf("function collectVehicleRows()"), app.indexOf("function syncVehicleMultiInput()"));
  const rows = ["0", "3", "12", ""].map((count, index) => ({
    querySelector(selector) {
      const fields = { fleet_type: "CDD", tkbm_count: count, driver_name: `Driver ${index}` };
      const field = selector.match(/data-vehicle-field="([^"]+)"/)?.[1];
      return { value: fields[field] ?? "" };
    },
  }));
  const context = {
    document: { querySelectorAll: () => rows },
    window: { InboundTicketContracts: contracts },
    normalizeFleetType: contracts.normalizeFleetType,
    buildPlateFromParts: () => "",
    parseMultiValues: () => [],
  };
  vm.createContext(context);
  const result = vm.runInContext(`${source}; collectVehicleRows()`, context);
  assert.deepEqual(Array.from(result, (row) => row.tkbm_count), [0, 3, 12, 0]);
  assert.deepEqual(Array.from(result, (row) => row.tkbm_valid), [true, true, true, false]);
});

test("SLA and target date use the unloading timestamp and WIB month correctly", () => {
  const row = {
    status: "WAITING GR",
    fleet_type: "CDD",
    count_po_sku: 20,
    po_rows: [{ start_unloading_at: "2026-09-01T03:35:15.000Z" }],
  };
  const sla = contracts.getInboundSlaInfo(row, new Date("2026-09-01T04:00:15.000Z"));
  assert.equal(sla.status, "ON PROCESS");
  assert.equal(sla.target_hours, 2);
  assert.equal(sla.target_at.toISOString(), "2026-09-01T05:35:15.000Z");
  assert.equal(contracts.formatWibDateTime(sla.target_at), "01 Sep 2026, 12:35 WIB");
  assert.notEqual(sla.label, "Belum mulai");
});

test("DONE GR freezes elapsed time and SLA at the GR completion timestamp", () => {
  const row = {
    status: "UNLOADING",
    fleet_type: "CDD",
    count_po_sku: 20,
    start_unloading_at: "2026-09-01T01:00:00.000Z",
    ticket_all_done_gr: true,
    ticket_done_gr_at: "2026-09-01T02:30:00.000Z",
  };
  const sla = contracts.getInboundSlaInfo(
    row,
    new Date("2026-09-02T12:00:00.000Z"),
  );

  assert.equal(sla.status, "TERCAPAI");
  assert.equal(sla.actual_minutes, 90);
  assert.equal(sla.done_at.toISOString(), "2026-09-01T02:30:00.000Z");
});

test("COMPLETED rows remain terminal when aggregate DONE GR flags are absent", () => {
  const row = {
    status: "COMPLETED",
    fleet_type: "CDD",
    count_po_sku: 20,
    start_unloading_at: "2026-09-01T01:00:00.000Z",
    completed_at: "2026-09-01T02:30:00.000Z",
  };
  const sla = contracts.getInboundSlaInfo(
    row,
    new Date("2026-09-02T12:00:00.000Z"),
  );

  assert.equal(contracts.isDoneGrTerminal(row), true);
  assert.equal(sla.actual_minutes, 90);
  assert.equal(sla.done_at.toISOString(), "2026-09-01T02:30:00.000Z");
});

test("driver timeline exposes an actual timestamp for every reached status", () => {
  const timeline = contracts.driverTimelineEntries({
    status: "COMPLETED",
    created_at: "2026-09-01T01:00:00.000Z",
    called_at: "2026-09-01T01:15:00.000Z",
    start_unloading_at: "2026-09-01T02:00:00.000Z",
    done_gr_at: "2026-09-01T04:30:00.000Z",
    checker_progress: "2/2",
    gr_progress: "2/2",
  });
  assert.deepEqual(
    timeline.map((entry) => entry.label),
    ["Registrasi", "Dipanggil ke Gate", "Unloading & Checking 2/2", "Done GR 2/2"],
  );
  assert.deepEqual(
    timeline.map((entry) => entry.timeLabel),
    [
      "01 Sep 2026, 08:00 WIB",
      "01 Sep 2026, 08:15 WIB",
      "01 Sep 2026, 09:00 WIB",
      "01 Sep 2026, 11:30 WIB",
    ],
  );
});

test("operational UI has no Handover GRN stage or action", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");

  assert.doesNotMatch(app, />Handover GRN<\/button>/);
  assert.doesNotMatch(app, /Handover Surat Jalan/);
  assert.doesNotMatch(app, /siap Handover GRN/);
  assert.match(app, /\["COMPLETED", "DONE GR"\]\.includes\(status\)/);
});

test("database closes the ticket automatically when its final PO reaches DONE GR", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const migrationPath = path.join(
    __dirname,
    "..",
    "supabase",
    "migrations",
    "20260901020000_done_gr_terminal.sql",
  );

  assert.equal(fs.existsSync(migrationPath), true);
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /add column if not exists completed_at timestamptz/i);
  assert.match(sql, /after update of gr_status on public\.ticket_pos/i);
  assert.match(sql, /upper\(coalesce\(gr_status, ''\)\) <> 'DONE GR'/i);
  assert.match(sql, /update public\.tickets[\s\S]*status = 'COMPLETED'/i);
  assert.match(sql, /completed_at = coalesce\(completed_at, new\.gr_done_at, now\(\)\)/i);
});
