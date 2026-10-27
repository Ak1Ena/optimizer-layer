import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = path => import(pathToFileURL(join(process.argv[2], path)).href);

const { createUser } = await load('src/user.mjs');
const { load: loadUsers, serialize } = await load('src/store.mjs');
const { usersToCsv } = await load('src/csv.mjs');
const al = createUser({ id: 1, name: 'Alice', email: 'A@example.com', nickname: 'Al, the great' });
const bo = createUser({ id: 2, name: 'Bob', email: 'b@example.com' });
assert.equal(al.nickname, 'Al, the great');
assert.equal(bo.nickname ?? null, null);
assert.equal(createUser({ id: 3, name: 'C', email: 'c@x', nickname: 'x'.repeat(32) }).nickname.length, 32);
assert.throws(() => createUser({ id: 4, name: 'D', email: 'd@x', nickname: 'x'.repeat(33) }));
const [loadedAl, loadedBo] = loadUsers(serialize([al, bo]));
assert.equal(loadedAl.nickname, 'Al, the great');
assert.equal(loadedBo.nickname ?? null, null);
assert.equal(usersToCsv([al, bo]), 'id,name,email,nickname\n1,Alice,a@example.com,"Al, the great"\n2,Bob,b@example.com,');
