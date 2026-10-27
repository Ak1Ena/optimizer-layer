const exact = line => line.unitCents * line.quantity * (1 - line.discountPercent / 100);

export function lineTotal(line) {
  return Math.floor(exact(line));
}

export function invoiceTotal(lines) {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}
