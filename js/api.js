const API_URL =
  "https://script.google.com/macros/s/AKfycbz-MyCo_kTHHXmbXum0q69_VmikaQjtCW8Fs0lKcMvatH3NOk4WTsEBJFoDSeQu_iORjg/exec";

function hasApi() {
  return API_URL && !API_URL.includes("PASTE_GAS_WEB_APP_URL_HERE");
}

function apiUrl(action, params = {}) {
  const u = new URL(API_URL);
  u.searchParams.set("action", action);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "")
      u.searchParams.set(k, v);
  });
  u.searchParams.set("_", Date.now());
  return u.toString();
}

async function apiGet(action, params = {}) {
  if (!hasApi()) throw new Error("API_URL belum diganti.");
  const res = await fetch(apiUrl(action, params), {
    method: "GET",
    redirect: "follow",
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API error");
  return json.data;
}

async function apiPost(action, payload = {}) {
  if (!hasApi()) throw new Error("API_URL belum diganti.");
  const res = await fetch(apiUrl(action), {
    method: "POST",
    body: JSON.stringify(payload),
    redirect: "follow",
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API error");
  return json.data;
}

async function initApi() {
  updateApiPill("loading", "Cek API...");
  if (!hasApi()) {
    updateApiPill("off", "API belum diset");
    return;
  }
  try {
    const [schema, dash] = await Promise.all([
      apiGet("schema"),
      apiGet("dashboard"),
    ]);
    state.schema = schema;
    state.options = dash.options || schema.options || state.options;
    state.poCache = state.options.po_summary_index || {};
    state.dashboard = dash;
    updateApiPill("on", "API live");
    renderPage(state.page, false);
  } catch (err) {
    console.error(err);
    updateApiPill("error", "API error");
    showToast("API error: " + err.message);
  }
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

async function refreshDashboard() {
  if (!hasApi()) {
    showToast("API_URL belum diset. Masih pakai dummy.");
    return;
  }
  try {
    state.dashboard = await apiGet("dashboard");
    state.options = state.dashboard.options || state.options;
    showToast("Dashboard refresh");
    renderPage(state.page, false);
    updateApiPill("on", "API live");
  } catch (err) {
    updateApiPill("error", "API error");
    showToast("Refresh gagal: " + err.message);
  }
}

async function lookupPo(silent = false) {
  const f = document.getElementById("security-form");
  if (!f) return;
  const fd = new FormData(f);
  const po = String(fd.get("po_number") || "").trim();
  const vendor = String(fd.get("vendor_name") || "").trim();
  if (!po && !vendor) return;

  const poKey = po.toUpperCase();
  if (poKey && state.poCache && state.poCache[poKey]) {
    state.poLookup = {
      found: true,
      cache: "CLIENT_PO_INDEX",
      summary: state.poCache[poKey],
      rows: [],
    };
    applyPoLookupToForm();
    if (!silent) showToast("PO ditemukan cepat");
    return;
  }

  if (!hasApi()) {
    state.poLookup = {
      summary: {
        po_number: po,
        vendor_name: vendor,
        total_po_qty: 123,
        count_po_sku: 7,
        slot: "3",
      },
    };
    applyPoLookupToForm();
    if (!silent) showToast("Lookup dummy aktif");
    return;
  }
  try {
    state.poLookup = await apiGet("lookupPo", {
      po_number: po,
      vendor_name: vendor,
    });
    const key = String(
      state.poLookup?.summary?.po_number || po || "",
    ).toUpperCase();
    if (key && state.poLookup?.summary) {
      state.poCache[key] = state.poLookup.summary;
    }
    applyPoLookupToForm();
    if (!silent)
      showToast(
        state.poLookup.found ? "PO ditemukan" : "PO tidak ketemu",
      );
  } catch (err) {
    if (!silent) showToast("Lookup gagal: " + err.message);
  }
}

function applyPoLookupToForm() {
  const f = document.getElementById("security-form");
  const s = state.poLookup?.summary || {};
  if (!f || !s) return;
  if (s.vendor_name && f.vendor_name) f.vendor_name.value = s.vendor_name;
  if (s.po_number && f.po_number && !f.po_number.value)
    f.po_number.value = s.po_number;
  if (s.slot && f.slot) {
    const exists = Array.from(f.slot.options).some(
      (o) => o.value === String(s.slot),
    );
    if (!exists)
      f.slot.add(new Option(String(s.slot), String(s.slot)), 0);
    f.slot.value = String(s.slot);
  }
  const qty = document.getElementById("security-total-qty");
  const sku = document.getElementById("security-count-sku");
  if (qty) qty.textContent = num(s.total_po_qty || 0);
  if (sku) sku.textContent = num(s.count_po_sku || 0);
  handleTicketTypeChange();
}

async function submitSecurity(e) {
  e.preventDefault();
  if (!validateSecurityForm(e.target)) return;
  const body = Object.fromEntries(new FormData(e.target).entries());
  body.status = "WAITING";
  body.plat_number = normalizePlateValue(body.plat_number);
  body.total_po_qty =
    state.poLookup?.summary?.total_po_qty ||
    Number(
      String(
        document.getElementById("security-total-qty")?.textContent || "0",
      )
        .replace(/\./g, "")
        .replace(/,/g, ""),
    ) ||
    0;
  body.count_po_sku =
    state.poLookup?.summary?.count_po_sku ||
    Number(
      String(
        document.getElementById("security-count-sku")?.textContent || "0",
      )
        .replace(/\./g, "")
        .replace(/,/g, ""),
    ) ||
    0;
  if (!hasApi()) {
    const seq = String(Math.floor(Math.random() * 90) + 1);
    const id =
      body.ticket_type === "DROP"
        ? `DROP-${seq}`
        : `REG ${body.slot || "3"}-${seq}`;
    state.lastCalled = {
      queue_no: id,
      gate: "-",
      vendor_name: body.vendor_name,
    };
    document.getElementById("new-queue-number").textContent = id;
    showToast("Dummy: nomor " + id + " dibuat");
    return;
  }
  try {
    const res = await apiPost("securityRegister", body);
    state.lastCalled = res.ticket;
    document.getElementById("new-queue-number").textContent =
      res.queue_no;
    showToast("Nomor " + res.queue_no + " dibuat");
    await refreshDashboard();
  } catch (err) {
    showToast("Submit gagal: " + err.message);
  }
}

async function submitChecker(e) {
  e.preventDefault();
  if (
    !validateRequiredFields(e.target) ||
    !validatePlateInput(e.target.plat_number)
  ) {
    showToast("Checker belum lengkap / plat belum valid.");
    return;
  }
  const body = Object.fromEntries(new FormData(e.target).entries());
  body.plat_number = normalizePlateValue(body.plat_number);
  if (!hasApi()) {
    showToast("Dummy: checker tersimpan");
    return;
  }
  try {
    const res = await apiPost("checkerSubmit", body);
    showToast(res.message || "Checker tersimpan");
    await refreshDashboard();
  } catch (err) {
    showToast("Submit gagal: " + err.message);
  }
}

async function callNext(btn) {
  const gate = document.getElementById("call-gate")?.value || "Dock 01";
  if (btn) btn.classList.add("calling-effect");
  if (!hasApi()) {
    const q = (state.dashboard.queue || [])[0] || {
      queue_no: "IB-999",
      vendor_name: "Dummy Vendor",
    };
    state.lastCalled = { ...q, gate };
    showToast("Dummy panggil " + state.lastCalled.queue_no);
    setTimeout(() => {
      if (btn) btn.classList.remove("calling-effect");
      renderPage(state.page, false);
    }, 450);
    return;
  }
  try {
    const res = await apiPost("callNext", { gate });
    if (res.ticket) {
      state.lastCalled = res.ticket;
      showToast(
        "Memanggil " +
          res.ticket.queue_no +
          " ke " +
          (res.ticket.gate || gate),
      );
    } else {
      showToast(res.message);
    }
    await refreshDashboard();
  } catch (err) {
    showToast("Call gagal: " + err.message);
  } finally {
    if (btn) btn.classList.remove("calling-effect");
  }
}

function recall() {
  showToast("Panggil ulang " + (state.lastCalled.queue_no || "IB-000"));
}

async function loadDebug() {
  const out = document.getElementById("debug-output");
  if (!out) return;
  out.textContent = "Loading debug...";
  if (!hasApi()) {
    out.textContent = JSON.stringify(
      { error: "API_URL belum diganti", demo: state.dashboard },
      null,
      2,
    );
    return;
  }
  try {
    state.debug = await apiGet("debug");
    out.textContent = JSON.stringify(state.debug, null, 2);
    showToast("Debug selesai");
  } catch (err) {
    out.textContent = err.stack || err.message;
    showToast("Debug gagal");
  }
}

function openApi(action) {
  if (!hasApi()) {
    showToast("API_URL belum diset");
    return;
  }
  window.open(apiUrl(action), "_blank");
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-page]");
  if (btn) switchPage(btn.dataset.page);
});
window.addEventListener("hashchange", () =>
  renderPage((location.hash || "#daftar").replace("#", ""), false),
);
initTheme();
setInterval(tickClock, 1000);
tickClock();
initShader();
renderPage((location.hash || "#daftar").replace("#", ""), false);
initApi();
