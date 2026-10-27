import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = path => import(pathToFileURL(join(process.argv[2], path)).href);

const { dedupeUsers } = await load('src/dedupe.mjs');
const user = (id, email, day) => ({ id, email, createdAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z` });
const ids = users => dedupeUsers(users).map(item => item.id);
assert.deepEqual(ids([user(1, 'ann@example.com', 1), user(2, 'Ann@Example.com', 2)]), [1]);
assert.deepEqual(ids([user(1, 'bob@example.com', 5), user(2, 'ann@example.com', 3), user(3, ' BOB@example.com ', 2)]), [2, 3]);
assert.deepEqual(ids([user(1, 'a@x', 1), user(2, 'b@x', 2), user(3, 'c@x', 3)]), [1, 2, 3]);
assert.deepEqual(ids([]), []);
