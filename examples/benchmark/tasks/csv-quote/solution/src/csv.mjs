const field = value => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function toCsvRow(fields) {
  return fields.map(field).join(',');
}
