export function dedupeUsers(users) {
  const seen = new Set();
  return users.filter(user => !seen.has(user.email) && seen.add(user.email));
}
