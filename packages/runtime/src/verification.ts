import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Check } from './types.ts';
import type { parseChecks } from './schema.ts';

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function registerArtifacts(projectRoot: string, check: ReturnType<typeof parseChecks>[number]): Check {
  const { artifactFiles, ...definition } = check;
  const paths = new Set(artifactFiles.map(path => resolve(projectRoot, path)));
  const executable = resolve(projectRoot, check.argv[0]);
  if (executable !== process.execPath && existsSync(executable) && lstatSync(executable).isFile()) {
    paths.add(executable);
  }
  let scriptFound = false;
  for (const argument of check.argv.slice(1)) {
    const path = resolve(projectRoot, argument);
    if (!existsSync(path) || !lstatSync(path).isFile()) continue;
    const child = relative(projectRoot, path);
    const outsideProject = child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child);
    if (!scriptFound || outsideProject) paths.add(path);
    scriptFound = true;
  }
  const artifacts = [...paths].map(path => {
    if (realpathSync(path) !== path || lstatSync(path).isSymbolicLink()) throw new Error('Verifier artifact must not be a symlink');
    if (lstatSync(path).size > 4 * 1024 * 1024) throw new Error('Verifier artifact exceeds 4 MiB');
    return { path, digest: fileDigest(path) };
  });
  return { ...definition, artifacts };
}

export function artifactsCurrent(check: Check): boolean {
  return check.artifacts.every(artifact => {
    try {
      return realpathSync(artifact.path) === artifact.path && fileDigest(artifact.path) === artifact.digest;
    } catch {
      return false;
    }
  });
}
