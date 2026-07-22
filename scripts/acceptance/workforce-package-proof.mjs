import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, relative } from 'node:path';

export const acceptancePackageSourceEnv = 'AGENTWORKFORCE_ACCEPTANCE_PACKAGE_SOURCE';
export const acceptancePackageSourceModes = Object.freeze({
  localPack: 'local-pack',
  publishedInstalled: 'published-installed',
});

export function resolveAcceptancePackageSourceMode(value = process.env[acceptancePackageSourceEnv]) {
  if (value === undefined || value === '') return acceptancePackageSourceModes.localPack;
  if (Object.values(acceptancePackageSourceModes).includes(value)) return value;
  throw new Error(
    `Unsupported ${acceptancePackageSourceEnv}=${value}. Expected ${acceptancePackageSourceModes.localPack} or ${acceptancePackageSourceModes.publishedInstalled}.`,
  );
}

export function resolveRequiredWorkforcePackageNames({ workforceRoot, agentsPackage }) {
  const packageMap = collectWorkforcePackageMap(workforceRoot);
  const required = new Set(['agentworkforce']);
  const queue = [
    ...Object.keys(agentsPackage.dependencies ?? {}),
    ...Object.keys(agentsPackage.devDependencies ?? {}),
    ...Object.keys(agentsPackage.overrides ?? {}),
  ].filter((name) => packageMap.has(name));

  for (const name of queue) required.add(name);

  while (queue.length > 0) {
    const current = queue.shift();
    const manifest = packageMap.get(current)?.manifest;
    if (!manifest) continue;
    for (const depName of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]) {
      if (!packageMap.has(depName) || required.has(depName)) continue;
      required.add(depName);
      queue.push(depName);
    }
  }

  return [...required].sort();
}

export function resolveExpectedPublishedVersions({ workforceRoot, agentsPackage }) {
  const packageMap = collectWorkforcePackageMap(workforceRoot);
  return Object.fromEntries(
    resolveRequiredWorkforcePackageNames({ workforceRoot, agentsPackage }).map((name) => [
      name,
      packageMap.get(name)?.manifest.version ?? null,
    ]),
  );
}

export function createLocalPackWorkforceProof({
  taskRoot,
  workforceRoot,
  artifactRoot,
  agentsPackage,
}) {
  const packageMap = collectWorkforcePackageMap(workforceRoot);
  const requiredPackageNames = resolveRequiredWorkforcePackageNames({ workforceRoot, agentsPackage });
  const producerRoot = resolve(artifactRoot, 'producer-artifacts');
  const tarballRoot = resolve(producerRoot, 'tarballs');
  const integrationRoot = resolve(producerRoot, 'integration-workspace');
  const manifestPath = resolve(producerRoot, 'local-package-proof.json');
  const installLogPath = resolve(producerRoot, 'local-package-proof.install.txt');
  const integrationPackageJsonPath = resolve(integrationRoot, 'package.json');
  const integrationPackageLockPath = resolve(integrationRoot, 'package-lock.json');
  const workforceCommit = readGitHead(workforceRoot);

  rmSync(producerRoot, { recursive: true, force: true });
  mkdirSync(tarballRoot, { recursive: true });
  mkdirSync(integrationRoot, { recursive: true });

  const producerArtifacts = requiredPackageNames.map((name) => {
    const pkg = packageMap.get(name);
    if (!pkg) throw new Error(`Missing Workforce package metadata for ${name}.`);
    const tarballPath = packWorkforcePackage(pkg.dir, tarballRoot);
    const tarballBuffer = readFileSync(tarballPath);
    return {
      name,
      version: pkg.manifest.version,
      sourceDir: relative(workforceRoot, pkg.dir),
      tarball: relative(taskRoot, tarballPath),
      sha256: createHash('sha256').update(tarballBuffer).digest('hex'),
      sizeBytes: statSync(tarballPath).size,
    };
  });

  const integrationManifest = {
    name: 'agentworkforce-local-package-proof',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(
      producerArtifacts.map((artifact) => [
        artifact.name,
        fileSpec(integrationRoot, resolve(taskRoot, artifact.tarball)),
      ]),
    ),
    overrides: Object.fromEntries(
      Object.entries(agentsPackage.overrides ?? {}).filter(([name]) => !packageMap.has(name)),
    ),
  };
  writeFileSync(integrationPackageJsonPath, JSON.stringify(integrationManifest, null, 2) + '\n');

  const installArgs = ['install', '--ignore-scripts', '--package-lock=true'];
  const install = runCommand(installArgs, { cwd: integrationRoot });
  writeFileSync(
    installLogPath,
    [
      `$ (cd ${relative(taskRoot, integrationRoot)} && ${['npm', ...installArgs].join(' ')})`,
      install.stdout.trim(),
      install.stderr.trim(),
    ].filter(Boolean).join('\n') + '\n',
  );

  if (install.status === 0) {
    syncInstalledPackagesIntoTaskRoot({
      taskRoot,
      integrationRoot,
      requiredPackageNames,
    });
  }

  const lock = readOptionalJson(integrationPackageLockPath);
  const installedCopies = Object.fromEntries(
    producerArtifacts.map((artifact) => {
      const sourceDir = resolve(integrationRoot, 'node_modules', ...artifact.name.split('/'));
      const targetDir = resolve(taskRoot, 'node_modules', ...artifact.name.split('/'));
      const lockEntry = lock?.packages?.[`node_modules/${artifact.name}`];
      const expectedResolution = fileSpec(integrationRoot, resolve(taskRoot, artifact.tarball));
      const sourceDigest = hashDirectoryIfPresent(sourceDir);
      const targetDigest = hashDirectoryIfPresent(targetDir);
      return [
        artifact.name,
        {
          version: readInstalledPackageVersion(taskRoot, artifact.name),
          expectedResolution,
          resolved: lockEntry?.resolved ?? null,
          integrity: lockEntry?.integrity ?? null,
          sourceDigest,
          targetDigest,
          matchesProducerInstall:
            lockEntry?.resolved === expectedResolution
            && sourceDigest !== null
            && sourceDigest === targetDigest,
        },
      ];
    }),
  );
  const installedPackages = Object.fromEntries(
    Object.entries(installedCopies).map(([name, evidence]) => [name, evidence.version]),
  );
  const mismatches = producerArtifacts.flatMap((artifact) => {
    const installed = installedCopies[artifact.name];
    const problems = [];
    if (installed.version !== artifact.version) {
      problems.push(`${artifact.name}@${installed.version ?? 'missing'} != ${artifact.version}`);
    }
    if (installed.resolved !== installed.expectedResolution) {
      problems.push(`${artifact.name} lock resolution did not use its local tarball`);
    }
    if (!installed.matchesProducerInstall) {
      problems.push(`${artifact.name} installed-copy digest did not match the isolated tarball install`);
    }
    return problems;
  });
  const binPath = resolve(taskRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'agentworkforce.cmd' : 'agentworkforce');
  const binValidation = validateInstalledBin(binPath);

  const proof = {
    mode: acceptancePackageSourceModes.localPack,
    workforceCommit,
    installRoot: '.',
    integrationWorkspace: relative(taskRoot, integrationRoot),
    installCommand: `(cd ${relative(taskRoot, integrationRoot)} && ${['npm', ...installArgs].join(' ')})`,
    producerArtifacts,
    requiredPackages: requiredPackageNames,
    installedPackages,
    installedCopies,
    installedBin: relative(taskRoot, binPath),
    installedBinValidation: binValidation,
  };

  writeFileSync(manifestPath, JSON.stringify(proof, null, 2) + '\n');

  return {
    exitCode: install.status === 0 && mismatches.length === 0 && binValidation.ok ? 0 : 1,
    summary:
      install.status === 0 && mismatches.length === 0 && binValidation.ok
        ? `Packed and installed ${producerArtifacts.length} Workforce artifacts from ${workforceCommit}; lock resolutions and installed-copy digests match the local tarballs.`
        : `Local Workforce package proof failed: ${[
          install.status === 0 ? null : `npm install exited ${install.status}`,
          !binValidation.ok ? binValidation.error : null,
          ...mismatches,
        ].filter(Boolean).join(', ')}`,
    artifactRefs: [
      relative(taskRoot, manifestPath),
      relative(taskRoot, installLogPath),
      relative(taskRoot, integrationPackageJsonPath),
      ...producerArtifacts.map((artifact) => artifact.tarball),
    ],
    proof,
  };
}

export function createPublishedInstalledWorkforceProof({
  taskRoot,
  agentsPackage,
}) {
  const lockPath = resolve(taskRoot, 'package-lock.json');
  const lock = readJson(lockPath);
  const workforceVersion = agentsPackage.devDependencies?.agentworkforce ?? null;
  const relayHelpersVersion = agentsPackage.dependencies?.['@relayfile/relay-helpers'] ?? null;
  const requiredPackageNames = resolvePublishedInstalledPackageNames({ lock, agentsPackage });
  const expectedPackages = Object.fromEntries(
    requiredPackageNames.map((name) => [
      name,
      name === '@relayfile/relay-helpers' ? relayHelpersVersion : workforceVersion,
    ]),
  );
  const installedPackages = Object.fromEntries(
    requiredPackageNames.map((name) => [name, readInstalledPackageVersion(taskRoot, name)]),
  );
  const declaredPackages = Object.fromEntries(
    requiredPackageNames
      .map((name) => [
        name,
        agentsPackage.dependencies?.[name]
          ?? agentsPackage.devDependencies?.[name]
          ?? agentsPackage.overrides?.[name]
          ?? null,
      ])
      .filter(([, version]) => version !== null),
  );
  const installedCopies = Object.fromEntries(
    requiredPackageNames.map((name) => {
      const lockEntry = lock.packages?.[`node_modules/${name}`] ?? null;
      const installedDir = resolve(taskRoot, 'node_modules', ...name.split('/'));
      return [
        name,
        {
          version: installedPackages[name],
          lockVersion: lockEntry?.version ?? null,
          resolved: lockEntry?.resolved ?? null,
          integrity: lockEntry?.integrity ?? null,
          registryArtifact:
            typeof lockEntry?.resolved === 'string'
            && lockEntry.resolved.startsWith('https://registry.npmjs.org/')
            && typeof lockEntry.integrity === 'string'
            && lockEntry.integrity.length > 0,
          installedAsSymlink: existsSync(installedDir) && lstatSync(installedDir).isSymbolicLink(),
        },
      ];
    }),
  );
  const overlayEnvironment = Object.fromEntries(
    ['AGENTWORKFORCE_CLI_PATH', 'NODE_PATH', 'NODE_OPTIONS']
      .map((name) => [name, process.env[name]?.trim() || null]),
  );
  const mismatches = requiredPackageNames.flatMap((name) => {
    const problems = [];
    const expected = expectedPackages[name];
    const installed = installedPackages[name];
    if (expected === null || installed !== expected) {
      problems.push(`${name}@${installed ?? 'missing'} != expected ${expected ?? 'unknown'}`);
    }
    const declared = declaredPackages[name];
    if (declared !== undefined && declared !== expected) {
      problems.push(`${name} declaration ${declared} != expected exact version ${expected}`);
    }
    const installedCopy = installedCopies[name];
    if (installedCopy.lockVersion !== expected) {
      problems.push(`${name} lock version ${installedCopy.lockVersion ?? 'missing'} != expected ${expected ?? 'unknown'}`);
    }
    if (!installedCopy.registryArtifact) {
      problems.push(`${name} is not locked to an integrity-protected npm registry artifact`);
    }
    if (installedCopy.installedAsSymlink) {
      problems.push(`${name} is installed through a symlink instead of the published artifact`);
    }
    return problems;
  });
  for (const [name, value] of Object.entries(overlayEnvironment)) {
    if (value !== null) mismatches.push(`${name} must be unset for published-installed acceptance`);
  }
  const binPath = resolve(taskRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'agentworkforce.cmd' : 'agentworkforce');
  const binValidation = validateInstalledBin(binPath);
  const proof = {
    mode: acceptancePackageSourceModes.publishedInstalled,
    workforceCommit: null,
    installRoot: '.',
    lockfile: relative(taskRoot, lockPath),
    installCommand: null,
    producerArtifacts: [],
    requiredPackages: requiredPackageNames,
    expectedPackages,
    declaredPackages,
    installedPackages,
    installedCopies,
    overlayEnvironment,
    installedBin: relative(taskRoot, binPath),
    installedBinValidation: binValidation,
  };

  return {
    exitCode: mismatches.length === 0 && binValidation.ok ? 0 : 1,
    summary:
      mismatches.length === 0 && binValidation.ok
        ? `Validated ${requiredPackageNames.length} exact published package artifacts through the frozen npm lockfile and installed binary path with no symlink or environment overlays.`
        : `Published installed-package validation failed: ${[
          ...mismatches,
          !binValidation.ok ? binValidation.error : null,
        ].filter(Boolean).join(', ')}`,
    artifactRefs: [],
    proof,
  };
}

function resolvePublishedInstalledPackageNames({ lock, agentsPackage }) {
  const required = new Set(['agentworkforce', '@relayfile/relay-helpers']);
  const queue = [
    ...Object.keys(agentsPackage.dependencies ?? {}),
    ...Object.keys(agentsPackage.devDependencies ?? {}),
    ...Object.keys(agentsPackage.overrides ?? {}),
  ].filter((name) => name === 'agentworkforce' || name.startsWith('@agentworkforce/'));

  for (const name of queue) required.add(name);

  while (queue.length > 0) {
    const current = queue.shift();
    const lockEntry = lock.packages?.[`node_modules/${current}`];
    for (const depName of [
      ...Object.keys(lockEntry?.dependencies ?? {}),
      ...Object.keys(lockEntry?.optionalDependencies ?? {}),
    ]) {
      if (
        depName !== 'agentworkforce'
        && !depName.startsWith('@agentworkforce/')
      ) continue;
      if (required.has(depName)) continue;
      required.add(depName);
      queue.push(depName);
    }
  }

  return [...required].sort();
}

function collectWorkforcePackageMap(workforceRoot) {
  const packagesRoot = resolve(workforceRoot, 'packages');
  const dirs = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(packagesRoot, entry.name));
  return new Map(
    dirs.map((dir) => {
      const manifest = readJson(resolve(dir, 'package.json'));
      return [manifest.name, { dir, manifest }];
    }),
  );
}

function packWorkforcePackage(packageDir, tarballRoot) {
  const result = runCommand(['pack', '--pack-destination', tarballRoot], { cwd: packageDir, command: 'pnpm' });
  if (result.status !== 0) {
    throw new Error(`pnpm pack failed in ${packageDir}:\n${result.stdout}\n${result.stderr}`.trim());
  }
  const lines = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  const tarballPath = lines.find((line) => line.endsWith('.tgz') && existsSync(line));
  if (!tarballPath) {
    throw new Error(`pnpm pack did not report a tarball path for ${packageDir}.`);
  }
  return tarballPath;
}

function readInstalledPackageVersion(taskRoot, packageName) {
  try {
    return readJson(resolve(taskRoot, 'node_modules', ...packageName.split('/'), 'package.json')).version ?? null;
  } catch {
    return null;
  }
}

function readGitHead(cwd) {
  const result = runCommand(['rev-parse', 'HEAD'], { cwd, command: 'git' });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Unable to resolve Workforce producer commit: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function syncInstalledPackagesIntoTaskRoot({ taskRoot, integrationRoot, requiredPackageNames }) {
  for (const packageName of requiredPackageNames) {
    const sourceDir = resolve(integrationRoot, 'node_modules', ...packageName.split('/'));
    const targetDir = resolve(taskRoot, 'node_modules', ...packageName.split('/'));
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(resolve(targetDir, '..'), { recursive: true });
    cpSync(sourceDir, targetDir, { recursive: true });
  }

  const targetBin = resolve(taskRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'agentworkforce.cmd' : 'agentworkforce');
  rmSync(targetBin, { recursive: true, force: true });
  mkdirSync(resolve(targetBin, '..'), { recursive: true });
  if (process.platform === 'win32') {
    cpSync(resolve(integrationRoot, 'node_modules', '.bin', 'agentworkforce.cmd'), targetBin, { recursive: true });
  } else {
    symlinkSync('../agentworkforce/bin/agentworkforce.js', targetBin);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readOptionalJson(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function fileSpec(fromDir, targetPath) {
  return `file:${relative(fromDir, targetPath).replaceAll('\\', '/')}`;
}

function validateInstalledBin(binPath) {
  if (!existsSync(binPath)) {
    return { ok: false, error: `missing ${binPath}` };
  }
  if (process.platform === 'win32') {
    return { ok: true, kind: 'cmd-shim', target: null };
  }
  const stat = lstatSync(binPath);
  const target = stat.isSymbolicLink() ? readlinkSync(binPath) : null;
  return target === '../agentworkforce/bin/agentworkforce.js'
    ? { ok: true, kind: 'symlink', target }
    : { ok: false, error: `${binPath} is not the expected installed-package symlink`, kind: 'unexpected', target };
}

function hashDirectoryIfPresent(root) {
  if (!existsSync(root)) return null;
  const hash = createHash('sha256');
  const visit = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = resolve(dir, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        hash.update(`dir:\0${relativePath}\0`);
        visit(path, relativePath);
      } else if (stat.isSymbolicLink()) {
        hash.update(`link:\0${relativePath}\0${readlinkSync(path)}\0`);
      } else {
        hash.update(`file:\0${relativePath}\0`);
        hash.update(readFileSync(path));
        hash.update('\0');
      }
    }
  };
  visit(root);
  return `sha256:${hash.digest('hex')}`;
}

function runCommand(args, options = {}) {
  const command = options.command ?? 'npm';
  const [cmd, ...rest] = args;
  const result = spawnSync(command, command === 'npm' ? args : [cmd, ...rest], {
    cwd: options.cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
