(function exposeDropoffDomain(root, factory) {
  const domain = factory();
  if (typeof module === "object" && module.exports) module.exports = domain;
  if (root) root.DropoffDomain = domain;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDropoffDomain() {
  const TERMINAL_STATUSES = new Set(["COMPLETED", "EXPIRED", "CANCELLED"]);

  function normalized(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[_\s]+/g, "-");
  }

  function statusOf(row = {}) {
    return normalized(row.status || "WAITING").replace(/-/g, " ");
  }

  function isDropoff(row = {}) {
    return [row.ticket_type, row.fleet_type, row.queue_no].some((value) => {
      const text = normalized(value);
      return text === "DROP" || text.includes("DROP-OFF");
    });
  }

  function isTerminal(row = {}) {
    return TERMINAL_STATUSES.has(statusOf(row));
  }

  function mainQueueRows(rows = []) {
    return (Array.isArray(rows) ? rows : []).filter((row) => !isDropoff(row));
  }

  function dropoffRows(rows = []) {
    return (Array.isArray(rows) ? rows : []).filter(isDropoff);
  }

  function summarizeDropoffs(rows = []) {
    const items = dropoffRows(rows);
    const count = (status) => items.filter((row) => statusOf(row) === status).length;
    return {
      total: items.length,
      active: items.filter((row) => !isTerminal(row)).length,
      waiting: count("WAITING"),
      called: count("CALLED"),
      unloading: count("UNLOADING"),
      completed: count("COMPLETED"),
      expired: count("EXPIRED"),
    };
  }

  function timestampOf(row = {}) {
    const value =
      row.created_at || row.register_time || row.Timestamp || row.updated_at || "";
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const text = String(value || "").trim();
    const dmy = text.match(
      /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
    );
    const parsed = dmy
      ? new Date(
          Number(dmy[3]),
          Number(dmy[2]) - 1,
          Number(dmy[1]),
          Number(dmy[4] || 0),
          Number(dmy[5] || 0),
          Number(dmy[6] || 0),
        )
      : new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function ageMinutes(row = {}, now = new Date()) {
    const started = timestampOf(row);
    const current = now instanceof Date ? now : new Date(now);
    if (!started || Number.isNaN(current.getTime())) return 0;
    return Math.max(0, Math.floor((current.getTime() - started.getTime()) / 60000));
  }

  function ageLabel(row = {}, now = new Date()) {
    const minutes = ageMinutes(row, now);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const remaining = minutes % 60;
    if (days) return `${days} hari ${hours} jam`;
    if (hours) return `${hours} jam ${remaining} menit`;
    return `${remaining} menit`;
  }

  function sortDropoffs(rows = []) {
    return [...dropoffRows(rows)].sort((a, b) => {
      const terminalDiff = Number(isTerminal(a)) - Number(isTerminal(b));
      if (terminalDiff) return terminalDiff;
      const aTime = timestampOf(a)?.getTime() || 0;
      const bTime = timestampOf(b)?.getTime() || 0;
      return isTerminal(a) ? bTime - aTime : aTime - bTime;
    });
  }

  return {
    ageLabel,
    ageMinutes,
    dropoffRows,
    isDropoff,
    isTerminal,
    mainQueueRows,
    sortDropoffs,
    statusOf,
    summarizeDropoffs,
  };
});
