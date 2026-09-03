export function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function jsonResponse(request: Request, status: number, body: unknown): Response {
  const origin = request.headers.get("origin") || "";
  const allowed = clean(Deno.env.get("APP_ORIGINS"))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const corsOrigin = allowed.includes(origin) ? origin : (allowed[0] || "*");
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": corsOrigin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,x-sync-secret",
      "access-control-max-age": "86400",
      "vary": "Origin",
    },
  });
}

export function optionsResponse(request: Request): Response {
  return jsonResponse(request, 204, null);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index];
  return result === 0;
}
