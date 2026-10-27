export function dedupeUsers(users) {
  const seen = new Set();
  return users.filter(user => {
    const key = user.email.trim().toLowerCase();
    return !seen.has(key) && seen.add(key);
  });
}
