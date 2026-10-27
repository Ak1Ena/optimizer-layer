import { createUser } from './user.mjs';

export function serialize(users) {
  return JSON.stringify(users.map(user => ({ id: user.id, name: user.name, email: user.email, nickname: user.nickname })));
}

export function load(text) {
  return JSON.parse(text).map(createUser);
}
