const columns = ['id', 'name', 'email'];

const field = value => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function usersToCsv(users) {
  return [columns.join(','), ...users.map(user => columns.map(column => field(user[column])).join(','))].join('\n');
}
