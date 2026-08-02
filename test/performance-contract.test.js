const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const frontendSource = fs.readFileSync(
  path.join(__dirname, "..", "js", "api_v2.js"),
  "utf8",
);
const backendSource = fs.readFileSync(
  path.join(__dirname, "..", "api", "inbound.js"),
  "utf8",
);

function extractFunction(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start);
  assert.ok(start >= 0 && end > start, `${signature} must be present`);
  return source.slice(start, end);
}

test("security multi-ticket submit uses one bulk HTTP request", async () => {
  const functionSource = extractFunction(
    frontendSource,
    "async function submitSecurityRowsToBackend",
    "\nfunction getTicketWaFeedbackV171",
  );
  const calls = [];
  const context = {
    Map,
    String,
    motherDuckApiPost: async (action, payload) => {
      calls.push({ action, payload });
      return {
        created: payload.tickets.map((item) => ({
          ticket_id: item.ticket.ticket_id,
          queue_no: item.ticket.queue_no,
          operational_date: "2026-08-02",
        })),
      };
    },
  };
  vm.runInNewContext(
    `${functionSource}; globalThis.__submit = submitSecurityRowsToBackend;`,
    context,
  );
  const rows = Array.from({ length: 6 }, (_, index) => ({
    ticket_id: `T-${index + 1}`,
    queue_no: `REG 1-${index + 1}`,
    po_number: `PO-${index + 1}`,
  }));

  const result = await context.__submit(rows);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "create_tickets_bulk");
  assert.equal(calls[0].payload.tickets.length, 6);
  assert.equal(result.rows.length, 6);
});

test("auto sync polls no faster than every ten seconds", () => {
  const interval = Number(
    frontendSource.match(/const INTERVAL_MS = (\d+);/)?.[1],
  );
  assert.ok(interval >= 10_000, `poll interval was ${interval}ms`);
  assert.match(frontendSource, /document\.visibilityState === "hidden"/);
  assert.match(frontendSource, /const FULL_REFRESH_MS = 5 \* 60 \* 1000;/);
});

test("backend exposes authorized transactional bulk ticket creation", () => {
  assert.match(backendSource, /"create_tickets_bulk"/);
  assert.match(
    backendSource,
    /async function createTicketsBulk[\s\S]*client\.query\("BEGIN"\)[\s\S]*client\.query\("COMMIT"\)[\s\S]*client\.query\("ROLLBACK"\)/,
  );
  assert.match(
    backendSource,
    /req\.method === "POST" && action === "create_tickets_bulk"/,
  );
});

test("delta merge updates changed rows and removes deleted tickets", () => {
  const functionSource = extractFunction(
    frontendSource,
    "function outputRowKeyV12",
    "\nasync function fetchV2Data",
  );
  const context = { String, Set, Map, Array };
  vm.runInNewContext(
    `${functionSource}; globalThis.__merge = mergeOutputDeltaV12;`,
    context,
  );
  const current = [
    { ticket_id: "T-1", ticket_po_id: "P-1", status: "WAITING" },
    { ticket_id: "T-2", ticket_po_id: "P-2", status: "WAITING" },
  ];
  const delta = [
    { ticket_id: "T-1", ticket_po_id: "P-1", status: "UNLOADING" },
    { ticket_id: "T-3", ticket_po_id: "P-3", status: "WAITING" },
  ];

  const merged = context.__merge(current, delta, ["T-1", "T-3"]);

  assert.deepEqual(
    JSON.parse(JSON.stringify(merged)),
    [
      { ticket_id: "T-1", ticket_po_id: "P-1", status: "UNLOADING" },
      { ticket_id: "T-3", ticket_po_id: "P-3", status: "WAITING" },
    ],
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__merge(current, [], []))),
    [],
  );
});

test("backend delta endpoint is authenticated and accepts a cursor", () => {
  assert.match(backendSource, /"state_delta"/);
  assert.match(backendSource, /async function getAppStateDelta/);
  assert.match(
    backendSource,
    /req\.method === "GET" && action === "state_delta"/,
  );
});

test("bulk backend keeps queue sequences independent per slot", async () => {
  const { createTicketsBulk } = require("../api/inbound.js")._test;
  const tickets = [];
  const transactionLog = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        transactionLog.push(normalized);
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT DISTINCT po_number FROM superset_po_master")) {
        return { rows: params.map((po_number) => ({ po_number })), rowCount: params.length };
      }
      if (normalized.startsWith("SELECT queue_no FROM tickets")) {
        return {
          rows: tickets.filter((ticket) => ticket.slot === params[0]).map((ticket) => ({ queue_no: ticket.queue_no })),
          rowCount: tickets.length,
        };
      }
      if (normalized.startsWith("INSERT INTO tickets")) {
        tickets.push({ ticket_id: params[0], queue_no: params[1], slot: params[10] });
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO ticket_pos") || normalized.startsWith("INSERT INTO ticket_events")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${normalized}`);
    },
  };
  const body = {
    tickets: [
      { ticket: { ticket_id: "T-1", ticket_type: "REG", slot: "1" }, pos: [{ po_number: "PO-1" }] },
      { ticket: { ticket_id: "T-2", ticket_type: "REG", slot: "1" }, pos: [{ po_number: "PO-2" }] },
      { ticket: { ticket_id: "T-3", ticket_type: "REG", slot: "2" }, pos: [{ po_number: "PO-3" }] },
    ],
  };

  const result = await createTicketsBulk(client, body);

  assert.deepEqual(result.created.map((ticket) => ticket.queue_no), ["REG 1-1", "REG 1-2", "REG 2-1"]);
  assert.deepEqual(transactionLog, ["BEGIN", "COMMIT"]);
});

test("schema initialization is cached after the first request", async () => {
  const hooks = require("../api/inbound.js")._test;
  assert.equal(typeof hooks.ensureDatabaseReady, "function");
  hooks.resetSchemaCacheForTests();

  function fakeClient() {
    const queries = [];
    return {
      queries,
      async query(sql) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        queries.push(normalized);
        if (normalized.includes("COUNT(*)::int AS count FROM product_master")) {
          return { rows: [{ count: 1 }], rowCount: 1 };
        }
        if (normalized.includes("COUNT(*) AS count FROM checker_master")) {
          return { rows: [{ count: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  }

  const first = fakeClient();
  const second = fakeClient();
  await hooks.ensureDatabaseReady(first);
  await hooks.ensureDatabaseReady(second);

  assert.ok(first.queries.length > 20, "first request should initialize the schema");
  assert.deepEqual(second.queries, ["USE inbound_cbt_app"]);
});
