const API_URL_V2 =
  "https://script.google.com/macros/s/AKfycbyjby6UR8H0H397xkHbpx9F57BhPKeTCndn3Ic3aKpqvEeQnIGYUmwBMa9JzPBhIoeD/exec";

const columns = [
  "Timestamp",
  "location_id",
  "request_shipping_date",
  "arrived_time",
  "slot",
  "destination_name",
  "vendor_name",
  "po_status",
  "po_number",
  "receiving_time",
  "done_time",
  "total_request_quantity",
  "actual_quantity",
  "Count SKU",
  "Is Cancelled",
  "WH TYPE",
  "Destination Name Adjusted",
  "Req Ship Date",
  "Date Arrival",
  "Licence Plate",
  "Vhiecle Type",
  "Vhiecle Max Handling Hour Duration",
  "Slot Adjusted",
  "SLA Slot Time",
  "End Time Slot",
  "Status SO Adjusted",
  "Duration\nArrived Time To SLA Slot Time",
  "Arrive to now",
  "Arrival Status",
  "Max Late Duration",
  "Max Early Duration",
  "Arrive to Receive\nDuration",
  "Processing Duration",
  "Target SLA Processing Duration",
  "SLA Time Refrence",
  "SLA Finished At",
  "OLD SLA Status",
  "NEW SLA Status",
  "Active Duration",
  "Qty Refrences",
];

const LOCAL_TICKETS_KEY = "inbound_cbt_manual_tickets_v2";
let v2RawResponse = null;
let v2PoIndex = null;
let securitySubmitBusy = false;

function hasApiV2() {
  return API_URL_V2 && !API_URL_V2.includes("PASTE_GAS_WEB_APP_URL_HERE");
}

function apiUrlV2(action, params = {}) {
  const u = new URL(API_URL_V2);
  if (action && action !== "raw") u.searchParams.set("action", action);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  });
  u.searchParams.set("_", Date.now());
  return u.toString();
}

async function apiGetV2(action = "raw", params = {}) {
  if (!hasApiV2()) throw new Error("API_URL_V2 belum diganti.");
  const res = await fetch(apiUrlV2(action, params), {
    method: "GET",
    redirect: "follow",
  });
  const json = await res.json();
  if (json.status && json.status !== "success") {
    throw new Error(json.message || "API V2 error");
  }
  return json.data || json;
}

async function apiPostV2(action, payload = {}) {
  if (!hasApiV2()) throw new Error("API_URL_V2 belum diganti.");
  const res = await fetch(apiUrlV2(action), {
    method: "POST",
    redirect: "follow",
    body: JSON.stringify({
      action,
      payload,
      timestamp: new Date().toISOString(),
    }),
  });

  const json = await res.json();
  if (json.status && json.status !== "success") {
    throw new Error(json.message || "API V2 POST error");
  }
  return json.data || json;
}

async function submitSecurityRowsToBackend(rows = []) {
  if (!rows.length) return { rows: [] };
  return apiPostV2("submitSecurity", { rows });
}

async function updateCheckerToBackend(body = {}) {
  return apiPostV2("updateChecker", body);
}

async function fetchV2Data() {
  // SAFE GAS:
  // /exec biasa tetap dipakai web lain.
  // Web Antrian harus pakai action=inboundRaw supaya dapat outputForm.
  return apiGetV2("inboundRaw");
}

async function fetchOutputFormData() {
  // Refresh cepat untuk Checker/Laporan/Monitor: baca Output form saja.
  return apiGetV2("output");
}

function getCell(row, keys, fallback = "") {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }
  }
  return fallback;
}

function normalizeKey(v) {
  return String(v || "")
    .trim()
    .toUpperCase();
}

function toNumberV2(v) {
  if (typeof v === "number") return v;
  const n = Number(String(v || "0").replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function uniqueCount(arr) {
  return new Set(arr.map((x) => String(x || "").trim()).filter(Boolean)).size;
}

function buildPoIndex(tableRows = []) {
  const index = {};
  for (const row of tableRows) {
    const po = normalizeKey(
      getCell(row, ["po_number", "po", "PO Number", "PO NUMBER"]),
    );
    if (!po) continue;

    if (!index[po]) {
      index[po] = {
        po_number: getCell(row, ["po_number", "po", "PO Number", "PO NUMBER"]),
        vendor_name: getCell(row, [
          "vendor_name",
          "Vendor Name",
          "VENDOR NAME",
        ]),
        slot: String(getCell(row, ["Slot Adjusted", "slot"], "3") || "3"),
        total_po_qty: 0,
        count_po_sku: 0,
        rows: 0,
        sample: row,
      };
    }

    index[po].rows += 1;
    index[po].total_po_qty += toNumberV2(
      getCell(row, [
        "total_request_quantity",
        "total_request_qty",
        "Total Request Quantity",
      ]),
    );
    index[po].count_po_sku += toNumberV2(
      getCell(row, ["Count SKU", "count_sku", "SKU Count"]),
    );
  }
  return index;
}

function getLocalTickets() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_TICKETS_KEY) || "[]");
  } catch (err) {
    return [];
  }
}

function saveLocalTickets(rows) {
  localStorage.setItem(LOCAL_TICKETS_KEY, JSON.stringify(rows || []));
}

function buildQueueFromV2Table(tableRows = []) {
  const seqBySlot = {};
  return tableRows.map((row, idx) => {
    const slot =
      String(getCell(row, ["Slot Adjusted", "slot"], "3") || "3").trim() || "3";
    seqBySlot[slot] = (seqBySlot[slot] || 0) + 1;

    const status = String(
      getCell(
        row,
        ["Status SO Adjusted", "NEW SLA Status", "Arrival Status", "po_status"],
        "WAITING",
      ),
    ).toUpperCase();

    const arrived = getCell(row, ["arrived_time", "Date Arrival", "Timestamp"]);
    const done = getCell(row, ["done_time", "SLA Finished At"], "");
    const plate = normalizePlateValue(
      getCell(row, ["Licence Plate", "license_plate", "plat_number"], ""),
    );

    return {
      source: "DATA_V2",
      row_no: idx + 2,
      queue_no: `REG ${slot}-${seqBySlot[slot]}`,
      ticket_type: "REG",
      slot,
      created_at: arrived || getCell(row, ["Timestamp"]),
      completed_at: done,
      vendor_name: getCell(row, ["vendor_name", "Vendor Name"]),
      fleet_type: getCell(row, ["Vhiecle Type", "Vehicle Type", "fleet_type"]),
      plat_number: plate,
      driver_name: "",
      phone_number: "",
      ktp_6_digit: "",
      po_number: getCell(row, ["po_number", "po"]),
      gate: getCell(
        row,
        ["Destination Name Adjusted", "destination_name"],
        "-",
      ),
      status,
      po_status: getCell(row, ["po_status"]),
      arrival_status: getCell(row, ["Arrival Status"]),
      unload_sla: getCell(
        row,
        ["NEW SLA Status", "OLD SLA Status", "SLA Status"],
        "",
      ),
      total_po_qty: toNumberV2(getCell(row, ["total_request_quantity"])),
      actual_quantity: toNumberV2(getCell(row, ["actual_quantity"])),
      count_po_sku: toNumberV2(getCell(row, ["Count SKU"])),
      waiting_text: getCell(row, ["Arrive to now", "Active Duration"], ""),
      waiting_minutes: minutesFromCreated(arrived),
      raw: row,
    };
  });
}

function getOutputFormRows(response) {
  if (Array.isArray(response?.outputForm)) return response.outputForm;
  if (Array.isArray(response?.output_form)) return response.output_form;
  if (Array.isArray(response?.data?.outputForm))
    return response.data.outputForm;
  if (Array.isArray(response?.data?.output_form))
    return response.data.output_form;
  return [];
}

function upsertOutputRowsToRawResponse(rows = []) {
  const incoming = Array.isArray(rows) ? rows : [];
  if (!incoming.length) return;

  if (!v2RawResponse) {
    v2RawResponse = {
      status: "success",
      timestamp: new Date().toISOString(),
      kpiRaw: [],
      table: [],
      tablev2: [],
      outputForm: [],
    };
  }

  const current = getOutputFormRows(v2RawResponse);
  const map = new Map();

  for (const row of current) {
    map.set(ticketIdentity(row), row);
  }

  for (const row of incoming) {
    map.set(ticketIdentity(row), row);
  }

  v2RawResponse = {
    ...v2RawResponse,
    timestamp: new Date().toISOString(),
    outputForm: Array.from(map.values()),
  };
}

function applyCheckerUpdateToQueue(body = {}) {
  const queue = state.dashboard?.queue || [];
  const bodyTicket = String(body.ticket_id || "").trim();
  const bodyQueue = String(body.queue_no || "").trim();
  const bodyPlate = normalizePlateValue(body.plat_number || "");

  let updated = false;

  const nextQueue = queue.map((row) => {
    const rowTicket = String(row.ticket_id || "").trim();
    const rowQueue = String(row.queue_no || "").trim();
    const rowOriginalQueue = String(row.original_queue_no || "").trim();
    const rowPlate = normalizePlateValue(row.plat_number || "");

    const match =
      (bodyTicket && rowTicket === bodyTicket) ||
      (bodyQueue &&
        (rowQueue === bodyQueue || rowOriginalQueue === bodyQueue)) ||
      (bodyPlate && rowPlate === bodyPlate);

    if (!match) return row;

    updated = true;
    return {
      ...row,
      ...body,
      queue_no: row.queue_no,
      original_queue_no: row.original_queue_no || body.queue_no || row.queue_no,
      plat_number: bodyPlate || row.plat_number,
      status: String(body.status || row.status || "WAITING").toUpperCase(),
      completed_at: body.completed_at || "",
      updated_at: body.updated_at || formatDateTimeLocal(new Date()),
    };
  });

  if (updated && state.dashboard) {
    state.dashboard.queue = nextQueue;
    state.dashboard.report_preview = nextQueue;
    state.dashboard.priority = nextQueue
      .filter((q) => !String(q.status || "").includes("COMPLETED"))
      .slice(0, 8);
  }

  return updated;
}

function replaceOutputRowsInRawResponse(rows = []) {
  const incoming = Array.isArray(rows) ? rows : [];
  if (!incoming.length || !v2RawResponse) return;

  const current = getOutputFormRows(v2RawResponse);
  const incomingMap = new Map();
  incoming.forEach((row) => incomingMap.set(ticketIdentity(row), row));

  const nextOutput = current.map((row) => {
    const key = ticketIdentity(row);
    return incomingMap.get(key) || row;
  });

  for (const row of incoming) {
    const key = ticketIdentity(row);
    if (!nextOutput.some((existing) => ticketIdentity(existing) === key)) {
      nextOutput.unshift(row);
    }
  }

  v2RawResponse = {
    ...v2RawResponse,
    timestamp: new Date().toISOString(),
    outputForm: nextOutput,
  };
}

function ticketIdentity(row) {
  const ticketId = String(row?.ticket_id || "").trim();
  if (ticketId) return "ticket:" + ticketId;

  return [
    "fallback",
    String(row?.queue_no || "").trim(),
    String(row?.po_number || row?.po || "").trim(),
    normalizePlateValue(row?.plat_number || row?.["Licence Plate"] || ""),
  ]
    .join("|")
    .toUpperCase();
}

function mergeTicketQueues(serverQueue = [], localQueue = []) {
  const seen = new Set();
  const out = [];

  for (const row of serverQueue.concat(localQueue || [])) {
    const key = ticketIdentity(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }

  return out;
}

function queueSlotValue(row = {}) {
  const slotRaw =
    row.slot || String(row.queue_no || "").match(/\s(\d+)-/)?.[1] || "999";
  const n = Number(String(slotRaw).replace(/[^0-9]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 999;
}

function queueCreatedValue(row = {}) {
  const raw = row.created_at || row.register_time || row.Timestamp || "";
  if (!raw) return 0;

  if (/^\d{4}-\d{2}-\d{2}T/.test(String(raw))) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  if (/^\d{2}\/\d{2}\/\d{4}/.test(String(raw))) {
    const p = String(raw).split(/[\/ :]/);
    const d = new Date(
      Number(p[2]),
      Number(p[1]) - 1,
      Number(p[0]),
      Number(p[3] || 0),
      Number(p[4] || 0),
      Number(p[5] || 0),
    );
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  const d = new Date(raw);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function queueTypeValue(row = {}) {
  const type = String(row.ticket_type || row.queue_no || "REG").toUpperCase();
  if (type.includes("VIP")) return 0;
  if (type.includes("REG")) return 1;
  if (type.includes("DROP")) return 2;
  return 9;
}

function sortQueueBySlotSequence(queue = []) {
  return [...queue].sort((a, b) => {
    const slotDiff = queueSlotValue(a) - queueSlotValue(b);
    if (slotDiff) return slotDiff;

    const createdDiff = queueCreatedValue(a) - queueCreatedValue(b);
    if (createdDiff) return createdDiff;

    const typeDiff = queueTypeValue(a) - queueTypeValue(b);
    if (typeDiff) return typeDiff;

    return String(a.ticket_id || a.queue_no || "").localeCompare(
      String(b.ticket_id || b.queue_no || ""),
    );
  });
}

function normalizeQueueSequenceBySlot(queue = []) {
  const sorted = sortQueueBySlotSequence(queue);
  const seqBySlot = {};

  return sorted.map((row) => {
    const slot = String(row.slot || queueSlotValue(row) || "3").trim() || "3";
    const type = String(row.ticket_type || row.queue_no || "REG")
      .toUpperCase()
      .includes("VIP")
      ? "VIP"
      : String(row.ticket_type || row.queue_no || "REG")
            .toUpperCase()
            .includes("DROP")
        ? "DROP"
        : "REG";

    seqBySlot[slot] = (seqBySlot[slot] || 0) + 1;

    return {
      ...row,
      original_queue_no: row.original_queue_no || row.queue_no || "",
      queue_no:
        type === "DROP"
          ? `DROP ${slot}-${seqBySlot[slot]}`
          : `${type} ${slot}-${seqBySlot[slot]}`,
      slot,
      queue_sequence: seqBySlot[slot],
    };
  });
}

function buildQueueFromOutputForm(outputRows = []) {
  return outputRows.map((row, idx) => {
    const created = getCell(row, ["created_at", "register_time", "Timestamp"]);
    const completed = getCell(row, ["completed_at"], "");
    const status = String(
      getCell(row, ["status"], "WAITING") || "WAITING",
    ).toUpperCase();
    const plate = normalizePlateValue(
      getCell(row, ["plat_number", "Licence Plate", "license_plate"], ""),
    );

    return {
      source: getCell(row, ["source"], "OUTPUT_FORM"),
      row_no: idx + 2,
      ticket_id: getCell(row, ["ticket_id"], ""),
      queue_no: getCell(
        row,
        ["queue_no"],
        `REG ${getCell(row, ["slot"], "3")}-${idx + 1}`,
      ),
      ticket_type: getCell(row, ["ticket_type"], "REG"),
      slot: String(getCell(row, ["slot"], "3") || "3"),
      created_at: created,
      register_time: getCell(row, ["register_time"], created),
      completed_at: completed,
      called_at: getCell(row, ["called_at"], ""),
      updated_at: getCell(row, ["updated_at"], ""),
      vendor_name: getCell(row, ["vendor_name", "Vendor Name"], ""),
      fleet_type: getCell(
        row,
        ["fleet_type", "Vhiecle Type", "Vehicle Type"],
        "",
      ),
      plat_number: plate,
      driver_name: getCell(row, ["driver_name"], ""),
      phone_number: getCell(row, ["phone_number"], ""),
      ktp_6_digit: getCell(row, ["ktp_6_digit"], ""),
      po_number: getCell(row, ["po_number", "po"], ""),
      gate: getCell(row, ["gate"], "-") || "-",
      status,
      po_status: getCell(row, ["po_status"], ""),
      arrival_status: getCell(row, ["arrival_status"], ""),
      unload_sla: getCell(row, ["unload_sla"], ""),
      total_po_qty: toNumberV2(
        getCell(row, ["total_po_qty", "total_request_quantity"], 0),
      ),
      actual_quantity: toNumberV2(getCell(row, ["actual_quantity"], 0)),
      count_po_sku: toNumberV2(getCell(row, ["count_po_sku", "Count SKU"], 0)),
      waiting_text: getCell(row, ["waiting_text"], ""),
      waiting_minutes: minutesFromCreated(created),
      raw: row,
    };
  });
}

function buildKpis(kpiRaw = [], tableRows = [], queue = []) {
  const raw = kpiRaw.length ? kpiRaw : tableRows;
  const totalRows = tableRows.length;
  const uniquePo = uniqueCount(
    tableRows.map((r) => getCell(r, ["po_number", "po"])),
  );
  const uniqueVendor = uniqueCount(
    tableRows.map((r) => getCell(r, ["vendor_name"])),
  );

  const totalRequestQty = raw.reduce(
    (s, r) =>
      s +
      toNumberV2(getCell(r, ["total_request_quantity", "total_request_qty"])),
    0,
  );

  const completed = queue.filter((q) => q.status.includes("COMPLETED")).length;
  const pending = queue.filter((q) => !q.status.includes("COMPLETED")).length;
  const late = queue.filter((q) => {
    const a = normalizeKey(q.arrival_status);
    const s = normalizeKey(q.unload_sla);
    return (
      a.includes("LATE") || s.includes("MISS") || q.status.includes("LATE")
    );
  }).length;
  const slaOk = queue.filter((q) => {
    const s = normalizeKey(q.unload_sla);
    return s.includes("OK") || s.includes("EARLY") || s.includes("ON TIME");
  }).length;
  const slaPct = queue.length
    ? Math.round((slaOk / queue.length) * 1000) / 10
    : 0;

  return [
    {
      label: "Total Data",
      display_value: num(totalRows),
      value: totalRows,
      icon: "database",
      color: "primary",
      source: "Data V2",
      metric: "rows",
    },
    {
      label: "Pending",
      display_value: num(pending),
      value: pending,
      icon: "schedule",
      color: "tertiary",
      source: "Data V2",
      metric: "not_completed",
    },
    {
      label: "Completed",
      display_value: num(completed),
      value: completed,
      icon: "check_circle",
      color: "success",
      source: "Data V2",
      metric: "completed",
    },
    {
      label: "Unique PO",
      display_value: num(uniquePo),
      value: uniquePo,
      icon: "inventory_2",
      color: "secondary",
      source: "Data V2",
      metric: "unique_po",
    },
    {
      label: "Total Qty",
      display_value: num(totalRequestQty),
      value: totalRequestQty,
      icon: "deployed_code",
      color: "primary",
      source: "Raw KPI",
      metric: "total_request_quantity",
    },
    {
      label: "Late / Miss",
      display_value: num(late),
      value: late,
      icon: "warning",
      color: late ? "error" : "success",
      source: "Data V2",
      metric: "late_rows",
    },
  ];
}

function buildSummary(kpiRaw = [], tableRows = [], queue = []) {
  const completed = queue.filter((q) => q.status.includes("COMPLETED")).length;
  const waiting = queue.filter(
    (q) =>
      q.status.includes("WAIT") ||
      q.status.includes("PENDING") ||
      q.status.includes("ON DELIVERY") ||
      !q.status.includes("COMPLETED"),
  ).length;
  const onDock = queue.filter(
    (q) =>
      q.status.includes("ON_DOCK") ||
      q.status.includes("ON DOCK") ||
      q.status.includes("RECEIVE"),
  ).length;
  const called = queue.filter((q) => q.status.includes("CALLED")).length;
  const late = queue.filter((q) =>
    normalizeKey(q.arrival_status).includes("LATE"),
  ).length;
  const totalRequestQty = tableRows.reduce(
    (s, r) => s + toNumberV2(getCell(r, ["total_request_quantity"])),
    0,
  );

  return {
    ticket: {
      count_waiting: waiting,
      count_called: called,
      count_on_dock: onDock,
      count_completed: completed,
    },
    checker: {
      on_process: onDock + called,
      completed,
      sla_ok_pct: queue.length
        ? Math.round((completed / queue.length) * 1000) / 10
        : 0,
      sla_miss: late,
    },
    caphand: {
      rows: tableRows.length,
      unique_po: uniqueCount(
        tableRows.map((r) => getCell(r, ["po_number", "po"])),
      ),
      unique_sku: tableRows.reduce(
        (s, r) => s + toNumberV2(getCell(r, ["Count SKU"])),
        0,
      ),
      unique_vendor: uniqueCount(
        tableRows.map((r) => getCell(r, ["vendor_name"])),
      ),
      total_request_qty: totalRequestQty,
      late_rows: late,
    },
  };
}

function buildOptionsFromV2(tableRows = []) {
  const vendors = [
    ...new Set(
      tableRows.map((r) => getCell(r, ["vendor_name"])).filter(Boolean),
    ),
  ].sort();
  const po = [
    ...new Set(
      tableRows.map((r) => getCell(r, ["po_number", "po"])).filter(Boolean),
    ),
  ].sort();
  const vehicle = [
    ...new Set(
      tableRows
        .map((r) => getCell(r, ["Vhiecle Type", "Vehicle Type", "fleet_type"]))
        .filter(Boolean),
    ),
  ].sort();

  return {
    ...state.options,
    vendor_name: vendors,
    po_number: po,
    fleet_type: vehicle.length ? vehicle : state.options.fleet_type,
  };
}

function getTableV2Rows(response) {
  // GAS terbaru return Data V2 di key `tablev2`.
  // Fallback `tableDatav2` dipasang untuk jaga-jaga kalau nama key berubah,
  // lalu `table` sebagai fallback versi lama.
  if (Array.isArray(response?.tablev2)) return response.tablev2;
  if (Array.isArray(response?.tableDatav2)) return response.tableDatav2;
  if (Array.isArray(response?.data?.tablev2)) return response.data.tablev2;
  if (Array.isArray(response?.data?.tableDatav2))
    return response.data.tableDatav2;
  if (Array.isArray(response?.table)) return response.table;
  return [];
}

function getKpiRawRows(response) {
  if (Array.isArray(response?.kpiRaw)) return response.kpiRaw;
  if (Array.isArray(response?.data?.kpiRaw)) return response.data.kpiRaw;
  return [];
}

function hasAuthoritativeOutputForm(response = {}) {
  return (
    Array.isArray(response?.outputForm) ||
    Array.isArray(response?.output_form) ||
    Array.isArray(response?.data?.outputForm) ||
    Array.isArray(response?.data?.output_form)
  );
}

function clearLocalTicketsCache(reason = "") {
  try {
    localStorage.removeItem(LOCAL_TICKETS_KEY);
    console.info("Local tickets cache cleared", reason || "");
  } catch (err) {
    console.warn("Failed clear local tickets cache", err);
  }
}

function buildDashboardFromV2(response) {
  const tableRows = getTableV2Rows(response);
  const kpiRaw = getKpiRawRows(response);
  const outputRows = getOutputFormRows(response);
  const outputIsAuthoritative = hasAuthoritativeOutputForm(response);
  v2PoIndex = buildPoIndex(tableRows);

  // Data V2 hanya dipakai untuk PO lookup/options.
  // Queue/Checker wajib dari hasil input Security: Output form.
  // Local tickets hanya fallback kalau backend belum pernah return outputForm.
  const serverQueue = buildQueueFromOutputForm(outputRows);
  const localQueue = outputIsAuthoritative ? [] : getLocalTickets();

  // Kalau backend sudah return Output form dan kosong, berarti sheet memang kosong.
  // Wajib clear cache browser supaya data lama tidak muncul lagi di Checker.
  if (outputIsAuthoritative && outputRows.length === 0) {
    clearLocalTicketsCache("Output form kosong dari backend");
  }

  const queue = normalizeQueueSequenceBySlot(
    mergeTicketQueues(serverQueue, localQueue),
  );

  const summary = buildSummary(kpiRaw, tableRows, queue);
  const kpis = buildKpis(kpiRaw, tableRows, queue);

  const dockMap = {};
  for (const q of queue) {
    const gate = q.gate || "-";
    if (!dockMap[gate])
      dockMap[gate] = { gate, status: "KOSONG", queue_no: "", plat_number: "" };
    if (!q.status.includes("COMPLETED")) {
      dockMap[gate] = {
        gate,
        status: q.status || "AKTIF",
        queue_no: q.queue_no,
        plat_number: q.plat_number,
      };
    }
  }

  return {
    timestamp: response?.timestamp || new Date().toISOString(),
    kpis,
    summary,
    queue,
    priority: queue
      .filter((q) => !String(q.status || "").includes("COMPLETED"))
      .slice(0, 8),
    dock: Object.values(dockMap).slice(0, 24),
    report_preview: queue,
    raw: {
      kpiRaw,
      tablev2: tableRows,
      outputForm: outputRows,
      table: Array.isArray(response?.table) ? response.table : [],
    },
    options: buildOptionsFromV2(tableRows),
  };
}

function updateApiPill(mode, text) {
  const pill = document.getElementById("api-pill");
  if (!pill) return;
  const color =
    mode === "on"
      ? "bg-success"
      : mode === "loading"
        ? "bg-warning"
        : "bg-error";
  pill.innerHTML = `<span class="w-2 h-2 rounded-full ${color} ${mode === "on" ? "status-pulse" : ""}"></span>${text}`;
}

function shouldUseOutputOnlyInitialLoad() {
  const page = String(
    state.page || (location.hash || "").replace("#", "") || "",
  ).trim();
  const role =
    typeof getAuthUser === "function"
      ? normalizeRole(getAuthUser()?.role || "")
      : "";

  if (role === "CHECKER" || role === "ADMIN") return true;
  if (
    ["checker", "monitor", "laporan", "panggil", "antrian"].includes(page) &&
    role !== "SECURITY"
  )
    return true;

  return false;
}

async function initApi() {
  updateApiPill("loading", "Cek API V2...");
  if (!hasApiV2()) {
    updateApiPill("off", "API V2 belum diset");
    return;
  }

  try {
    if (
      typeof shouldUseOutputOnlyInitialLoad === "function" &&
      shouldUseOutputOnlyInitialLoad()
    ) {
      const outputResponse = await fetchOutputFormData();
      v2RawResponse = {
        ...(v2RawResponse || {}),
        status: "success",
        timestamp: outputResponse?.timestamp || new Date().toISOString(),
        kpiRaw: [],
        table: [],
        tablev2: [],
        outputForm: getOutputFormRows(outputResponse),
      };
    } else {
      v2RawResponse = await fetchV2Data();
    }

    state.dashboard = buildDashboardFromV2(v2RawResponse);
    state.options = state.dashboard.options || state.options;
    state.lastCalled =
      typeof getLatestCallTicket === "function"
        ? getLatestCallTicket(state.dashboard.queue)
        : state.dashboard.queue[0] || state.lastCalled;
    updateApiPill("on", "API live");
    renderPage(state.page || "daftar", false);
  } catch (err) {
    console.error(err);
    updateApiPill("error", "API error");
    showToast("API V2 error: " + err.message);
  }
}

async function ensureFullDataForDaftar() {
  if (!hasApiV2()) return;
  const tableRows = getTableV2Rows(v2RawResponse || {});
  if (tableRows.length) return;

  try {
    updateApiPill("loading", "Load Data V2...");
    v2RawResponse = await fetchV2Data();
    state.dashboard = buildDashboardFromV2(v2RawResponse);
    state.options = state.dashboard.options || state.options;
    updateApiPill("on", "API live");
    if (state.page === "daftar") renderPage("daftar", false);
  } catch (err) {
    console.error(err);
    updateApiPill("error", "API error");
    showToast("Load Data V2 gagal: " + err.message);
  }
}

async function refreshDashboard() {
  try {
    if (
      ["checker", "laporan", "monitor", "antrian", "panggil"].includes(
        state.page,
      ) &&
      v2RawResponse
    ) {
      updateApiPill("loading", "Refresh Output form...");
      const outputResponse = await fetchOutputFormData();
      const outputRows = getOutputFormRows(outputResponse);

      if (
        hasAuthoritativeOutputForm(outputResponse) &&
        outputRows.length === 0
      ) {
        clearLocalTicketsCache("Manual refresh Output form kosong");
      }

      v2RawResponse = {
        ...v2RawResponse,
        timestamp: outputResponse?.timestamp || new Date().toISOString(),
        outputForm: outputRows,
      };
      state.dashboard = buildDashboardFromV2(v2RawResponse);
      state.options = state.dashboard.options || state.options;
      state.lastCalled =
        typeof getLatestCallTicket === "function"
          ? getLatestCallTicket(state.dashboard.queue)
          : state.dashboard.queue[0] || state.lastCalled;
      updateApiPill("on", "API live");
      renderPage(state.page || "checker", false);
      showToast("Output form refresh");
      return;
    }

    await initApi();
    showToast("Data refresh");
  } catch (err) {
    console.error(err);
    updateApiPill("error", "API error");
    showToast("Refresh gagal: " + err.message);
  }
}

function parsePoNumbers(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[,\n;]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

function lookupMultiplePo(poText) {
  const poNumbers = parsePoNumbers(poText);
  const items = [];
  const missing = [];

  for (const po of poNumbers) {
    const key = normalizeKey(po);
    const found = v2PoIndex?.[key];
    if (found) {
      items.push({
        ...found,
        po_number: found.po_number || po,
        po_input: po,
      });
    } else {
      missing.push(po);
    }
  }

  const vendors = [
    ...new Set(
      items.map((x) => String(x.vendor_name || "").trim()).filter(Boolean),
    ),
  ];

  const slots = [
    ...new Set(items.map((x) => String(x.slot || "").trim()).filter(Boolean)),
  ];

  const totalQty = items.reduce(
    (sum, x) => sum + toNumberV2(x.total_po_qty),
    0,
  );
  const totalSku = items.reduce(
    (sum, x) => sum + toNumberV2(x.count_po_sku),
    0,
  );

  return {
    found: items.length > 0,
    all_found: poNumbers.length > 0 && missing.length === 0,
    po_numbers: poNumbers,
    items,
    missing_po: missing,
    summary: {
      po_number: poNumbers.join(", "),
      po_numbers: poNumbers,
      vendor_name: vendors.join(", "),
      vendor_names: vendors,
      slot: slots[0] || "3",
      slots,
      total_po_qty: totalQty,
      count_po_sku: totalSku,
      found_count: items.length,
      missing_count: missing.length,
    },
  };
}

function updatePoLookupUi(lookup) {
  const form = document.getElementById("security-form");
  if (!form) return;

  if (form.vendor_name)
    form.vendor_name.value = lookup?.summary?.vendor_name || "";
  if (form.slot && lookup?.summary?.slot)
    form.slot.value = String(lookup.summary.slot || form.slot.value || "3");

  const total = document.getElementById("security-total-qty");
  const sku = document.getElementById("security-count-sku");
  if (total) total.textContent = num(lookup?.summary?.total_po_qty || 0);
  if (sku) sku.textContent = num(lookup?.summary?.count_po_sku || 0);

  if (typeof renderPoSelectedChips === "function") {
    renderPoSelectedChips(parsePoNumbers(form.po_number?.value || ""));
  }
  if (typeof filterPoDropdown === "function") filterPoDropdown();

  const box = document.getElementById("po-lookup-summary");
  if (box && typeof renderPoLookupSummary === "function") {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderPoLookupSummary(lookup);
    const next = wrapper.firstElementChild;
    if (next) box.replaceWith(next);
  }
}

function nextLocalQueueNoFromList(ticketType, slot, queue = []) {
  const type = String(ticketType || "REG").toUpperCase();
  const slotText = String(slot || "3").trim() || "3";

  if (type === "DROP") {
    const count =
      queue.filter((q) => String(q.slot || "").trim() === slotText).length + 1;
    return `DROP ${slotText}-${count}`;
  }

  // Sequence sekarang berbasis SLOT, bukan cuma type.
  // Jadi Slot 1 akan jadi REG 1-1, REG/VIP 1-2, dst; baru lanjut Slot 2.
  const count =
    queue.filter(
      (q) => String(q.slot || queueSlotValue(q) || "").trim() === slotText,
    ).length + 1;

  return `${type} ${slotText}-${count}`;
}

function nextLocalQueueNo(ticketType, slot) {
  const queue = (state.dashboard?.queue || []).concat(getLocalTickets());
  return nextLocalQueueNoFromList(ticketType, slot, queue);
}

function lookupPo(silent = false) {
  const form = document.getElementById("security-form");
  if (!form) return null;

  const poText = form.po_number?.value || "";
  const poNumbers = parsePoNumbers(poText);
  if (!poNumbers.length) {
    state.poLookup = null;
    updatePoLookupUi(null);
    return null;
  }

  const lookup = lookupMultiplePo(poText);
  state.poLookup = lookup;
  updatePoLookupUi(lookup);

  if (!silent) {
    if (lookup.all_found) {
      showToast(`${lookup.items.length} PO ditemukan dari Data V2`);
    } else if (lookup.found) {
      showToast(
        `${lookup.items.length} PO ditemukan, ${lookup.missing_po.length} tidak ketemu`,
      );
    } else {
      showToast("PO tidak ketemu di Data V2");
    }
  }

  return lookup.found ? lookup : null;
}

function nextLocalQueueNo(ticketType, slot) {
  const queue = (state.dashboard?.queue || []).concat(getLocalTickets());
  const type = String(ticketType || "REG").toUpperCase();
  const slotText = String(slot || "3");

  if (type === "DROP") {
    const count =
      queue.filter((q) => String(q.queue_no || "").startsWith("DROP")).length +
      1;
    return `DROP-${count}`;
  }

  const count =
    queue.filter((q) =>
      String(q.queue_no || "").startsWith(`${type} ${slotText}-`),
    ).length + 1;
  return `${type} ${slotText}-${count}`;
}

function parseMultiInputValues(value) {
  return String(value || "")
    .split(/[,\n;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseMultiPlateValues(value) {
  return parseMultiInputValues(value).map(normalizePlateValue).filter(Boolean);
}

function pickMultiValue(list = [], index = 0) {
  if (!Array.isArray(list) || !list.length) return "";
  if (list.length === 1) return list[0];
  return list[index] || list[list.length - 1] || list[0] || "";
}

async function submitSecurity(e) {
  e.preventDefault();

  if (securitySubmitBusy) {
    showToast("Submit sedang diproses, tunggu sebentar.");
    return;
  }

  const form = e.target;
  if (typeof syncPlateMultiInput === "function") syncPlateMultiInput();

  if (!validateSecurityForm(form)) return;

  const lookup = lookupPo(true);
  if (!lookup || !lookup.all_found) {
    const missingText = lookup?.missing_po?.length
      ? " Missing: " + lookup.missing_po.join(", ")
      : "";
    showToast("Semua PO wajib valid sebelum buat nomor." + missingText);
    return;
  }

  securitySubmitBusy = true;
  const submitBtn = document.getElementById("security-submit-btn");
  const submitText = document.getElementById("security-submit-text");
  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Menyimpan...";

  try {
    const base = Object.fromEntries(new FormData(form).entries());
    const poItems = lookup.items || [];

    if (!poItems.length) {
      showToast("PO belum valid.");
      return;
    }

    const plateList = parseMultiPlateValues(base.plat_number);
    const driverList = parseMultiInputValues(base.driver_name);
    const phoneList = parseMultiInputValues(base.phone_number);

    if (!plateList.length) {
      showToast("Plat number wajib diisi.");
      return;
    }
    if (!driverList.length) {
      showToast("Driver name wajib diisi.");
      return;
    }
    if (!phoneList.length) {
      showToast("Phone number wajib diisi.");
      return;
    }

    const rows = getLocalTickets();
    const newRows = [];
    const registerTime = base.register_time || formatDateTimeLocal(new Date());
    let queuePool = (state.dashboard?.queue || []).concat(rows);

    for (const [index, item] of poItems.entries()) {
      const rowSlot =
        String(base.ticket_type || "").toUpperCase() === "DROP"
          ? base.slot || item.slot || "3"
          : item.slot || base.slot || "3";

      const plate = pickMultiValue(plateList, index);
      const driver = pickMultiValue(driverList, index);
      const phone = pickMultiValue(phoneList, index);

      const row = {
        ...base,
        ticket_id:
          "IBT-" +
          Date.now().toString(36).toUpperCase() +
          "-" +
          String(newRows.length + 1).padStart(2, "0"),
        po_number: item.po_number,
        po_numbers: lookup.summary.po_numbers,
        vendor_name: item.vendor_name || base.vendor_name || "",
        slot: rowSlot,
        plat_number: plate,
        driver_name: driver,
        phone_number: phone,
        status: "WAITING",
        total_po_qty: toNumberV2(item.total_po_qty),
        count_po_sku: toNumberV2(item.count_po_sku),
        created_at: registerTime,
        register_time: registerTime,
        queue_no: nextLocalQueueNoFromList(
          base.ticket_type,
          rowSlot,
          queuePool.concat(newRows),
        ),
        gate: "-",
        unload_sla: "",
        source: "SECURITY_INPUT",
      };

      newRows.push(row);
    }

    // Local fallback tetap disimpan supaya UI langsung punya data walau backend lambat.
    rows.unshift(...newRows);
    saveLocalTickets(rows);

    try {
      showToast("Menyimpan ticket ke Output form...");
      const result = await submitSecurityRowsToBackend(newRows);

      // Tidak fetch full API lagi. Row hasil POST langsung dimasukkan ke state.
      const savedRows =
        Array.isArray(result?.rows) && result.rows.length
          ? result.rows
          : newRows;

      upsertOutputRowsToRawResponse(savedRows);
      state.dashboard = buildDashboardFromV2(v2RawResponse);
      state.options = state.dashboard.options || state.options;

      showToast(`${newRows.length} ticket masuk Output form`);
    } catch (err) {
      console.error(err);

      // Tetap tampilkan ticket lokal supaya Checker langsung bisa proses.
      if (v2RawResponse) {
        upsertOutputRowsToRawResponse(newRows);
        state.dashboard = buildDashboardFromV2(v2RawResponse);
        state.options = state.dashboard.options || state.options;
      } else {
        state.dashboard.queue.unshift(...newRows);
        state.dashboard.report_preview.unshift(...newRows);
      }

      showToast("Backend gagal, ticket tersimpan lokal: " + err.message);
    }

    state.lastCalled = newRows[0];
    const queueEl = document.getElementById("new-queue-number");
    if (queueEl) queueEl.textContent = newRows[0].queue_no;
    renderPage("checker", false);
  } finally {
    securitySubmitBusy = false;
    const activeBtn = document.getElementById("security-submit-btn");
    const activeText = document.getElementById("security-submit-text");
    if (activeBtn) activeBtn.disabled = false;
    if (activeText) activeText.textContent = "Buat Nomor";
  }
}

function getQueueRowByCheckerBody(body = {}) {
  const bodyTicket = String(body.ticket_id || "").trim();
  const bodyQueue = String(body.queue_no || "").trim();
  const bodyPlate = normalizePlateValue(body.plat_number || "");

  return (state.dashboard?.queue || []).find((row) => {
    const rowTicket = String(row.ticket_id || "").trim();
    const rowQueue = String(row.queue_no || "").trim();
    const rowOriginalQueue = String(row.original_queue_no || "").trim();
    const rowPlate = normalizePlateValue(row.plat_number || "");
    return (
      (bodyTicket && rowTicket === bodyTicket) ||
      (bodyQueue &&
        (rowQueue === bodyQueue || rowOriginalQueue === bodyQueue)) ||
      (bodyPlate && rowPlate === bodyPlate)
    );
  });
}

function buildUpdatedOutputRowFromBody(body = {}) {
  const old = getQueueRowByCheckerBody(body) || {};
  return {
    ...old.raw,
    ...old,
    ...body,
    queue_no: body.queue_no || old.original_queue_no || old.queue_no || "",
    ticket_id: body.ticket_id || old.ticket_id || "",
    plat_number: body.plat_number || old.plat_number || "",
    gate: body.gate || old.gate || "-",
    status: body.status || old.status || "WAITING",
    unload_sla: body.unload_sla || old.unload_sla || "",
    updated_at: body.updated_at || formatDateTimeLocal(new Date()),
    completed_at: body.completed_at || "",
  };
}

async function submitChecker(e) {
  e.preventDefault();
  const form = e.target;
  const requiredOk = validateRequiredFields(form);
  const plateOk = validatePlateInput(form.plat_number);
  if (!requiredOk || !plateOk) {
    showToast("Pilih data dari List Security dan isi Gate.");
    return;
  }

  const body = Object.fromEntries(new FormData(form).entries());

  // Kalau gate terkunci/disabled, FormData tidak mengambil select gate.
  if (!body.gate && form.gate) {
    body.gate = form.gate.dataset.lockedGate || form.gate.value || "Dock 01";
  }

  body.plat_number = normalizePlateValue(body.plat_number);

  const requested = String(body.status || "CALLED").toUpperCase();
  const targetStatus = requested.includes("COMPLETED")
    ? "COMPLETED"
    : requested.includes("UNLOADING")
      ? "UNLOADING"
      : "CALLED";

  body.status = targetStatus;
  body.unload_sla = targetStatus === "COMPLETED" ? "SLA OK" : "ON PROCESS";
  body.updated_at = formatDateTimeLocal(new Date());
  body.called_at =
    targetStatus === "CALLED"
      ? formatDateTimeLocal(new Date())
      : body.called_at || "";
  body.completed_at =
    targetStatus === "COMPLETED" ? formatDateTimeLocal(new Date()) : "";

  const local = getLocalTickets();
  let updatedLocal = false;
  for (const row of local) {
    const match =
      (body.ticket_id && row.ticket_id === body.ticket_id) ||
      (body.queue_no &&
        (row.queue_no === body.queue_no ||
          row.original_queue_no === body.queue_no)) ||
      normalizePlateValue(row.plat_number) === body.plat_number;

    if (match) {
      Object.assign(row, body, {
        status: targetStatus,
        unload_sla: body.unload_sla,
        called_at:
          targetStatus === "CALLED"
            ? body.called_at
            : row.called_at || body.called_at || "",
        completed_at: body.completed_at || "",
      });
      updatedLocal = true;
    }
  }
  saveLocalTickets(local);

  const optimisticRow = buildUpdatedOutputRowFromBody(body);
  const updatedUi = applyCheckerUpdateToQueue(body);

  if (v2RawResponse) {
    replaceOutputRowsInRawResponse([optimisticRow]);
    state.dashboard = buildDashboardFromV2(v2RawResponse);
    state.lastCalled =
      typeof getLatestCallTicket === "function"
        ? getLatestCallTicket(state.dashboard.queue)
        : state.lastCalled;
  }

  try {
    const result = await updateCheckerToBackend(body);
    if (Array.isArray(result?.rows) && result.rows.length) {
      replaceOutputRowsInRawResponse(result.rows);
      state.dashboard = buildDashboardFromV2(v2RawResponse);
    } else if (v2RawResponse) {
      replaceOutputRowsInRawResponse([optimisticRow]);
      state.dashboard = buildDashboardFromV2(v2RawResponse);
    }

    state.lastCalled =
      typeof getLatestCallTicket === "function"
        ? getLatestCallTicket(state.dashboard.queue)
        : state.lastCalled;

    if (targetStatus === "CALLED") {
      showToast("Nomor dipanggil ke monitor TV");
    } else if (targetStatus === "UNLOADING") {
      showToast("Status berubah menjadi UNLOADING");
    } else {
      showToast("Status berubah menjadi SELESAI UNLOADING");
    }
  } catch (err) {
    console.error(err);
    showToast(
      updatedLocal || updatedUi
        ? "Checker tersimpan lokal, backend gagal: " + err.message
        : "Checker backend gagal: " + err.message,
    );
  }

  renderPage("checker", false);
}

async function refreshCallMonitorData(renderAfter = false) {
  if (!hasApiV2() || !v2RawResponse) return;

  try {
    const outputResponse = await fetchOutputFormData();
    const outputRows = getOutputFormRows(outputResponse);

    if (hasAuthoritativeOutputForm(outputResponse) && outputRows.length === 0) {
      clearLocalTicketsCache("TV monitor Output form kosong");
    }

    v2RawResponse = {
      ...v2RawResponse,
      timestamp: outputResponse?.timestamp || new Date().toISOString(),
      outputForm: outputRows,
    };
    state.dashboard = buildDashboardFromV2(v2RawResponse);
    state.options = state.dashboard.options || state.options;
    state.lastCalled =
      typeof getLatestCallTicket === "function"
        ? getLatestCallTicket(state.dashboard.queue)
        : state.dashboard.queue[0] || state.lastCalled;

    if (renderAfter && state.page === "panggil") {
      renderPage("panggil", false);
    }
  } catch (err) {
    console.error("refreshCallMonitorData error", err);
  }
}

function callNext(btn) {
  if (btn) btn.classList.add("calling-effect");
  const gate = document.getElementById("call-gate")?.value || "Dock 01";
  const local = getLocalTickets();
  const next = local.find((q) =>
    String(q.status || "")
      .toUpperCase()
      .includes("WAITING"),
  );

  if (next) {
    next.status = "CALLED";
    next.gate = gate;
    next.called_at = formatDateTimeLocal(new Date());
    saveLocalTickets(local);
    state.lastCalled = next;
    if (v2RawResponse) state.dashboard = buildDashboardFromV2(v2RawResponse);
    showToast("Memanggil " + next.queue_no + " ke " + gate);
  } else {
    const first = (state.dashboard?.queue || []).find(
      (q) => !String(q.status || "").includes("COMPLETED"),
    );
    state.lastCalled = first || state.lastCalled;
    showToast("Mode read-only: tampilkan data pertama dari Data V2");
  }

  setTimeout(() => {
    if (btn) btn.classList.remove("calling-effect");
    renderPage(state.page || "panggil", false);
  }, 450);
}

function recall() {
  if (typeof recallVoice === "function") {
    recallVoice();
    return;
  }
  showToast("Panggil ulang " + (state.lastCalled?.queue_no || "-"));
}

async function loadDebug() {
  const out = document.getElementById("debug-output");
  if (out) out.textContent = "Loading debug V2...";
  try {
    if (!v2RawResponse) v2RawResponse = await fetchV2Data();
    state.debug = {
      api_url: API_URL_V2,
      timestamp: v2RawResponse.timestamp,
      kpiRaw_rows: getKpiRawRows(v2RawResponse).length || 0,
      table_rows_old: Array.isArray(v2RawResponse.table)
        ? v2RawResponse.table.length
        : 0,
      tablev2_rows: getTableV2Rows(v2RawResponse).length || 0,
      output_form_rows: getOutputFormRows(v2RawResponse).length || 0,
      tablev2_sample: getTableV2Rows(v2RawResponse).slice(0, 3),
      output_form_sample: getOutputFormRows(v2RawResponse).slice(0, 5),
      table_old_sample: (Array.isArray(v2RawResponse.table)
        ? v2RawResponse.table
        : []
      ).slice(0, 3),
      kpi_sample: getKpiRawRows(v2RawResponse).slice(0, 3),
      po_index_sample: Object.values(v2PoIndex || {}).slice(0, 5),
      local_tickets: getLocalTickets(),
    };
    if (out) out.textContent = JSON.stringify(state.debug, null, 2);
    showToast("Debug V2 selesai");
  } catch (err) {
    if (out) out.textContent = err.stack || err.message;
    showToast("Debug gagal");
  }
}

function openApi(action) {
  if (!hasApiV2()) {
    showToast("API_URL_V2 belum diset");
    return;
  }

  if (action === "reload") {
    initApi();
    return;
  }

  if (action === "debug") {
    switchPage("debug");
    setTimeout(loadDebug, 100);
    return;
  }

  const safeAction = action === "raw" ? "inboundRaw" : action;
  window.open(apiUrlV2(safeAction), "_blank");
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-page]");
  if (!btn) return;
  e.preventDefault();
  updateActiveNav(btn.dataset.page);
  switchPage(btn.dataset.page);
});

window.addEventListener("hashchange", () =>
  renderPage((location.hash || "#daftar").replace("#", ""), false),
);

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  if (typeof initSidebarVisibility === "function") initSidebarVisibility();
  if (typeof initTvModeListeners === "function") initTvModeListeners();
  setInterval(tickClock, 1000);
  tickClock();
  initShader();
  renderPage((location.hash || "#daftar").replace("#", ""), false);
  initApi();

  setInterval(() => {
    if (["monitor", "laporan", "antrian", "checker"].includes(state.page)) {
      renderPage(state.page, false);
    }
  }, 60000);
});

// Emergency manual cleanup from browser console:
// clearInboundLocalTickets()
window.clearInboundLocalTickets = function clearInboundLocalTickets() {
  clearLocalTicketsCache("Manual console clear");
  if (v2RawResponse) {
    v2RawResponse = { ...v2RawResponse, outputForm: [] };
    state.dashboard = buildDashboardFromV2(v2RawResponse);
    if (typeof renderPage === "function")
      renderPage(state.page || "checker", false);
  }
  return "OK - local tickets cache cleared";
};
