import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.mjs';

assert.equal(parseArgs(['--max-attempts', '3']).maxAttempts, 3);
console.log('ok');
