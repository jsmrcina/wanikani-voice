// Packages the add-on for addons.mozilla.org (AMO).
//
//   npm run package [-- --verify] [--allow-dirty]
//
// Produces, in dist/:
//   voice-answers-for-wanikani-<version>.xpi         the add-on to upload
//   voice-answers-for-wanikani-<version>-source.zip  sources for AMO review
//   SHA256SUMS
//
// Steps: a clean normal build (never a personal one), the privacy policy
// check, `web-ext lint` (any error fails), the size limit, then the two
// archives. AMO requires sources plus build instructions whenever a
// submission contains bundled code (build/dist/asr-worker.js); the source
// zip holds every tracked file needed to rebuild, including the bundled
// models, and leaves out tests, personal data and node_modules.
// --verify rebuilds from the source zip in a temp folder (npm ci + build) and
// checks the result is identical to the packaged add-on, as a reviewer would.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const DIST = join(ROOT, 'dist');
const AMO_LIMIT = 200 * 1024 * 1024;
const args = process.argv.slice(2);

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts });
const step = msg => console.log(`\n== ${msg}`);
const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

// Minimal ZIP writer (deflate, no zip64: every file and the archive stay far
// below 4 GB). Fixed timestamps keep the archive reproducible.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// Tracked files a reviewer needs to rebuild: everything except tests,
// the private submodule and generated output.
function sourceFiles() {
  const tracked = run('git', ['ls-files', '-z', '--recurse-submodules=no']).split('\0').filter(Boolean);
  return tracked.filter(f => !/^(test\/|personal(\/|$)|build\/|dist\/|\.gitmodules$)/.test(f));
}

function sourceReadme(version, commit, dirty) {
  return `# Voice Answers for WaniKani ${version}: build instructions

Source for the submitted add-on, from commit ${commit}${dirty ? ' (with uncommitted changes)' : ''}.

## Requirements
- Node.js 22 or newer (built with ${process.version}), npm
- Any OS; the build is plain file copying plus one esbuild bundle

## Build
\`\`\`
npm ci
npm run build
\`\`\`
The add-on is written to \`build/\`; it is identical to the submitted package.

## What is bundled and why
- \`build/dist/asr-worker.js\` is the only generated code: \`src/worker/*.js\`
  bundled by esbuild (not minified) with the npm packages
  \`@huggingface/transformers\` 4.3.0 and \`onnxruntime-web\` (versions pinned in
  package-lock.json). Settings: tools/build.mjs.
- \`build/vendor/ort/\` is onnxruntime-web's WASM runtime, copied unmodified from
  node_modules/onnxruntime-web/dist.
- \`build/models/\` are speech models (ONNX), copied from \`models/\`; sources
  and licences in models/models.json and THIRD_PARTY_NOTICES.md. The extension
  loads them from inside the package; it makes no network requests
  (CSP connect-src 'self', no remote model hosts).
- Everything under \`src/\` other than \`src/worker/\` ships as-is.
`;
}

async function main() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  const base = `voice-answers-for-wanikani-${version}`;
  const dirty = run('git', ['status', '--porcelain', '--ignore-submodules=all']).trim() !== '';
  if (dirty && !args.includes('--allow-dirty')) {
    throw new Error('working tree has uncommitted changes; commit first (or pass --allow-dirty)');
  }
  const commit = run('git', ['rev-parse', 'HEAD']).trim();

  step(`clean build of ${version}`);
  await rm(BUILD, { recursive: true, force: true });
  run('node', ['tools/build.mjs'], { stdio: 'inherit' });
  if ((await readFile(join(BUILD, 'BUILD-INFO.txt'), 'utf8')).includes('PERSONAL')) {
    throw new Error('refusing to package a personal build');
  }

  step('privacy policy check');
  run('python3', ['test/policy.py'], { stdio: 'inherit' });

  step('web-ext lint');
  const lint = JSON.parse(execFileSync('npx', ['web-ext', 'lint', '-s', 'build', '--output', 'json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/^[^{]*/, ''));
  for (const [kind, list] of [['error', lint.errors], ['warning', lint.warnings]]) {
    for (const m of list) console.log(`  ${kind.padEnd(7)} ${m.code} ${m.file ?? ''}`);
  }
  console.log(`  ${lint.summary.errors} errors, ${lint.summary.warnings} warnings, ${lint.summary.notices} notices`);
  if (lint.summary.errors) throw new Error('web-ext lint reported errors');

  step('package');
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  run('npx', ['web-ext', 'build', '-s', 'build', '-a', DIST, '-n', `${base}.xpi`, '-o']);
  const xpi = join(DIST, `${base}.xpi`);
  const xpiSize = (await stat(xpi)).size;
  console.log(`  ${relative(ROOT, xpi)}  ${mb(xpiSize)}`);
  if (xpiSize > AMO_LIMIT) throw new Error(`package is over AMO's ${mb(AMO_LIMIT)} limit`);

  const files = sourceFiles();
  const entries = [];
  for (const f of files) entries.push({ name: f, data: await readFile(join(ROOT, f)) });
  entries.push({ name: 'SOURCE-README.md', data: Buffer.from(sourceReadme(version, commit, dirty)) });
  const srcZip = join(DIST, `${base}-source.zip`);
  await writeFile(srcZip, zip(entries));
  const srcSize = (await stat(srcZip)).size;
  console.log(`  ${relative(ROOT, srcZip)}  ${mb(srcSize)} (${entries.length} files)`);
  if (srcSize > AMO_LIMIT) throw new Error(`source archive is over AMO's ${mb(AMO_LIMIT)} limit`);
  for (const f of files) {
    if (/\.(onnx|json)$/.test(f) && f.startsWith('models/') && (await readFile(join(ROOT, f))).subarray(0, 40).toString().startsWith('version https://git-lfs')) {
      throw new Error(`${f} is a Git LFS pointer, not the file: run git lfs pull`);
    }
  }

  const sums = [];
  for (const f of [xpi, srcZip]) sums.push(`${await sha256(f)}  ${relative(DIST, f)}`);
  await writeFile(join(DIST, 'SHA256SUMS'), `${sums.join('\n')}\n`);

  if (args.includes('--verify')) {
    step('verify: rebuild from the source archive');
    const tmp = await mkdtemp(join(tmpdir(), 'wkv-verify-'));
    try {
      execFileSync('unzip', ['-q', srcZip, '-d', tmp]);
      execFileSync('npm', ['ci', '--silent'], { cwd: tmp, stdio: 'inherit' });
      execFileSync('node', ['tools/build.mjs'], { cwd: tmp, stdio: 'inherit' });
      const mine = (await walk(BUILD)).map(f => relative(BUILD, f)).sort();
      const theirs = (await walk(join(tmp, 'build'))).map(f => relative(join(tmp, 'build'), f)).sort();
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) throw new Error('rebuilt file list differs');
      for (const f of mine) {
        if (await sha256(join(BUILD, f)) !== await sha256(join(tmp, 'build', f))) throw new Error(`rebuilt ${f} differs`);
      }
      console.log(`  identical: ${mine.length} files`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  console.log(`\nUpload ${relative(ROOT, xpi)} to https://addons.mozilla.org/developers/ and,`);
  console.log(`when asked for sources, ${relative(ROOT, srcZip)}.`);
}

main().catch(err => {
  console.error(`\npackage failed: ${err.message}`);
  process.exit(1);
});
