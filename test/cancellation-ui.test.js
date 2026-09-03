const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const contracts = require("../js/ticket_contracts.js");
const dropoff = require("../js/dropoff_domain.js");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("cancelled ticket/PO never counts as completed or SLA miss and has a dated timeline", () => {
  const row = { status: "CANCELLED", start_unloading_at: "2026-09-01T01:00:00Z",
    cancelled_at: "2026-09-01T02:00:00Z", fleet_type: "CDD", all_done_gr: true };
  assert.equal(contracts.isDoneGrTerminal(row), false);
  const early = contracts.getInboundSlaInfo(row, new Date("2026-09-01"));
  const late = contracts.getInboundSlaInfo(row, new Date("2026-09-30"));
  assert.deepEqual(early, late);
  assert.equal(late.status, "CANCELLED");
  assert.equal(contracts.getInboundSlaInfo({ status: "UNLOADING", gr_status: "CANCELLED" }).status, "CANCELLED");
  assert.equal(contracts.driverTimelineEntries(row).at(-1).timeLabel, "01 Sep 2026, 09:00 WIB");
  assert.equal(dropoff.isTerminal(row), true);
  const summary = dropoff.summarizeDropoffs([{ ...row, ticket_type: "DROP-OFF" }]);
  assert.equal(summary.active, 0);
  assert.equal(summary.completed, 0);
});

test("partial cancellation excludes cancelled POs from completion and retains successful SLA", () => {
  const row = { status: "COMPLETED", fleet_type: "CDD", start_unloading_at: "2026-09-03T01:00:00Z",
    po_rows: [{ gr_status: "CANCELLED", po_cancelled_at: "2026-09-03T01:20:00Z" },
      { gr_status: "DONE GR", done_gr_at: "2026-09-03T02:00:00Z" }] };
  assert.equal(contracts.isCancelled(row), false);
  assert.equal(contracts.activePoRows(row).length, 1);
  assert.equal(contracts.getInboundSlaInfo(row).status, "TERCAPAI");
});

test("real row mapper/grouping carries audit fields and excludes cancelled PO quantities/progress", () => {
  const api = read("js/api_v2.js");
  const start = api.indexOf("  function mapOutputPoRowV15(");
  const end = api.indexOf("  function responseHasOutputV15", start);
  const context = {
    window: { InboundTicketContracts: contracts },
    getCell: (row, keys, fallback = "") => keys.map((key) => row[key]).find((v) => v !== undefined && v !== null) ?? fallback,
    normalizeOutputDateV7: (...args) => args.find(Boolean) || "",
    normalizePlateValue: (value) => value,
    toNumberV2: (value) => Number(value || 0),
    parseInboundDateSafe: contracts.parseDate,
  };
  vm.createContext(context);
  vm.runInContext(api.slice(start, end), context);
  const rows = [
    { ticket_id: "test", status: "WAITING GR", ticket_po_id: "a", po_number: "PO1",
      gr_status: "CANCELLED", checker_status: "CANCELLED", po_cancelled_reason: "vendor", po_cancelled_at: "2026-09-03T01:00:00Z", total_po_qty: 100, count_po_sku: 10 },
    { ticket_id: "test", status: "WAITING GR", ticket_po_id: "b", po_number: "PO2",
      gr_status: "WAITING GR", checker_status: "DONE", finish_unloading_at: "2026-09-03T01:00:00Z", total_po_qty: 20, count_po_sku: 2 },
  ];
  const ticket = context.window.buildQueueFromOutputForm(rows)[0];
  assert.equal(ticket.status, "WAITING GR");
  assert.equal(contracts.isCancelled(ticket), false);
  assert.equal(ticket.po_rows.length, 2);
  assert.equal(ticket.po_rows[0].po_cancelled_reason, "vendor");
  assert.equal(ticket.total_po_qty, 20);
  assert.equal(ticket.count_po_sku, 2);
  assert.equal(ticket.checker_progress, "1/1");
  assert.equal(ticket.gr_progress, "0/1");
  assert.equal(ticket.all_done_gr, false);
  rows.forEach((row) => { row.status = "CANCELLED"; row.cancelled_at = "2026-09-03T02:00:00Z"; });
  const cancelled = context.window.buildQueueFromOutputForm(rows)[0];
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.total_po_qty, 0);
  assert.equal(cancelled.all_done_gr, false);
});

function ui(role = "DEVELOPER") {
  const messages = [], calls = [];
  const ticket = { ticket_id: "test", queue_no: "REG 1-30", plat_number: "B1234AA",
    status: "WAITING", po_rows: [{ ticket_po_id: "p1", po_number: "PO1", gr_status: "PENDING" }] };
  const context = {
    window: { InboundTicketContracts: contracts },
    getAuthUser: () => ({ role }), esc: (value) => String(value).replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    state: { dashboard: { history_queue: [ticket] }, page: "laporan" },
    prompt: () => " Vendor cancel ", confirm: () => true,
    motherDuckApiPost: async (action, payload) => { calls.push({ action, payload }); return { rows: [] }; },
    applyBackendActionResult: () => {}, renderPage: () => {}, showToast: (m) => messages.push(m),
  };
  vm.createContext(context);
  vm.runInContext(read("js/cancellation.js"), context);
  return { context, ticket, messages, calls, button: { dataset: { cancelTicket: "test", cancelPo: "" }, disabled: false } };
}
test("cancel UI uses explicit IDs, requires reason/confirmation, honors roles and waits for server", async () => {
  const { context, ticket, calls, button } = ui();
  assert.match(context.window.cancelActionMarkup(ticket), /Batalkan Tiket/);
  assert.match(context.window.cancelActionMarkup(ticket, ticket.po_rows[0]), /Batalkan PO/);
  context.prompt = () => "";
  await context.window.cancelInboundItem(button);
  assert.equal(calls.length, 0);
  context.prompt = () => "reason";
  context.confirm = () => false;
  await context.window.cancelInboundItem(button);
  assert.equal(calls.length, 0);
  context.confirm = () => true;
  await context.window.cancelInboundItem(button);
  assert.equal(calls[0].action, "cancel_ticket");
  assert.equal(calls[0].payload.ticket_id, "test");
  assert.equal(ticket.status, "WAITING"); // never invent cancellation before server confirms
  button.dataset.cancelPo = "p1";
  await context.window.cancelInboundItem(button);
  assert.equal(calls[1].action, "cancel_po");
  assert.equal(calls[1].payload.ticket_po_id, "p1");
  const commercial = ui("COMERCIAL");
  assert.equal(commercial.context.window.cancelActionMarkup(ticket), "");
  await commercial.context.window.cancelInboundItem(commercial.button);
  assert.equal(commercial.calls.length, 0);
  ticket.po_rows[0].gr_status = "DONE GR";
  assert.equal(context.window.cancelActionMarkup(ticket), "");
});
test("API permits cancellation only to operational approvers and exposes dedicated RPC", () => {
  const api = read("supabase/functions/inbound-api/index.ts");
  const src = api.slice(api.indexOf("function canUseAction"), api.indexOf("async function bodyOf"))
    .replace("session: Session | null, action: string", "session, action").replace("): boolean", ")");
  const context = {};
  vm.createContext(context);
  vm.runInContext(src, context);
  for (const role of ["SPV", "ADMIN", "DEVELOPER"]) assert.equal(context.canUseAction({ role }, "cancel_po"), true);
  for (const role of ["COMERCIAL", "SECURITY", "CHECKER"]) assert.equal(context.canUseAction({ role }, "cancel_ticket"), false);
  assert.match(api, /rpc\("inbound_cancel"/);
});
