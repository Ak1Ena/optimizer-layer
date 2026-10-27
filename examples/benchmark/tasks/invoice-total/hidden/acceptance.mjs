import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = path => import(pathToFileURL(join(process.argv[2], path)).href);

const { invoiceTotal, lineTotal } = await load('src/invoice.mjs');
const { printInvoice } = await load('src/print.mjs');
const line = (sku, unitCents, quantity, discountPercent) => ({ sku, unitCents, quantity, discountPercent });
// Line amounts must not change: nearest cent, halves up.
for (const [input, cents] of [[line('A', 333, 1, 50), 167], [line('B', 199, 3, 0), 597], [line('C', 1001, 1, 15), 851], [line('D', 5, 1, 10), 5], [line('E', 250, 2, 33), 335]]) {
  assert.equal(lineTotal(input), cents, `line ${input.sku}`);
}
const invoices = [
  [line('A', 333, 1, 50), line('B', 333, 1, 50)],
  [line('A', 333, 1, 50), line('B', 333, 1, 50), line('C', 333, 1, 50)],
  [line('C', 1001, 1, 15), line('D', 5, 1, 10), line('E', 250, 2, 33)],
  [],
];
for (const lines of invoices) assert.equal(invoiceTotal(lines), lines.reduce((sum, item) => sum + lineTotal(item), 0));
assert.equal(invoiceTotal(invoices[1]), 501);
assert.equal(printInvoice(invoices[0]), 'A 1.67\nB 1.67\nTOTAL 3.34');
