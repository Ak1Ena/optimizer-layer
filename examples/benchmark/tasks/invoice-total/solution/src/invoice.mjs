const exact = line => line.unitCents * line.quantity * (1 - line.discountPercent / 100);

export function lineTotal(line) {
  return Math.round(exact(line));
}

// The total is the sum of the printed (rounded) line amounts; see docs/decisions.md.
export function invoiceTotal(lines) {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}
