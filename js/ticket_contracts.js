(function exposeTicketContracts(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.InboundTicketContracts = api;
})(typeof window !== "undefined" ? window : globalThis, function ticketContractsFactory() {
  const FLEET_TYPES = Object.freeze([
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

  const FLEET_NOTES = Object.freeze({
    KR2: "Motor, Roda 3, Orang jalan kaki",
    "MINI BUS/MOBIL": "Minibus dan semua mobil pribadi",
    "BLIND VAN": "Grandmax, Van & Blindvan",
    "PICKUP/L300": "Pickup, Traga, dan truck box kecil",
    CDE: "Kendaraan roda 4",
    CDEL: "Kendaraan roda 4 dengan box lebih panjang",
    CDD: "Kendaraan roda 6",
    CDDL: "Kendaraan roda 6 dengan box lebih panjang",
    "TRONTON/FUSO": "Tronton / Fuso",
    WINGBOX: "Wing Box",
  });

  function fleetKey(value = "") {
    return String(value || "").trim().toUpperCase().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");
  }

  function normalizeFleetType(value = "") {
    const key = fleetKey(value);
    const aliases = {
      "KENDARAAN RODA 2": "KR2", "RODA 2": "KR2", MOTOR: "KR2", KR2: "KR2",
      MOBIL: "MINI BUS/MOBIL", MINIBUS: "MINI BUS/MOBIL", "MINI BUS": "MINI BUS/MOBIL",
      "MINIBUS/MOBIL": "MINI BUS/MOBIL", "MINI BUS/MOBIL": "MINI BUS/MOBIL",
      VAN: "BLIND VAN", GRANDMAX: "BLIND VAN", GMX: "BLIND VAN", BLINDVAN: "BLIND VAN", "BLIND VAN": "BLIND VAN",
      PICKUP: "PICKUP/L300", "PICK UP": "PICKUP/L300", "L300 BOX": "PICKUP/L300",
      "L300/PICK UP": "PICKUP/L300", "PICKUP/L300": "PICKUP/L300",
      CDE: "CDE", CDEL: "CDEL", CDD: "CDD", CDDL: "CDDL",
      FUSO: "TRONTON/FUSO", TRONTON: "TRONTON/FUSO", "TRONTON/FUSO": "TRONTON/FUSO",
      "WING BOX": "WINGBOX", WINGBOX: "WINGBOX",
      DROP: "DROP-OFF", "DROP OFF": "DROP-OFF", "DROP-OFF": "DROP-OFF",
    };
    return aliases[key] || key;
  }

  function fleetNote(value) {
    return FLEET_NOTES[normalizeFleetType(value)] || "Pilih tipe kendaraan sesuai kondisi aktual.";
  }

  function validateManualPoMetrics(totalQty, totalSku) {
    const qty = Number(totalQty);
    const sku = Number(totalSku);
    return {
      valid: Number.isFinite(qty) && qty > 0 && Number.isInteger(sku) && sku > 0,
      totalQty: Number.isFinite(qty) ? qty : 0,
      totalSku: Number.isFinite(sku) ? sku : 0,
    };
  }

  function normalizeTkbm(value) {
    const count = Number(value);
    const valid = (typeof value === "string" || typeof value === "number") &&
      String(value).trim() !== "" && Number.isSafeInteger(count) && count >= 0 && count <= 2147483647;
    return { valid, count: valid ? count : 0 };
  }

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    const text = String(value).trim();
    if (!text) return null;
    let match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (match) {
      const iso = `${match[3]}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}T${String(match[4] || 0).padStart(2, "0")}:${match[5] || "00"}:${match[6] || "00"}+07:00`;
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(text)) {
      const date = new Date(text.replace(" ", "T") + "+07:00");
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatWibDateTime(value) {
    const date = parseDate(value);
    if (!date) return "-";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]));
    const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
    return `${parts.day} ${months[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute} WIB`;
  }

  function firstDate(values = []) {
    return values.map(parseDate).filter(Boolean).sort((a, b) => a - b)[0] || null;
  }

  function lastDate(values = []) {
    return values.map(parseDate).filter(Boolean).sort((a, b) => b - a)[0] || null;
  }

  function getSlaHours(row = {}) {
    const ticketType = fleetKey(row.ticket_type);
    if (ticketType === "DROP" || ticketType === "DROP-OFF") return 23;
    const fleet = normalizeFleetType(row.fleet_type);
    const sku = Number(row.ticket_total_sku || row.count_po_sku || 0);
    if (["TRONTON/FUSO", "WINGBOX"].includes(fleet)) return 4;
    if (["CDD", "CDDL", "CDE", "CDEL"].includes(fleet)) return sku > 40 ? 4 : 2;
    if (["MINI BUS/MOBIL", "BLIND VAN", "PICKUP/L300"].includes(fleet)) return 2;
    if (fleet === "KR2") return 1;
    return 0;
  }

  function fleetSlaRuleText(type) {
    const fleet = normalizeFleetType(type);
    if (["TRONTON/FUSO", "WINGBOX"].includes(fleet)) return "SLA 4 jam";
    if (["CDD", "CDDL", "CDE", "CDEL"].includes(fleet)) {
      return "SLA 2 jam untuk SKU <= 40, SLA 4 jam untuk SKU > 40";
    }
    if (["MINI BUS/MOBIL", "BLIND VAN", "PICKUP/L300"].includes(fleet)) return "SLA 2 jam";
    if (fleet === "KR2") return "SLA 1 jam";
    return "SLA belum tersedia";
  }

  function compactMinutes(minutes) {
    const total = Math.max(0, Math.floor(Number(minutes) || 0));
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    if (hours && rest) return `${hours}j ${rest}m`;
    if (hours) return `${hours}j`;
    return `${rest}m`;
  }

  function isDoneGrTerminal(row = {}) {
    if (isCancelled(row)) return false;
    const poRows = activePoRows(row);
    const status = fleetKey(row.status);
    return Boolean(
      status === "COMPLETED" ||
      status === "DONE GR" ||
      row.all_done_gr === true ||
      row.ticket_all_done_gr === true ||
      (poRows.length > 0 &&
        poRows.every(
          (po) => fleetKey(po.gr_status) === "DONE GR",
        )),
    );
  }

  function doneGrAt(row = {}) {
    const poRows = Array.isArray(row.po_rows) ? row.po_rows : [];
    return (
      parseDate(row.done_gr_at) ||
      parseDate(row.ticket_done_gr_at) ||
      lastDate(poRows.map((po) => po.done_gr_at)) ||
      parseDate(row.completed_at) ||
      parseDate(row.done_unloading_at) ||
      parseDate(row.updated_at) ||
      null
    );
  }

  function getInboundSlaInfo(row = {}, now = new Date()) {
    if (isCancelled(row)) return { status: "CANCELLED", label: "Dibatalkan", target_hours: 0, actual_minutes: 0 };
    const poRows = activePoRows(row);
    const targetHours = Number(row.sla_target_hours) || getSlaHours(row);
    const start = parseDate(row.start_unloading_at) || firstDate(poRows.map((po) => po.start_unloading_at));
    const allDoneGr = isDoneGrTerminal(row);
    const done = allDoneGr ? doneGrAt(row) : null;
    const status = fleetKey(row.status || "WAITING");
    if (status === "EXPIRED") return { status: "EXPIRED", label: "Expired", target_hours: targetHours };
    if (!start || !targetHours) return { status: "WAITING", label: "Belum mulai", target_hours: targetHours };
    const targetAt = new Date(start.getTime() + targetHours * 3600000);
    const end = done || parseDate(now) || new Date();
    const actualMinutes = Math.max(0, Math.floor((end - start) / 60000));
    const delta = targetHours * 60 - actualMinutes;
    const late = delta < 0;
    return {
      status: done || allDoneGr ? (late ? "LATE" : "TERCAPAI") : late ? "SLA MISS" : "ON PROCESS",
      label: done || allDoneGr ? compactMinutes(actualMinutes) : late ? `Lewat ${compactMinutes(Math.abs(delta))}` : `Sisa ${compactMinutes(delta)}`,
      target_hours: targetHours, target_minutes: targetHours * 60, actual_minutes: actualMinutes,
      delta_minutes: delta, target_at: targetAt, start_at: start, done_at: done,
    };
  }

  function driverTimelineEntries(row = {}) {
    const poRows = Array.isArray(row.po_rows) ? row.po_rows : [];
    const values = [
      ["Registrasi", row.register_time || row.created_at],
      ["Dipanggil ke Gate", row.called_at || row.last_call_at],
      [`Unloading & Checking ${row.checker_progress || "0/0"}`, row.start_unloading_at || firstDate(poRows.map((po) => po.start_unloading_at))],
      [`Done GR ${row.gr_progress || "0/0"}`, row.done_gr_at || row.ticket_done_gr_at || lastDate(poRows.map((po) => po.done_gr_at))],
    ];
    if (isCancelled(row)) values.push(["Dibatalkan", row.cancelled_at || row.po_cancelled_at]);
    return values.map(([label, value]) => ({ label, value: parseDate(value), timeLabel: value ? formatWibDateTime(value) : "-" }));
  }

  function isCancelled(row = {}) {
    return fleetKey(row.status) === "CANCELLED" || Boolean(row.cancelled_at) ||
      (!Array.isArray(row.po_rows) && (Boolean(row.po_cancelled_at) || fleetKey(row.gr_status) === "CANCELLED"));
  }

  function activePoRows(row = {}) {
    return (Array.isArray(row.po_rows) ? row.po_rows : []).filter((po) => !isCancelled(po));
  }

  return { FLEET_TYPES, FLEET_NOTES, normalizeFleetType, fleetNote, fleetSlaRuleText,
    validateManualPoMetrics, normalizeTkbm, parseDate, formatWibDateTime, getSlaHours,
    isDoneGrTerminal, doneGrAt, getInboundSlaInfo, driverTimelineEntries, isCancelled, activePoRows };
});
