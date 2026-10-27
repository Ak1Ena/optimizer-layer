const exact = line => line.unitCents * line.quantity * (1 - line.discountPercent / 100);

export function lineTotal(line) {
  return Math.round(exact(line));
}

export function invoiceTotal(lines) {
  return Math.round(lines.reduce((sum, line) => sum + exact(line), 0));
}
