import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { clean, constantTimeEqual, jsonResponse, optionsResponse } from "../_shared/http.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  const expected = clean(Deno.env.get("SYNC_SECRET"));
  const supplied = clean(request.headers.get("authorization")).replace(/^Bearer\s+/i, "");
  if (!expected || !constantTimeEqual(expected, supplied)) return jsonResponse(request, 401, { ok: false, message: "Unauthorized" });

  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.get("action") === "configure-cron") {
    const functionBaseUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
    const { data, error } = await db.rpc("configure_inbound_cron", {
      p_function_base_url: functionBaseUrl,
      p_sync_secret: expected,
    });
    if (error) return jsonResponse(request, 500, { ok: false, message: error.message });
    return jsonResponse(request, 200, { ok: true, data });
  }

  const runId = crypto.randomUUID();
  try {
    const baseUrl = clean(Deno.env.get("SUPERSET_BASE_URL") || "https://dash.astronauts.id").replace(/\/$/, "");
    const rawCookie = clean(Deno.env.get("SUPERSET_SESSION_COOKIE"));
    if (!rawCookie) throw new Error("SUPERSET_SESSION_COOKIE belum diset di Supabase Secrets.");
    const response = await fetch(`${baseUrl}/api/v1/chart/20662/data/?force=true`, {
      headers: { accept: "application/json", cookie: rawCookie.startsWith("session=") ? rawCookie : `session=${rawCookie}`, referer: `${baseUrl}/` },
    });
    if (!response.ok) throw new Error(`Superset saved chart gagal: HTTP ${response.status}`);
    const payload = await response.json();
    const rows = payload?.result?.[0]?.data;
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("Snapshot Superset kosong/tidak valid; snapshot lama dipertahankan.");
    const staged = [];
    for (const row of rows) {
      staged.push({
        run_id: runId,
        source_row_key: await sha256([row.po_number, row.location_id, row.request_shipping_date, row.fulfillment_arrived_start_at,
          row.schedule_type, row.company_name, row.po_status, row.fulfillment_receiving_start_at, row.fulfillment_completed_at]),
        po_number: clean(row.po_number), vendor_name: clean(row.company_name) || null,
        location_id: clean(row.location_id) || null, location_name: clean(row.location_name) || null,
        request_shipping_date: clean(row.request_shipping_date) || null,
        fulfillment_arrived_start_at: clean(row.fulfillment_arrived_start_at) || null,
        schedule_type: clean(row.schedule_type) || null, po_status: clean(row.po_status) || null,
        fulfillment_receiving_start_at: clean(row.fulfillment_receiving_start_at) || null,
        fulfillment_completed_at: clean(row.fulfillment_completed_at) || null,
        request_quantity: number(row["SUM(request_quantity)"]), actual_quantity: number(row["SUM(actual_quantity)"]),
        count_sku: Math.trunc(number(row["COUNT_DISTINCT(sku_number)"])),
      });
    }
    for (let offset = 0; offset < staged.length; offset += 250) {
      const { error } = await db.from("superset_po_stage").upsert(staged.slice(offset, offset + 250));
      if (error) throw error;
    }
    const checksum = await sha256(staged.map((row) => [row.source_row_key, row.request_quantity, row.actual_quantity, row.count_sku]));
    const { data, error } = await db.rpc("inbound_finalize_superset_sync", {
      p_run_id: runId, p_expected_count: staged.length, p_checksum: checksum,
    });
    if (error) throw error;
    const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.from("sync_runs").delete().lt("started_at", retentionCutoff);
    return jsonResponse(request, 200, { ok: true, data: { ...data, run_id: runId } });
  } catch (error) {
    await db.from("sync_runs").upsert({ run_id: runId, sync_name: "superset_po", status: "FAILED",
      error_message: (error instanceof Error ? error.message : String(error)).slice(0, 500), finished_at: new Date().toISOString() });
    console.error("sync-superset", { runId, message: error instanceof Error ? error.message : String(error) });
    return jsonResponse(request, 500, { ok: false, run_id: runId, message: error instanceof Error ? error.message : "Sync gagal" });
  }
});
