import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

for (const name of readdirSync('packages').sort()) {
  const directory = join('packages', name);
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const compiled = join('dist', name, 'src');
  const staged = join('dist', 'npm', name);
  mkdirSync(staged, { recursive: true });
  cpSync(compiled, join(directory, 'dist'), { recursive: true });
  cpSync(compiled, join(staged, 'dist'), { recursive: true });
  for (const file of manifest.files) {
    if (file === 'dist') continue;
    cpSync(join(directory, file), join(staged, file), { recursive: true });
  }
  for (const entry of Object.values(manifest.exports ?? {})) {
    if (typeof entry === 'object' && entry !== null) delete entry.development;
  }
  for (const path of Object.values(manifest.bin ?? {})) {
    chmodSync(resolve(staged, path), 0o755);
    chmodSync(resolve(directory, path), 0o755);
  }
  cpSync('LICENSE', join(staged, 'LICENSE'));
  writeFileSync(join(staged, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`Staged ${manifest.name} in ${staged}\n`);
}
