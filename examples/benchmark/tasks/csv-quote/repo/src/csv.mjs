export function toCsvRow(fields) {
  return fields.map(String).join(',');
}
