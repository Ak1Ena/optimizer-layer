import assert from 'node:assert/strict';
import { createUser } from '../src/user.mjs';

assert.equal(createUser({ id: 1, name: 'Alice', email: 'a@example.com', nickname: 'Al' }).nickname, 'Al');
console.log('ok');
