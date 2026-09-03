import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");

function parseCsv(raw) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      if (quoted && raw[index + 1] === '"') { field += '"'; index += 1; } else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && raw[index + 1] === "\n") index += 1;
      row.push(field); field = ""; if (row.some(Boolean)) rows.push(row); row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function loadEnv() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const envPath = path.join(root, ".env.supabase.local");
  const raw = await fs.readFile(envPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

async function upsert(table, rows, conflict) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(conflict)}`;
  for (let offset = 0; offset < rows.length; offset += 500) {
    let response;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        response = await fetch(url, { method: "POST", headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal",
        }, body: JSON.stringify(rows.slice(offset, offset + 500)) });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
    if (!response.ok) throw new Error(`${table} HTTP ${response.status}: ${await response.text()}`);
  }
}

await loadEnv();
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Isi .env.supabase.local terlebih dahulu.");

const csvRows = parseCsv(await fs.readFile(path.join(root, "data", "product_master.csv"), "utf8"));
const headers = csvRows.shift().map((value) => value.trim().toLowerCase());
const at = (name) => headers.indexOf(name);
const products = csvRows.map((row) => ({ sku_number: row[at("sku_number")]?.trim(), product_name: row[at("product_name")]?.trim(),
  product_id: row[at("product_id")]?.trim() || null })).filter((row) => row.sku_number && row.product_name);

const backend = await fs.readFile(path.join(root, "api", "inbound.js"), "utf8");
const checkerBlock = backend.match(/const CHECKER_SEED = \[([\s\S]*?)\n\];/)?.[1] || "";
const checkers = [...checkerBlock.matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((match) => ({ mp_id: match[1], checker_name: match[2], active: true }));

await upsert("product_master", products, "sku_number");
await upsert("checker_master", checkers, "mp_id");
console.log(JSON.stringify({ products: products.length, checkers: checkers.length }));
