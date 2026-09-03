const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const start = source.indexOf("function printSecurityTickets(");
const end = source.indexOf("\nfunction pageDaftar", start);
assert.ok(start >= 0 && end > start);

function render(rows) {
  let html = "";
  const context = {
    document: { getElementById: () => null },
    localStorage: { setItem() {} },
    state: {},
    getLastSecurityRowsForPrint: () => [],
    formatDateTimeLocal: () => "03/09/2026 10:00:00",
    makeDriverTrackUrl: () => "https://example.test/?ticket=test",
    qrImageUrl: () => "data:image/png;base64,test",
    num: String,
    esc: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.printSecurityTickets(rows, {
    closed: false,
    document: { open() {}, write(value) { html = value; }, close() {} },
  });
  return html;
}

test("A6 print shows the correct driver phone on each ticket without changing QR size", () => {
  const html = render([
    { queue_no: "REG 1-1", phone_number: "081234567890" },
    { queue_no: "REG 1-2", phone_number: "6289876543210" },
  ]);
  const cards = html.split('<div class="ticket">').slice(1);
  assert.equal(cards.length, 2);
  assert.match(cards[0], /No\. Telp Driver<\/b><span>081234567890<\/span>/);
  assert.doesNotMatch(cards[0], /6289876543210/);
  assert.match(cards[1], /No\. Telp Driver<\/b><span>6289876543210<\/span>/);
  assert.match(html, /size: 105mm 148mm; margin: 5mm/);
  assert.match(html, /width: 34mm; height: 34mm/);
});

test("print supports driver_phone and missing phone on older tickets", () => {
  assert.match(render([{ phone_number: " ", driver_phone: "081111111111" }]), /<span>081111111111<\/span>/);
  assert.match(render([{}]), /No\. Telp Driver<\/b><span>-<\/span>/);
});

test("print escapes phone values instead of rendering injected HTML", () => {
  const html = render([{ phone_number: '<img src=x onerror="alert(1)">' }]);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
});
