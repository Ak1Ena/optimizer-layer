export function createUser({ id, name, email, nickname }) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('name is required');
  if (typeof email !== 'string' || !email.includes('@')) throw new TypeError('email is invalid');
  if (nickname !== undefined && nickname !== null && (typeof nickname !== 'string' || nickname.length > 32)) throw new TypeError('nickname must be a string of at most 32 characters');
  return { id, name: name.trim(), email: email.toLowerCase(), ...(typeof nickname === 'string' ? { nickname } : {}) };
}
