export function createUser({ id, name, email }) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('name is required');
  if (typeof email !== 'string' || !email.includes('@')) throw new TypeError('email is invalid');
  return { id, name: name.trim(), email: email.toLowerCase() };
}
