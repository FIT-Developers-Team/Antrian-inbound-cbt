(function installCancellation() {
  const contracts = window.InboundTicketContracts;
  const pending = new Set();
  const terminal = (row) => ["COMPLETED", "DONE GR", "EXPIRED", "CANCELLED"].includes(String(row.status || "").toUpperCase());
  const canCancel = () => ["SPV", "ADMIN", "DEVELOPER"].includes(String(getAuthUser?.()?.role || "").toUpperCase());

  window.cancelActionMarkup = function cancelActionMarkup(ticket, po = null) {
    const item = po || ticket;
    if (contracts.isCancelled(item)) {
      const reason = po ? po.po_cancelled_reason : ticket.cancelled_reason;
      const at = po ? po.po_cancelled_at : ticket.cancelled_at;
      return `<div class="text-xs text-error"><b>CANCELLED</b><br/>${esc(reason || "Dibatalkan")}<br/>${esc(contracts.formatWibDateTime(at))}</div>`;
    }
    if (!canCancel() || terminal(ticket)) return "";
    const relevant = po ? [po] : (ticket.po_rows || []);
    if (relevant.some((row) => String(row.gr_status).toUpperCase() === "DONE GR")) return "";
    return `<button type="button" class="thin-tab text-error border border-error/30 rounded-lg px-3 py-2 text-xs font-bold mt-1"
      data-cancel-ticket="${esc(ticket.ticket_id)}" data-cancel-po="${esc(po?.ticket_po_id || "")}"
      onclick="cancelInboundItem(this)">${po ? "Batalkan PO" : "Batalkan Tiket"}</button>`;
  };

  window.cancelInboundItem = async function cancelInboundItem(button) {
    if (!canCancel()) return showToast("Pembatalan hanya untuk SPV/Admin/Developer.");
    const id = button.dataset.cancelTicket;
    const poId = button.dataset.cancelPo;
    const key = id + ":" + poId;
    if (pending.has(key)) return;
    const tickets = state.dashboard?.history_queue || state.dashboard?.queue || [];
    const ticket = tickets.find((row) => String(row.ticket_id) === id);
    if (!ticket) return showToast("Tiket tidak ditemukan. Refresh dahulu.");
    const po = poId ? ticket.po_rows?.find((row) => String(row.ticket_po_id) === poId) : null;
    if (poId && !po) return showToast("PO tidak ditemukan. Refresh dahulu.");
    const label = po ? `PO ${po.po_number} pada ${ticket.queue_no}` : `seluruh tiket ${ticket.queue_no} / ${ticket.plat_number}`;
    const input = prompt(`Alasan membatalkan ${label} (wajib, maksimal 500 karakter):`);
    if (input === null) return;
    const reason = input.trim();
    if (!reason || reason.length > 500) return showToast("Alasan wajib diisi, maksimal 500 karakter.");
    if (!confirm(`Batalkan ${label}?\nAlasan: ${reason}\n\nData tetap tersimpan. Ini bukan Completed dan tidak bisa diproses lagi.`)) return;
    pending.add(key);
    button.disabled = true;
    try {
      const result = await motherDuckApiPost(po ? "cancel_po" : "cancel_ticket", {
        ticket_id: id, ...(po ? { ticket_po_id: poId } : {}), reason,
      });
      applyBackendActionResult(result);
      renderPage(state.page, false);
      showToast(po ? "PO dibatalkan. PO lainnya tetap mengikuti proses." : "Tiket dibatalkan, bukan Completed.");
    } catch (error) {
      showToast("Pembatalan gagal: " + error.message);
    } finally {
      pending.delete(key);
      button.disabled = false;
    }
  };
})();
