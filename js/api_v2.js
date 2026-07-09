const API_URL_V2 = "https://script.google.com/macros/s/AKfycbyjby6UR8H0H397xkHbpx9F57BhPKeTCndn3Ic3aKpqvEeQnIGYUmwBMa9JzPBhIoeD/exec";

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
  "Qty Refrences"
];

function hasApiV2() {
  return API_URL_V2 && !API_URL_V2.includes("PASTE_GAS_WEB_APP_URL_HERE");
}

function apiUrlV2(action, params = {}) {
  const u = new URL(API_URL_V2);
  u.searchParams.set("action", action);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "")
      u.searchParams.set(k, v);
  });
  u.searchParams.set("_", Date.now());
  return u.toString();
}

async function apiGetV2(action, params = {}) {
  if (!hasApiV2()) throw new Error("API_URL_V2 belum diganti.");
  const res = await fetch(apiUrlV2(action, params), {
    method: "GET",
    redirect: "follow",
  });
  const json = await res.json();
  if (!json.ok && json.status !== "success") throw new Error(json.error || "API V2 error");
  return json.data || json;
}

async function apiPostV2(action, payload = {}) {
  if (!hasApiV2()) throw new Error("API_URL_V2 belum diganti.");
  const res = await fetch(apiUrlV2(action), {
    method: "POST",
    body: JSON.stringify(payload),
    redirect: "follow",
  });
  const json = await res.json();
  if (!json.ok && json.status !== "success") throw new Error(json.error || "API V2 error");
  return json.data || json;
}

// Function to fetch V2 raw data directly
async function fetchV2Data() {
  try {
    if (!hasApiV2()) {
      console.warn("API V2 URL not configured");
      return null;
    }
    const res = await fetch(API_URL_V2 + "?_=" + Date.now(), {
      method: "GET",
      redirect: "follow"
    });
    const json = await res.json();
    return json;
  } catch (err) {
    console.error("Failed to fetch V2 data:", err);
    throw err;
  }
}
