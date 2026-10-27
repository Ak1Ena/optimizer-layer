import { invoiceTotal, lineTotal } from './invoice.mjs';

const money = cents => (cents / 100).toFixed(2);

export function printInvoice(lines) {
  return [...lines.map(line => `${line.sku} ${money(lineTotal(line))}`), `TOTAL ${money(invoiceTotal(lines))}`].join('\n');
}
