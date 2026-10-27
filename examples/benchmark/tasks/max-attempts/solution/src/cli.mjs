import { loadConfig } from './config.mjs';

export function parseArgs(argv) {
  const raw = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--max-attempts') raw.maxAttempts = Number(argv[++index]);
    else if (argv[index] === '--timeout-ms') raw.timeoutMs = Number(argv[++index]);
  }
  return loadConfig(raw);
}
