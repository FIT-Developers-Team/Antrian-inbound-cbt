const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const db = new PGlite();
const actor = { role: "DEVELOPER", name: "Test operator" };
const read = (name) => fs.readFileSync(path.join(__dirname, "../supabase/migrations", name), "utf8");
before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role;");
  // Local Postgres engine: omit network/scheduler extensions, keep production tables/functions/triggers.
  await db.exec(read("20260824010000_inbound_core.sql").replace(/^create extension .*;\r?$/gm, ""));
  for (const name of [
    "20260824011000_inbound_admin_and_ba.sql",
    "20260901010000_inbound_vehicle_details.sql",
    "20260901020000_done_gr_terminal.sql",
    "20260901023000_done_gr_completed_timestamp.sql",
    "20260903010000_ticket_cancellation.sql",
  ]) await db.exec(read(name));
});
after(() => db.close());
async function seed(id, count = 1) {
  await db.query("insert into tickets(ticket_id,queue_no,operational_date) values($1,$1,'2026-09-03')", [id]);
  for (let n = 1; n <= count; n++) {
    await db.query("insert into ticket_pos(ticket_po_id,ticket_id,po_number,request_quantity) values($1,$2,$1,10)", [id + "-po" + n, id]);
  }
}
async function cancel(id, po, reason = "PO dibatalkan vendor", by = actor) {
  return (await db.query("select inbound_cancel($1::jsonb,$2::jsonb) result", [
    JSON.stringify({ ticket_id: id, ticket_po_id: po, reason }), JSON.stringify(by),
  ])).rows[0].result;
}
async function ticket(id) {
  return (await db.query("select * from tickets where ticket_id=$1", [id])).rows[0];
}
async function action(id, name, po, extra = {}) {
  return db.query("select inbound_update_ticket_pos($1,$2::jsonb,$3::jsonb)", [
    name, JSON.stringify({ ticket_id: id, ticket_po_id: po, ...extra }), JSON.stringify(actor),
  ]);
}
test("cancel ticket preserves history, stops timer, frees gate, never creates completed/GR timestamp", async () => {
  await seed("cancel-all", 2);
  await db.query("insert into gates(gate_name,status,ticket_id) values('TEST GATE','CALLED','cancel-all')");
  const result = await cancel("cancel-all");
  const t = await ticket("cancel-all");
  assert.equal(t.status, "CANCELLED");
  assert.ok(t.cancelled_at);
  assert.equal(t.completed_at, null);
  assert.equal(t.cancelled_reason, "PO dibatalkan vendor");
  assert.equal(t.cancelled_by, actor.name);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((row) => row.gr_status === "CANCELLED" && row.done_gr_at === null && row.po_cancelled_at));
  assert.equal((await db.query("select ticket_id from gates where gate_name='TEST GATE'")).rows[0].ticket_id, null);
  await cancel("cancel-all");
  assert.equal((await db.query("select count(*)::int n from ticket_events where ticket_id='cancel-all' and event_type='TICKET_CANCELLED'")).rows[0].n, 1);
});
test("partial cancel keeps another PO active; remaining checking and GR can finish", async () => {
  await seed("partial", 2);
  await cancel("partial", "partial-po1");
  assert.equal((await ticket("partial")).status, "WAITING");
  await action("partial", "startcheckerpo", "partial-po2", { checker_id: "test", checker_name: "test" });
  await action("partial", "donecheckerpo", "partial-po2");
  assert.equal((await ticket("partial")).status, "WAITING GR");
  await action("partial", "donegrpo", "partial-po2", { actual_quantity: 10 });
  assert.equal((await ticket("partial")).status, "COMPLETED");
  const pos = (await db.query("select gr_status from ticket_pos where ticket_id='partial' order by ticket_po_id")).rows;
  assert.deepEqual(pos.map((p) => p.gr_status), ["CANCELLED", "DONE GR"]);
});
test("cancelling last unresolved PO completes only remaining successful work; all-cancel never completes", async () => {
  await seed("last", 2);
  await action("last", "donegrpo", "last-po1", { actual_quantity: 10 });
  await cancel("last", "last-po2");
  assert.equal((await ticket("last")).status, "COMPLETED");
  await seed("all-po", 2);
  await cancel("all-po", "all-po-po1");
  await cancel("all-po", "all-po-po2");
  assert.equal((await ticket("all-po")).status, "CANCELLED");
});
test("role, reason, wrong-ticket PO, terminal ticket and DONE GR protections are enforced in database", async () => {
  await seed("guard", 2);
  await assert.rejects(cancel("guard", null, "  "), /alasan/);
  await assert.rejects(cancel("guard", null, "x".repeat(501)), /alasan/);
  await assert.rejects(cancel("guard", null, "cancel", { role: "COMERCIAL" }), /Akses/);
  await assert.rejects(cancel("guard", "partial-po2"), /PO tidak ditemukan/);
  await action("guard", "donegrpo", "guard-po1", { actual_quantity: 10 });
  await assert.rejects(cancel("guard", "guard-po1"), /Done GR/);
  await assert.rejects(cancel("guard"), /Done GR/);
  await assert.rejects(cancel("partial"), /terminal/);
  assert.equal((await ticket("guard")).status, "WAITING");
  assert.equal((await db.query("select has_function_privilege('anon','inbound_cancel(jsonb,jsonb)','execute') ok")).rows[0].ok, false);
});
test("stale mutation paths cannot restart cancelled ticket or process a cancelled PO", async () => {
  await assert.rejects(action("cancel-all", "updatechecker", null, { status: "CALLED" }), /dibatalkan/);
  await assert.rejects(db.query("select inbound_update_ticket_status($1::jsonb,$2::jsonb)", [
    JSON.stringify({ ticket_id: "cancel-all", status: "COMPLETED" }), JSON.stringify(actor),
  ]), /dibatalkan/);
  await assert.rejects(action("partial", "donegrpo", "partial-po1"), /dibatalkan/);
  await assert.rejects(db.query("update ticket_pos set gr_status='DONE GR' where ticket_po_id='partial-po1'"), /dibatalkan/);
});
test("Clear Task skips cancelled tickets and cancelled POs", async () => {
  await seed("clear", 2);
  await cancel("clear", "clear-po1");
  await db.query("select inbound_bulk_complete_operational($1::jsonb,$2::jsonb)", [
    JSON.stringify({ operational_date: "2026-09-03" }), JSON.stringify(actor),
  ]);
  assert.equal((await ticket("cancel-all")).status, "CANCELLED");
  assert.equal((await ticket("all-po")).status, "CANCELLED");
  assert.equal((await ticket("clear")).status, "COMPLETED");
  assert.equal((await db.query("select gr_status from ticket_pos where ticket_po_id='clear-po1'")).rows[0].gr_status, "CANCELLED");
});
