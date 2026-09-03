import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { clean, constantTimeEqual, jsonResponse, optionsResponse } from "../_shared/http.ts";

type Session = { username: string; role: string; display_name: string; exp: number };
type ConfiguredUser = { username: string; password: string; role: string; display_name?: string };

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const encoder = new TextEncoder();

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return clean((error as { message?: unknown }).message);
  return String(error);
}

function base64Url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(normalized);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function hmac(value: string): Promise<string> {
  const secret = clean(Deno.env.get("INBOUND_AUTH_SECRET"));
  if (!secret) throw new Error("INBOUND_AUTH_SECRET belum diset di Supabase Secrets.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function signSession(session: Session): Promise<string> {
  const encoded = base64Url(encoder.encode(JSON.stringify(session)));
  return `${encoded}.${await hmac(encoded)}`;
}

async function readSession(request: Request): Promise<Session | null> {
  const authorization = clean(request.headers.get("authorization"));
  const token = authorization.replace(/^Bearer\s+/i, "");
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !constantTimeEqual(signature, await hmac(encoded))) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as Session;
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function configuredUsers(): ConfiguredUser[] {
  const raw = Deno.env.get("INBOUND_AUTH_USERS") || "[]";
  const users = JSON.parse(raw);
  if (!Array.isArray(users)) throw new Error("INBOUND_AUTH_USERS harus berupa JSON array.");
  const commercialRaw = Deno.env.get("INBOUND_COMMERCIAL_USER") || "";
  if (!commercialRaw) return users;
  const commercial = JSON.parse(commercialRaw);
  const commercialUsers = Array.isArray(commercial) ? commercial : [commercial];
  return [...users, ...commercialUsers];
}

function authenticate(body: Record<string, unknown>): Session | null {
  const username = clean(body.username).toLowerCase();
  const password = String(body.password || "");
  const user = configuredUsers().find((candidate) =>
    clean(candidate.username).toLowerCase() === username && constantTimeEqual(String(candidate.password || ""), password)
  );
  if (!user) return null;
  return {
    username: clean(user.username),
    role: clean(user.role).toUpperCase(),
    display_name: clean(user.display_name) || clean(user.username),
    exp: Date.now() + 12 * 60 * 60 * 1000,
  };
}

function canUseAction(session: Session | null, action: string): boolean {
  if (!session) return false;
  const role = session.role;
  if (action === "cancel_ticket" || action === "cancel_po") return ["SPV", "ADMIN", "DEVELOPER"].includes(role);
  if (["delete_tickets_by_date", "delete_single_ticket"].includes(action)) return ["ADMIN", "DEVELOPER"].includes(role);
  if (action === "bulk_complete_operational") return role === "DEVELOPER";
  if (["state", "state_delta", "realtime_config", "tickets", "export_rows"].includes(action)) {
    return ["SECURITY", "CHECKER", "SPV", "ADMIN", "DEVELOPER", "COMERCIAL"].includes(role);
  }
  if (["create_ticket", "create_tickets_bulk"].includes(action)) {
    return ["SECURITY", "CHECKER", "SPV", "ADMIN", "DEVELOPER"].includes(role);
  }
  if (["superset_freshness", "ba_list", "ba_detail", "product_lookup", "create_ba"].includes(action)) {
    return ["SPV", "ADMIN", "DEVELOPER"].includes(role);
  }
  return ["updatechecker", "startcheckerpo", "donecheckerpo", "donegrpo", "donegrpos", "handovergrn", "failcall", "update_ticket_status"].includes(action)
    && ["CHECKER", "SPV", "ADMIN", "DEVELOPER"].includes(role);
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== "POST") return {};
  try { return await request.json(); } catch { return {}; }
}

async function fetchAll(table: string, select = "*", orderColumn = "created_at", ascending = false): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).order(orderColumn, { ascending }).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

async function state(): Promise<Record<string, unknown>> {
  const [tablev2, outputForm, checkers] = await Promise.all([
    fetchAll("superset_po_public", "*", "synced_at", false),
    fetchAll("inbound_operational_rows", "*", "created_at", false),
    fetchAll("checker_master", "mp_id,checker_name", "checker_name", true),
  ]);
  const inboundMp = checkers.map((row) => ({ ...row, checker_id: row.mp_id }));
  return { status: "success", timestamp: new Date().toISOString(), tablev2, outputForm, inboundMp };
}

async function stateDelta(since: string): Promise<Record<string, unknown>> {
  if (!since || Number.isNaN(new Date(since).getTime())) throw new Error("Parameter since wajib berupa timestamp ISO yang valid.");
  const [{ data: outputForm, error: deltaError }, { data: ids, error: idError }, { data: inboundMp, error: checkerError }] = await Promise.all([
    db.from("inbound_operational_rows").select("*").gte("row_updated_at", since).order("created_at", { ascending: false }).limit(1000),
    db.from("tickets").select("ticket_id").order("ticket_id").limit(5000),
    db.from("checker_master").select("mp_id,checker_name").eq("active", true).order("checker_name").limit(500),
  ]);
  if (deltaError || idError || checkerError) throw deltaError || idError || checkerError;
  return { status: "success", timestamp: new Date().toISOString(), outputForm, ticket_ids: ids?.map((row) => row.ticket_id) || [],
    inboundMp: (inboundMp || []).map((row) => ({ ...row, checker_id: row.mp_id })) };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  const requestUrl = new URL(request.url);
  const body = await bodyOf(request);
  const action = clean(requestUrl.searchParams.get("action") || body.action).toLowerCase();
  try {
    if (request.method === "GET" && action === "health") {
      const { count, error } = await db.from("tickets").select("*", { count: "exact", head: true });
      if (error) throw error;
      return jsonResponse(request, 200, { ok: true, backend: "supabase", tickets: count, checked_at: new Date().toISOString() });
    }
    if (request.method === "POST" && action === "login") {
      const session = authenticate(body);
      if (!session) return jsonResponse(request, 401, { ok: false, message: "Username atau password salah." });
      return jsonResponse(request, 200, { ok: true, data: { token: await signSession(session), user: {
        username: session.username, role: session.role, display_name: session.display_name,
      } } });
    }
    if (request.method === "POST" && action === "logout") return jsonResponse(request, 200, { ok: true });

    const session = await readSession(request);
    if (!canUseAction(session, action)) return jsonResponse(request, 401, { ok: false, message: "Unauthorized" });
    if (request.method === "GET" && action === "realtime_config") {
      return jsonResponse(request, 200, { ok: true, data: { enabled: false, url: "", publishable_key: "", topic: "", event: "" } });
    }
    if (request.method === "GET" && action === "state") return jsonResponse(request, 200, { ok: true, data: await state() });
    if (request.method === "GET" && action === "state_delta") return jsonResponse(request, 200, { ok: true, data: await stateDelta(clean(requestUrl.searchParams.get("since"))) });
    if (request.method === "GET" && action === "superset_freshness") return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_superset_freshness", {}) });
    if (request.method === "GET" && action === "export_rows") return jsonResponse(request, 200, { ok: true, data: await fetchAll("inbound_operational_rows") });
    if (request.method === "GET" && action === "tickets") {
      let query = db.from("inbound_ticket_summaries").select("*").order("created_at", { ascending: false }).limit(5000);
      const status = clean(requestUrl.searchParams.get("status"));
      if (status) query = query.eq("status", status);
      const { data, error } = await query; if (error) throw error;
      return jsonResponse(request, 200, { ok: true, data });
    }
    if (request.method === "GET" && action === "product_lookup") {
      const q = clean(requestUrl.searchParams.get("q"));
      if (!q) throw new Error("SKU atau Product ID wajib diisi.");
      let result = await db.from("product_master").select("sku_number,product_id,product_name").eq("sku_number", q).maybeSingle();
      if (!result.data && !result.error) result = await db.from("product_master").select("sku_number,product_id,product_name").eq("product_id", q).limit(1).maybeSingle();
      if (result.error) throw result.error;
      return jsonResponse(request, 200, { ok: true, data: result.data });
    }
    if (request.method === "GET" && action === "ba_list") return jsonResponse(request, 200, { ok: true, data: await fetchAll("ba_documents_summary") });
    if (request.method === "GET" && action === "ba_detail") {
      const baId = clean(requestUrl.searchParams.get("ba_id"));
      const [{ data: document, error: docError }, { data: items, error: itemError }] = await Promise.all([
        db.from("ba_documents").select("*").eq("ba_id", baId).single(),
        db.from("ba_items").select("*").eq("ba_id", baId).order("created_at"),
      ]);
      if (docError || itemError) throw docError || itemError;
      return jsonResponse(request, 200, { ok: true, data: { document, items } });
    }

    const actor = { role: session!.role, name: session!.display_name };
    if (request.method === "POST" && ["cancel_ticket", "cancel_po"].includes(action)) {
      if (action === "cancel_po" && !clean(body.ticket_po_id)) throw new Error("ticket_po_id wajib diisi.");
      const payload = { ticket_id: body.ticket_id, reason: body.reason,
        ticket_po_id: action === "cancel_po" ? body.ticket_po_id : null };
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_cancel", { p_payload: payload, p_actor: actor }) });
    }
    if (request.method === "POST" && ["create_ticket", "create_tickets_bulk"].includes(action)) {
      const payload = action === "create_ticket" ? { tickets: [body] } : body;
      const data = await rpc("inbound_create_tickets_bulk", { p_payload: payload, p_actor: actor });
      const result = data as { created?: Record<string, unknown>[] };
      return jsonResponse(request, 201, { ok: true, data: action === "create_ticket" ? result.created?.[0] : data });
    }
    if (request.method === "POST" && action === "update_ticket_status") {
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_update_ticket_status", { p_payload: body, p_actor: actor }) });
    }
    if (request.method === "POST" && ["updatechecker", "startcheckerpo", "donecheckerpo", "donegrpo", "donegrpos", "handovergrn", "failcall"].includes(action)) {
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_update_ticket_pos", { p_action: action, p_payload: body, p_actor: actor }) });
    }
    if (request.method === "POST" && action === "delete_tickets_by_date") {
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_delete_tickets_by_date", { p_operational_date: body.operational_date }) });
    }
    if (request.method === "POST" && action === "delete_single_ticket") {
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_delete_single_ticket", { p_payload: body }) });
    }
    if (request.method === "POST" && action === "bulk_complete_operational") {
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_bulk_complete_operational", { p_payload: body, p_actor: actor }) });
    }
    if (request.method === "POST" && action === "create_ba") {
      return jsonResponse(request, 201, { ok: true, data: await rpc("inbound_create_ba", { p_payload: body, p_actor: actor }) });
    }
    return jsonResponse(request, 404, { ok: false, message: "Action belum tersedia di backend Supabase." });
  } catch (error) {
    const message = errorMessage(error) || "Supabase backend error";
    console.error("inbound-api", { action, message });
    return jsonResponse(request, 500, { ok: false, message });
  }
});
