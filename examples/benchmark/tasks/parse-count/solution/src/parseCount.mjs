export function parseCount(value) {
  const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) return count;
  throw new RangeError(`Invalid count: ${String(value)}`);
}
