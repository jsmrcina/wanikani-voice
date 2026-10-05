// Packages the add-on for addons.mozilla.org (AMO).
//
//   npm run package [-- --verify] [--sign [--listed]] [--allow-dirty]
//
// Produces, in dist/:
//   voice-answers-for-wanikani-<version>.xpi         the add-on (unsigned)
//   voice-answers-for-wanikani-<version>-source.zip  sources for AMO review
//   voice-answers-for-wanikani-<version>-signed.xpi  with --sign: installable in
//                                                    release Firefox
//   SHA256SUMS
//
// --sign submits the package to AMO on the *unlisted* channel (automated
// review, then signed for self-distribution; not shown on the public store)
// via `web-ext sign`, uploading the source zip with it. It needs AMO API
// credentials (https://addons.mozilla.org/developers/addon/api/key/) in
// ~/.config/wanikani-voice/amo-credentials as {"issuer": "...", "secret": "..."}
// (mode 600). They go to web-ext through its environment variables, never on
// a command line. AMO signs each version once: bump the version to re-sign.
// Personal builds are never packaged, so a voice-tuned model is never uploaded.
//
// --listed (with --sign) submits to the *listed* channel instead: the public
// store, with the listing text from store/amo-metadata.json (see
// store/LISTING.md). Listed versions wait in AMO's review queue, so no signed
// file is downloaded; it's published on the store once approved.
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
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './lib/zip.mjs';

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

// Tracked files a reviewer needs to rebuild: everything except tests,
// the private submodule and generated output.
function sourceFiles() {
  const tracked = run('git', ['ls-files', '-z'], { maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
  return tracked.filter(f => !/^(test\/|personal(\/|$)|build\/|dist\/|store\/screenshots\/|\.gitmodules$)/.test(f));
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
  // Replace only this script's outputs (dist/ may also hold packed models).
  // Signed packages are kept: AMO signs each version once, so they can't be
  // recreated.
  await mkdir(DIST, { recursive: true });
  for (const f of await readdir(DIST)) {
    if (f.endsWith('-signed.xpi')) continue;
    if (f.startsWith('voice-answers-for-wanikani-') || f === 'SHA256SUMS' || f === 'signed') {
      await rm(join(DIST, f), { recursive: true, force: true });
    }
  }
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

  const listed = args.includes('--listed');
  if (listed && !args.includes('--sign')) throw new Error('--listed needs --sign');
  if (args.includes('--sign')) {
    step(`sign (AMO, ${listed ? 'listed' : 'unlisted'} channel)`);
    const credFile = join(homedir(), '.config/wanikani-voice/amo-credentials');
    const cred = JSON.parse(await readFile(credFile, 'utf8').catch(() => {
      throw new Error(`no AMO credentials in ${credFile} (see the comment at the top of tools/package.mjs)`);
    }));
    if (((await stat(credFile)).mode & 0o077) !== 0) throw new Error(`${credFile} must not be readable by others (chmod 600)`);
    const signedDir = join(DIST, 'signed');
    const channelArgs = listed
      ? ['--channel', 'listed', '--amo-metadata', join(ROOT, 'store/amo-metadata.json'), '--approval-timeout', '0']
      : ['--channel', 'unlisted', '--approval-timeout', String(30 * 60 * 1000)];
    execFileSync('npx', ['web-ext', 'sign', '-s', 'build', '-a', signedDir, ...channelArgs,
      '--upload-source-code', srcZip], {
      cwd: ROOT, stdio: 'inherit',
      env: { ...process.env, WEB_EXT_API_KEY: cred.issuer, WEB_EXT_API_SECRET: cred.secret },
    });
    if (listed) {
      console.log('  submitted to the listed channel: it appears on addons.mozilla.org once Mozilla approves it');
      await rm(signedDir, { recursive: true, force: true });
    } else {
      const produced = (await readdir(signedDir)).filter(f => f.endsWith('.xpi'));
      if (produced.length !== 1) throw new Error(`expected one signed .xpi in ${signedDir}, found ${produced.length}`);
      const signed = join(DIST, `${base}-signed.xpi`);
      await writeFile(signed, await readFile(join(signedDir, produced[0])));
      await rm(signedDir, { recursive: true, force: true });
      sums.push(`${await sha256(signed)}  ${relative(DIST, signed)}`);
      await writeFile(join(DIST, 'SHA256SUMS'), `${sums.join('\n')}\n`);
      console.log(`  ${relative(ROOT, signed)}: install it from about:addons (gear menu > Install Add-on From File)`);
    }
  }

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

  if (listed) {
    console.log('\nSubmitted to AMO (listed). Add screenshots in the Developer Hub; see store/LISTING.md.');
  } else if (args.includes('--sign')) {
    console.log(`\nSubmitted to AMO (unlisted) and signed: ${relative(ROOT, join(DIST, `${base}-signed.xpi`))}.`);
  } else {
    console.log(`\nUpload ${relative(ROOT, xpi)} to https://addons.mozilla.org/developers/ and,`);
    console.log(`when asked for sources, ${relative(ROOT, srcZip)}. Or run with --sign.`);
  }
}

main().catch(err => {
  console.error(`\npackage failed: ${err.message}`);
  process.exit(1);
});
