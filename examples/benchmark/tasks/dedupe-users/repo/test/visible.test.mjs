import assert from 'node:assert/strict';
import { dedupeUsers } from '../src/dedupe.mjs';

const users = [
  { id: 1, email: 'ann@example.com', createdAt: '2026-01-01T00:00:00Z' },
  { id: 2, email: 'Ann@Example.com', createdAt: '2026-01-02T00:00:00Z' },
];
assert.equal(dedupeUsers(users).length, 1);
console.log('ok');
