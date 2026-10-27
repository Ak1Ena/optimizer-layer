import assert from 'node:assert/strict';
import { invoiceTotal, lineTotal } from '../src/invoice.mjs';

const lines = [
  { sku: 'A', unitCents: 333, quantity: 1, discountPercent: 50 },
  { sku: 'B', unitCents: 333, quantity: 1, discountPercent: 50 },
];
assert.equal(invoiceTotal(lines), lines.reduce((sum, line) => sum + lineTotal(line), 0));
console.log('ok');
