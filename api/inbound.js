const { Pool } = require("pg");
const { randomUUID, createHash, createHmac, timingSafeEqual } = require("crypto");

let pool;

function json(res, status, body) {
  res.status(status).json(body);
}

function getPool() {
  if (pool) return pool;

  const host = clean(process.env.MOTHERDUCK_POSTGRES_HOST);
  if (host) {
    const token = process.env.MOTHERDUCK_TOKEN;
    if (!token) throw new Error("MOTHERDUCK_TOKEN belum diset di Vercel.");
    pool = new Pool({
      host,
      port: 5432,
      user: "postgres",
      password: token,
      database: "md:",
      max: 5,
      ssl: { rejectUnauthorized: true },
    });
    return pool;
  }

  const configuredValue = process.env.MOTHERDUCK_POSTGRES_URL;
  if (!configuredValue) {
    throw new Error("MOTHERDUCK_POSTGRES_URL belum diset di Vercel.");
  }

  // The MotherDuck UI may display a full `psql` command. Accept that paste
  // format too, while only passing the actual PostgreSQL URL to node-postgres.
  const urlMatch = configuredValue.match(/postgres(?:ql)?:\/\/[^\s'"`]+/i);
  const connectionString = urlMatch ? urlMatch[0] : configuredValue.trim();

  // MotherDuck's copyable Postgres URL can include libpq SSL options such as
  // `sslrootcert=system`. The Node `pg` parser treats that value as a local
  // filename, which does not exist in a Vercel Function. TLS is configured
  // explicitly below instead.
  const parsedUrl = new URL(connectionString);
  ["sslmode", "sslcert", "sslkey", "sslrootcert"].forEach((key) => {
    parsedUrl.searchParams.delete(key);
  });

  pool = new Pool({
    connectionString: parsedUrl.toString(),
    max: 5,
    ssl: { rejectUnauthorized: true },
  });
  return pool;
}

function isAuthorized(req) {
  const expected = process.env.INBOUND_API_KEY;
  const supplied = req.headers["x-inbound-api-key"];
  return Boolean(expected && supplied && supplied === expected);
}

function cookieValue(req, name) {
  const prefix = `${name}=`;
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length) || "";
}

function authSecret() {
  const secret = clean(process.env.INBOUND_AUTH_SECRET);
  if (!secret) throw new Error("INBOUND_AUTH_SECRET belum diset di Vercel.");
  return secret;
}

function configuredUsers() {
  try {
    const users = JSON.parse(clean(process.env.INBOUND_AUTH_USERS || "[]"));
    return Array.isArray(users) ? users : [];
  } catch {
    throw new Error("INBOUND_AUTH_USERS harus berformat JSON array.");
  }
}

function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", authSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readSession(req) {
  const token = cookieValue(req, "inbound_session");
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = createHmac("sha256", authSecret()).update(encoded).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const session = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return Number(session.exp) > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function setSessionCookie(res, session) {
  res.setHeader(
    "Set-Cookie",
    `inbound_session=${signSession(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "inbound_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
}

function canUseAction(session, action) {
  if (!session) return false;
  const role = clean(session.role).toUpperCase();
  if (["state", "tickets", "create_ticket"].includes(action)) return ["SECURITY", "CHECKER", "SPV", "ADMIN", "DEVELOPER"].includes(role);
  if (["updatechecker", "startcheckerpo", "donecheckerpo", "donegrpo", "handovergrn", "failcall", "update_ticket_status"].includes(action)) return ["CHECKER", "SPV", "ADMIN", "DEVELOPER"].includes(role);
  return false;
}

function authenticateUser(body) {
  const username = clean(body.username).toLowerCase();
  const password = String(body.password || "");
  const user = configuredUsers().find((candidate) =>
    clean(candidate.username).toLowerCase() === username && String(candidate.password || "") === password,
  );
  if (!user) return null;
  return {
    username: clean(user.username),
    role: clean(user.role).toUpperCase(),
    display_name: clean(user.display_name) || clean(user.username),
    exp: Date.now() + 12 * 60 * 60 * 1000,
  };
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

// Hari operasional inbound dimulai 04:00 WIB (UTC+7), bukan tengah malam.
function operationalWindowWib(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (Number(parts.hour) < 4) localDate.setUTCDate(localDate.getUTCDate() - 1);
  const key = localDate.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(), -3));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { key, start, end };
}

function normalizeTicketType(value) {
  const type = clean(value || "REG").toUpperCase().replace(/\s+/g, "-");
  return type === "DROP" ? "DROP-OFF" : type;
}

const CHECKER_SEED = [
  ["MP-001", "pandu"], ["MP-002", "adit"], ["MP-003", "prety"],
  ["46916", "Ali Fahrudin"], ["46917", "Dian Ramdani"], ["46918", "SAMLAWI"],
  ["42892", "Mohamad Nursalim"], ["9339", "A.reza faisal"], ["42889", "Abdul Wahid Rohman"],
  ["48378", "Agim"], ["48371", "Agil"], ["49612", "Mulyadi"],
  ["46117", "Septian Dinariyanto"], ["51839", "Sendi arya ramadhani"],
  ["68843", "Alfian Dwi Prasetyo"], ["68844", "Syamsul Bahri"], ["69330", "Dede Rinaldo"],
  ["70111", "Sabila rifqa aprilian"], ["73398", "Bayu prastio"],
  ["75048", "Muhammad fauzan pradita nurramadhan"], ["75050", "Dedi hidayat"],
  ["75049", "MUHAMAD ANSOR FAUJI"], ["75796", "Abd wahab"],
  ["70725", "M RIZKI HIDAYATULLAH"], ["70730", "Antonius albert Gea"],
  ["76925", "Khoirul imam alfad"], ["77465", "Septian Esa Putra"],
  ["77474", "MUHAMMAD WAHYU JOYO NUGROHO"], ["77473", "Yoga Irawan"],
  ["77587", "Muhammad Luthfi Alfian Zauhari"], ["77612", "yoga jatnika"],
  ["77900", "M.Rizky.Ardiansyah"], ["77911", "Ganang akhtas saputra"],
  ["77912", "Devrizal Oktavian"], ["77915", "Alung Ramadhan"],
  ["77916", "Dimas Wibisono prasetyo"], ["78018", "Randi Wira Sakti"],
  ["78039", "Junaedi Abdullah paqih"], ["78042", "Aditya Yusuf"],
  ["78044", "Ibrohim"], ["78060", "Tulus Rachmawan Adiar"],
  ["78155", "Aldi putra kurniawan"], ["78386", "RAFA RIZKI RAMADHAN"],
];

function databaseName() {
  const name = clean(process.env.MOTHERDUCK_DATABASE || "inbound_cbt_app");
  if (!/^[a-z][a-z0-9_]*$/i.test(name)) {
    throw new Error("MOTHERDUCK_DATABASE hanya boleh berisi huruf, angka, dan underscore.");
  }
  return name;
}

async function ensureSchema(client) {
  const db = databaseName();
  await client.query(`CREATE DATABASE IF NOT EXISTS ${db}`);
  await client.query(`USE ${db}`);
  await client.query(`CREATE TABLE IF NOT EXISTS tickets (
    ticket_id VARCHAR PRIMARY KEY, queue_no VARCHAR NOT NULL,
    ticket_type VARCHAR NOT NULL DEFAULT 'REG', status VARCHAR NOT NULL DEFAULT 'WAITING',
    vendor_name VARCHAR, fleet_type VARCHAR, plat_number VARCHAR, driver_name VARCHAR,
    driver_phone VARCHAR, gate VARCHAR, slot VARCHAR, operational_date VARCHAR, registered_by VARCHAR,
    called_at TIMESTAMP, arrived_at TIMESTAMP, start_unloading_at TIMESTAMP,
    done_unloading_at TIMESTAMP, expired_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ticket_pos (
    ticket_po_id VARCHAR PRIMARY KEY, ticket_id VARCHAR NOT NULL, po_number VARCHAR NOT NULL,
    vendor_name VARCHAR, request_quantity DOUBLE DEFAULT 0, actual_quantity DOUBLE DEFAULT 0,
    count_sku INTEGER DEFAULT 0, checker_status VARCHAR DEFAULT 'PENDING',
    checking_started_at TIMESTAMP, checking_done_at TIMESTAMP, gr_done_at TIMESTAMP,
    handover_grn_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ticket_events (
    event_id VARCHAR PRIMARY KEY, ticket_id VARCHAR NOT NULL, event_type VARCHAR NOT NULL,
    actor_role VARCHAR, actor_name VARCHAR, payload_json VARCHAR,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS gates (
    gate_name VARCHAR PRIMARY KEY, status VARCHAR NOT NULL DEFAULT 'KOSONG',
    ticket_id VARCHAR, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS checker_master (
    mp_id VARCHAR PRIMARY KEY, checker_name VARCHAR NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS call_count INTEGER DEFAULT 0`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_call_at TIMESTAMP`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS expired_reason VARCHAR`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS operational_date VARCHAR`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS gr_status VARCHAR DEFAULT 'PENDING'`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS checker_id VARCHAR`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS checker_name VARCHAR`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS checker_started_at TIMESTAMP`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS checker_done_at TIMESTAMP`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS done_gr_at TIMESTAMP`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS handover_grn_at TIMESTAMP`);
  await client.query(`CREATE TABLE IF NOT EXISTS superset_po_master (
    source_row_key VARCHAR PRIMARY KEY,
    po_number VARCHAR NOT NULL,
    vendor_name VARCHAR,
    location_id VARCHAR,
    location_name VARCHAR,
    request_shipping_date VARCHAR,
    fulfillment_arrived_start_at VARCHAR,
    schedule_type VARCHAR,
    po_status VARCHAR,
    fulfillment_receiving_start_at VARCHAR,
    fulfillment_completed_at VARCHAR,
    request_quantity DOUBLE DEFAULT 0,
    actual_quantity DOUBLE DEFAULT 0,
    count_sku BIGINT DEFAULT 0,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  const checkerCount = await client.query(`SELECT COUNT(*) AS count FROM checker_master`);
  if (Number(checkerCount.rows[0]?.count || 0) === 0) {
    const values = CHECKER_SEED.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2}, TRUE)`).join(", ");
    await client.query(
      `INSERT INTO checker_master (mp_id, checker_name, active) VALUES ${values}`,
      CHECKER_SEED.flat(),
    );
  }
}

function supersetConfig() {
  const rawCookie = clean(process.env.SUPERSET_SESSION_COOKIE);
  if (!rawCookie) {
    throw new Error("SUPERSET_SESSION_COOKIE belum diset di Vercel.");
  }
  return {
    baseUrl: clean(process.env.SUPERSET_BASE_URL || "https://dash.astronauts.id").replace(/\/$/, ""),
    cookie: rawCookie.startsWith("session=") ? rawCookie : `session=${rawCookie}`,
  };
}

function supersetChartRequest() {
  const metrics = [
    { aggregate: "SUM", column: { column_name: "request_quantity" }, expressionType: "SIMPLE", label: "SUM(request_quantity)" },
    { aggregate: "SUM", column: { column_name: "actual_quantity" }, expressionType: "SIMPLE", label: "SUM(actual_quantity)" },
    { aggregate: "COUNT_DISTINCT", column: { column_name: "sku_number" }, expressionType: "SIMPLE", label: "COUNT_DISTINCT(sku_number)" },
  ];
  const columns = [
    { timeGrain: "PT1M", columnType: "BASE_AXIS", sqlExpression: "request_shipping_date", label: "request_shipping_date", expressionType: "SQL" },
    "location_id", "fulfillment_arrived_start_at", "schedule_type", "location_name",
    "company_name", "po_status", "po_number", "fulfillment_receiving_start_at",
    "fulfillment_completed_at",
  ];
  const filters = [
    { col: "created_at", op: "TEMPORAL_RANGE", val: "Current month" },
    { col: "location_id", op: "IN", val: ["819"] },
  ];
  return {
    datasource: { id: 160, type: "table" },
    force: true,
    queries: [{
      filters,
      extras: { time_grain_sqla: "PT1M", having: "", where: "" },
      applied_time_extras: {},
      columns,
      metrics,
      orderby: [[metrics[0], false]],
      annotation_layers: [],
      row_limit: 50000,
      series_limit: 0,
      order_desc: true,
      url_params: { datasource_id: "160", datasource_type: "table", save_action: "saveas", slice_id: "20662" },
      custom_params: {}, custom_form_data: {}, post_processing: [], time_offsets: [],
    }],
    form_data: {
      datasource: "160__table", viz_type: "table", slice_id: 20662,
      query_mode: "aggregate", groupby: columns.map((column) => typeof column === "string" ? column : column.sqlExpression),
      time_grain_sqla: "PT1M", metrics,
      adhoc_filters: [
        { clause: "WHERE", comparator: "Current month", expressionType: "SIMPLE", operator: "TEMPORAL_RANGE", subject: "created_at" },
        { clause: "WHERE", comparator: ["819"], expressionType: "SIMPLE", operator: "IN", subject: "location_id" },
      ],
      row_limit: 50000, order_desc: true, result_format: "json", result_type: "full",
    },
    result_format: "json",
    result_type: "full",
  };
}

async function fetchSupersetPoRows() {
  const { baseUrl, cookie } = supersetConfig();
  const commonHeaders = { accept: "application/json", cookie, referer: `${baseUrl}/` };
  const csrfResponse = await fetch(`${baseUrl}/api/v1/security/csrf_token/`, { headers: commonHeaders });
  if (!csrfResponse.ok) throw new Error(`Superset CSRF gagal: HTTP ${csrfResponse.status}`);
  const csrfPayload = await csrfResponse.json();
  const csrfToken = clean(csrfPayload?.result);
  if (!csrfToken) throw new Error("Superset tidak mengembalikan CSRF token.");

  const chartResponse = await fetch(
    `${baseUrl}/api/v1/chart/data?form_data=${encodeURIComponent(JSON.stringify({ slice_id: 20662 }))}`,
    {
      method: "POST",
      headers: { ...commonHeaders, "content-type": "application/json", "x-csrftoken": csrfToken },
      body: JSON.stringify(supersetChartRequest()),
    },
  );
  if (!chartResponse.ok) throw new Error(`Superset chart gagal: HTTP ${chartResponse.status}`);
  const chartPayload = await chartResponse.json();
  const data = chartPayload?.result?.[0]?.data;
  if (!Array.isArray(data)) throw new Error("Format respons Superset tidak berisi result[0].data.");
  return data;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sourceRowKey(row) {
  return createHash("sha256").update(JSON.stringify([
    row.po_number, row.location_id, row.request_shipping_date, row.fulfillment_arrived_start_at,
    row.schedule_type, row.company_name, row.po_status, row.fulfillment_receiving_start_at,
    row.fulfillment_completed_at,
  ])).digest("hex");
}

async function syncSupersetPoMaster(client) {
  const rows = await fetchSupersetPoRows();
  const fieldsPerRow = 15;
  const batchSize = 250;
  let written = 0;

  await client.query("BEGIN");
  try {
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const values = [];
      const placeholders = batch.map((row, rowIndex) => {
        const start = rowIndex * fieldsPerRow;
        values.push(
          sourceRowKey(row), clean(row.po_number), clean(row.company_name) || null,
          clean(row.location_id) || null, clean(row.location_name) || null,
          clean(row.request_shipping_date) || null, clean(row.fulfillment_arrived_start_at) || null,
          clean(row.schedule_type) || null, clean(row.po_status) || null,
          clean(row.fulfillment_receiving_start_at) || null, clean(row.fulfillment_completed_at) || null,
          asNumber(row["SUM(request_quantity)"]), asNumber(row["SUM(actual_quantity)"]),
          Math.trunc(asNumber(row["COUNT_DISTINCT(sku_number)"])), new Date().toISOString(),
        );
        return `(${Array.from({ length: fieldsPerRow }, (_, index) => `$${start + index + 1}`).join(",")})`;
      });
      await client.query(
        `INSERT INTO superset_po_master (
          source_row_key, po_number, vendor_name, location_id, location_name,
          request_shipping_date, fulfillment_arrived_start_at, schedule_type, po_status,
          fulfillment_receiving_start_at, fulfillment_completed_at, request_quantity,
          actual_quantity, count_sku, synced_at
        ) VALUES ${placeholders.join(",")}
        ON CONFLICT (source_row_key) DO UPDATE SET
          vendor_name = excluded.vendor_name, location_name = excluded.location_name,
          po_status = excluded.po_status, request_quantity = excluded.request_quantity,
          actual_quantity = excluded.actual_quantity, count_sku = excluded.count_sku,
          synced_at = excluded.synced_at`,
        values,
      );
      written += batch.length;
    }
    await client.query("COMMIT");
    return { fetched: rows.length, written };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function appendEvent(client, ticketId, eventType, actor = {}, payload = {}) {
  await client.query(
    `INSERT INTO ticket_events (
      event_id, ticket_id, event_type, actor_role, actor_name, payload_json
    ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      ticketId,
      eventType,
      clean(actor.role) || null,
      clean(actor.name) || null,
      JSON.stringify(payload),
    ],
  );
}

async function listTickets(client, status) {
  const args = [];
  const where = status ? "WHERE t.status = $1" : "";
  if (status) args.push(status);

  const { rows } = await client.query(
    `SELECT
       t.ticket_id, t.queue_no, t.ticket_type, t.status, t.vendor_name,
       t.fleet_type, t.plat_number, t.driver_name, t.driver_phone, t.gate,
       t.slot, t.operational_date, t.registered_by, t.called_at, t.arrived_at,
       t.start_unloading_at, t.done_unloading_at, t.expired_at,
       t.created_at, t.updated_at,
       COALESCE(SUM(p.request_quantity), 0) AS request_quantity,
       COALESCE(SUM(p.actual_quantity), 0) AS actual_quantity,
       COUNT(p.ticket_po_id) AS po_count
     FROM tickets t
     LEFT JOIN ticket_pos p ON p.ticket_id = t.ticket_id
     ${where}
     GROUP BY ALL
     ORDER BY t.created_at DESC`,
    args,
  );
  return rows;
}

async function listOperationalRows(client, ticketId = null) {
  const args = ticketId ? [ticketId] : [];
  const where = ticketId ? "WHERE t.ticket_id = $1" : "";
  const { rows } = await client.query(
    `SELECT
       t.ticket_id, t.queue_no, t.ticket_type, t.status, t.vendor_name,
       t.fleet_type, t.plat_number, t.driver_name, t.driver_phone AS phone_number,
       t.gate, t.slot, t.operational_date, t.registered_by, t.called_at, t.arrived_at,
       t.start_unloading_at, t.done_unloading_at AS finish_unloading_at,
       t.expired_at, t.expired_reason, t.call_count, t.last_call_at,
       t.created_at AS register_time, t.created_at, t.updated_at,
       p.ticket_po_id, p.po_number, p.vendor_name AS po_vendor_name,
       p.request_quantity AS total_po_qty, p.actual_quantity,
       p.count_sku AS count_po_sku, p.checker_status, p.gr_status,
       p.checker_id, p.checker_name, p.checking_started_at AS checker_started_at,
       p.checking_done_at AS checker_done_at, p.gr_done_at AS done_gr_at,
       p.handover_grn_at
     FROM tickets t
     LEFT JOIN ticket_pos p ON p.ticket_id = t.ticket_id
     ${where}
     ORDER BY t.created_at DESC, p.created_at ASC`,
    args,
  );
  return rows;
}

async function getAppState(client) {
  const [master, outputForm, inboundMp] = await Promise.all([
    client.query(`SELECT
       po_number, vendor_name, '3' AS slot,
       request_quantity AS total_request_quantity,
       count_sku AS "Count SKU", location_id, location_name,
       request_shipping_date, fulfillment_arrived_start_at,
       schedule_type, po_status
     FROM superset_po_master
     ORDER BY synced_at DESC, po_number ASC`),
    listOperationalRows(client),
    client.query(`SELECT mp_id, mp_id AS checker_id, checker_name
      FROM checker_master WHERE active = TRUE ORDER BY checker_name ASC`),
  ]);
  return {
    status: "success",
    timestamp: new Date().toISOString(),
    tablev2: master.rows,
    outputForm,
    inboundMp: inboundMp.rows,
  };
}

async function createTicket(client, body) {
  const ticket = body.ticket || body;
  const ticketId = clean(ticket.ticket_id) || randomUUID();
  const ticketType = normalizeTicketType(ticket.ticket_type);
  const slot = clean(ticket.slot) || "3";
  const poRows = Array.isArray(body.pos) ? body.pos : [];

  if (!poRows.length) throw new Error("Minimal satu PO wajib diisi.");

  const poNumbers = [...new Set(poRows.map((po) => clean(po.po_number)).filter(Boolean))];
  if (poNumbers.length !== poRows.length) throw new Error("po_number wajib diisi.");
  const knownPos = await client.query(
    `SELECT DISTINCT po_number FROM superset_po_master WHERE po_number IN (${poNumbers.map((_, i) => `$${i + 1}`).join(",")})`,
    poNumbers,
  );
  if (knownPos.rows.length !== poNumbers.length) {
    throw new Error("Ada PO yang tidak ditemukan di master MotherDuck.");
  }

  await client.query("BEGIN");
  try {
    const operational = operationalWindowWib();
    // Nomor queue selalu dihitung dari tiket yang dibuat pada hari operasional
    // yang sama. Client tidak menjadi sumber nomor agar tidak lompat/lanjut
    // ketika browser masih membawa state hari sebelumnya.
    const existing = await client.query(
      `SELECT queue_no FROM tickets
       WHERE slot = $1 AND created_at >= $2 AND created_at < $3`,
      [slot, operational.start, operational.end],
    );
    const maxSequence = existing.rows.reduce((max, row) => {
      const match = clean(row.queue_no).match(/-\s*(\d+)\s*$/);
      return Math.max(max, match ? Number(match[1]) : 0);
    }, 0);
    const queueNo = `${ticketType} ${slot}-${maxSequence + 1}`;

    await client.query(
      `INSERT INTO tickets (
        ticket_id, queue_no, ticket_type, status, vendor_name, fleet_type,
        plat_number, driver_name, driver_phone, gate, slot, operational_date, registered_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        ticketId, queueNo, ticketType,
        clean(ticket.status) || "WAITING", clean(ticket.vendor_name) || null,
        clean(ticket.fleet_type) || null, clean(ticket.plat_number) || null,
        clean(ticket.driver_name) || null, clean(ticket.driver_phone) || null,
        clean(ticket.gate) || null, slot, operational.key,
        clean(ticket.registered_by) || null,
      ],
    );

    for (const po of poRows) {
      const poNumber = clean(po.po_number);
      if (!poNumber) throw new Error("po_number wajib diisi.");
      await client.query(
        `INSERT INTO ticket_pos (
          ticket_po_id, ticket_id, po_number, vendor_name, request_quantity,
          actual_quantity, count_sku, checker_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          clean(po.ticket_po_id) || randomUUID(), ticketId, poNumber, clean(po.vendor_name) || clean(ticket.vendor_name) || null,
          Number(po.request_quantity || 0), Number(po.actual_quantity || 0),
          Number(po.count_sku || 0), clean(po.checker_status) || "PENDING",
        ],
      );
    }

    await appendEvent(client, ticketId, "SECURITY_REGISTERED", body.actor, {
      queue_no: queueNo,
      po_count: poRows.length,
    });
    await client.query("COMMIT");
    return { ticket_id: ticketId, queue_no: queueNo, operational_date: operational.key };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function updateTicketStatus(client, body) {
  const ticketId = clean(body.ticket_id);
  const status = clean(body.status).toUpperCase();
  if (!ticketId || !status) throw new Error("ticket_id dan status wajib diisi.");

  const timeColumn = {
    CALLED: "called_at",
    ARRIVED: "arrived_at",
    UNLOADING: "start_unloading_at",
    COMPLETED: "done_unloading_at",
    EXPIRED: "expired_at",
  }[status];

  const fields = ["status = $1", "updated_at = CURRENT_TIMESTAMP"];
  const values = [status];
  if (clean(body.gate)) {
    values.push(clean(body.gate));
    fields.push(`gate = $${values.length}`);
  }
  if (timeColumn) fields.push(`${timeColumn} = CURRENT_TIMESTAMP`);
  values.push(ticketId);

  const result = await client.query(
    `UPDATE tickets SET ${fields.join(", ")} WHERE ticket_id = $${values.length} RETURNING *`,
    values,
  );
  if (!result.rowCount) throw new Error("Ticket tidak ditemukan.");
  await appendEvent(client, ticketId, `STATUS_${status}`, body.actor, {
    gate: clean(body.gate) || null,
  });
  return result.rows[0];
}

async function updateTicketPos(client, body, action) {
  const ticketId = clean(body.ticket_id);
  const poIds = Array.isArray(body.ticket_po_ids)
    ? body.ticket_po_ids.map(clean).filter(Boolean)
    : [clean(body.ticket_po_id)].filter(Boolean);
  if (!ticketId) throw new Error("ticket_id wajib diisi.");

  await client.query("BEGIN");
  try {
    if (action === "startcheckerpo" || action === "donecheckerpo") {
      if (!poIds.length) throw new Error("ticket_po_id wajib diisi.");
      const params = [ticketId, ...poIds];
      const ids = poIds.map((_, index) => `$${index + 2}`).join(",");
      if (action === "startcheckerpo") {
        await client.query(
          `UPDATE ticket_pos SET checker_id = $${params.length + 1}, checker_name = $${params.length + 2},
             checker_status = 'CHECKING', checking_started_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE ticket_id = $1 AND ticket_po_id IN (${ids})`,
          [...params, clean(body.checker_id) || null, clean(body.checker_name) || null],
        );
        await client.query(`UPDATE tickets SET status = 'UNLOADING', start_unloading_at = COALESCE(start_unloading_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1`, [ticketId]);
      } else {
        await client.query(
          `UPDATE ticket_pos SET checker_id = $${params.length + 1}, checker_name = $${params.length + 2},
             checker_status = 'DONE', checking_done_at = CURRENT_TIMESTAMP,
             gr_status = CASE WHEN gr_status = 'DONE GR' THEN gr_status ELSE 'WAITING GR' END,
             updated_at = CURRENT_TIMESTAMP
           WHERE ticket_id = $1 AND ticket_po_id IN (${ids})`,
          [...params, clean(body.checker_id) || null, clean(body.checker_name) || null],
        );

        const autoFinish = await client.query(
          `UPDATE tickets
           SET status = 'WAITING GR', done_unloading_at = COALESCE(done_unloading_at, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE ticket_id = $1
             AND status NOT IN ('WAITING GR', 'COMPLETED', 'EXPIRED')
             AND EXISTS (SELECT 1 FROM ticket_pos WHERE ticket_id = $1)
             AND NOT EXISTS (
               SELECT 1 FROM ticket_pos
               WHERE ticket_id = $1 AND UPPER(COALESCE(checker_status, 'PENDING')) <> 'DONE'
             )
           RETURNING ticket_id`,
          [ticketId],
        );
        if (autoFinish.rowCount) {
          await appendEvent(client, ticketId, "AUTO_FINISH_UNLOADING", body.actor, {
            reason: "Semua PO selesai Done Checking",
          });
        }
      }
    } else if (action === "donegrpo") {
      const poId = clean(body.ticket_po_id);
      if (!poId) throw new Error("ticket_po_id wajib diisi.");
      await client.query(
        `UPDATE ticket_pos SET actual_quantity = $3, gr_status = 'DONE GR', gr_done_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1 AND ticket_po_id = $2`,
        [ticketId, poId, Number(body.actual_quantity || 0)],
      );
    } else if (action === "handovergrn") {
      await client.query(`UPDATE ticket_pos SET handover_grn_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1`, [ticketId]);
      await client.query(`UPDATE tickets SET status = 'COMPLETED', done_unloading_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1`, [ticketId]);
    } else if (action === "failcall") {
      await client.query(`UPDATE tickets SET status = 'EXPIRED', expired_at = CURRENT_TIMESTAMP, expired_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1`, [ticketId, clean(body.reason) || null]);
    } else {
      const status = clean(body.status).toUpperCase();
      const fields = ["updated_at = CURRENT_TIMESTAMP"];
      const values = [ticketId];
      if (status) { values.push(status); fields.push(`status = $${values.length}`); }
      if (clean(body.gate)) { values.push(clean(body.gate)); fields.push(`gate = $${values.length}`); }
      if (status === "CALLED") { fields.push("called_at = COALESCE(called_at, CURRENT_TIMESTAMP)", "last_call_at = CURRENT_TIMESTAMP", "call_count = call_count + 1"); }
      if (status === "WAITING GR") fields.push("done_unloading_at = COALESCE(done_unloading_at, CURRENT_TIMESTAMP)");
      if (status === "COMPLETED") fields.push("done_unloading_at = CURRENT_TIMESTAMP");
      await client.query(`UPDATE tickets SET ${fields.join(", ")} WHERE ticket_id = $1`, values);
    }
    const rows = await listOperationalRows(client, ticketId);
    await client.query("COMMIT");
    const allDoneGr = rows.length > 0 && rows.every((row) => String(row.gr_status).toUpperCase() === "DONE GR");
    return { rows, all_done_gr: allDoneGr };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

module.exports = async (req, res) => {
  const appOrigin = clean(process.env.APP_ORIGIN);
  if (appOrigin && req.headers.origin === appOrigin) {
    res.setHeader("Access-Control-Allow-Origin", appOrigin);
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Inbound-Api-Key");
  if (req.method === "OPTIONS") return res.status(204).end();

  const requestBody = parseBody(req);
  const action = clean(req.query?.action || requestBody.action).toLowerCase();
  try {
    const client = await getPool().connect();
    try {
      await ensureSchema(client);

      if (req.method === "GET" && action === "health") {
        const result = await client.query("SELECT current_timestamp AS connected_at");
        return json(res, 200, { ok: true, database: databaseName(), ...result.rows[0] });
      }

      if (req.method === "POST" && action === "login") {
        const session = authenticateUser(requestBody);
        if (!session) return json(res, 401, { ok: false, message: "Username atau password salah." });
        setSessionCookie(res, session);
        return json(res, 200, { ok: true, data: { user: { username: session.username, role: session.role, display_name: session.display_name } } });
      }
      if (req.method === "POST" && action === "logout") {
        clearSessionCookie(res);
        return json(res, 200, { ok: true });
      }

      const apiKeyValid = isAuthorized(req);
      if (action === "sync_superset_pos") {
        if (!apiKeyValid) return json(res, 401, { ok: false, message: "Unauthorized" });
      } else {
        const session = readSession(req);
        if (!canUseAction(session, action)) {
          return json(res, 401, { ok: false, message: "Unauthorized" });
        }
      }

      if (req.method === "GET" && action === "state") {
        return json(res, 200, { ok: true, data: await getAppState(client) });
      }

      if (req.method === "GET" && action === "tickets") {
        return json(res, 200, { ok: true, data: await listTickets(client, clean(req.query.status) || null) });
      }

      const body = requestBody;
      if (req.method === "POST" && action === "sync_superset_pos") {
        return json(res, 200, { ok: true, data: await syncSupersetPoMaster(client) });
      }
      if (req.method === "POST" && action === "create_ticket") {
        return json(res, 201, { ok: true, data: await createTicket(client, body) });
      }
      if (req.method === "POST" && action === "update_ticket_status") {
        return json(res, 200, { ok: true, data: await updateTicketStatus(client, body) });
      }
      if (req.method === "POST" && ["updatechecker", "startcheckerpo", "donecheckerpo", "donegrpo", "handovergrn", "failcall"].includes(action)) {
        return json(res, 200, { ok: true, data: await updateTicketPos(client, body, action) });
      }

      return json(res, 404, { ok: false, message: "Action tidak ditemukan." });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Inbound API error", error);
    return json(res, 500, { ok: false, message: error.message || "Database error" });
  }
};
