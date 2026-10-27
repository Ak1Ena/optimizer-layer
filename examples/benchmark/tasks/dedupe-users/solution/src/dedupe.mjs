// Rules in docs/decisions.md: trimmed case-insensitive email; keep the earliest signup, in input order.
export function dedupeUsers(users) {
  const key = user => user.email.trim().toLowerCase();
  const earliest = new Map();
  for (const user of users) {
    const kept = earliest.get(key(user));
    if (!kept || Date.parse(user.createdAt) < Date.parse(kept.createdAt)) earliest.set(key(user), user);
  }
  const keep = new Set(earliest.values());
  return users.filter(user => keep.has(user));
}
