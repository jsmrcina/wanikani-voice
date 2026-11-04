// Assembles the loadable extension in build/ (load build/manifest.json in
// about:debugging, or package it with `npx web-ext build -s build`).
//
//   node tools/build.mjs [--target firefox|chrome] [--personal]
//
// --target chrome writes build-chrome/ instead (load it as an unpacked
// extension in chrome://extensions): the same code with a Chrome manifest
// (service worker, offscreen document for the speech worker, PNG icons), see
// chromeManifest() below and PLAN.md, Phase 7.
//
// - copies manifest, src/, icons/ (and inlines the icon into the indicator)
// - bundles the speech worker (transformers.js + onnxruntime-web) with esbuild
// - copies onnxruntime's WASM runtime, so nothing is fetched from a CDN, and
//   fails if a CDN URL is left in any built script
// - copies the bundled models listed in models/models.json ("bundled": true)
// - --personal: uses your fine-tuned hiragana model from
//   personal/models/distilhubert-hiragana (tools/finetune-hiragana.py) and marks
//   the build as personal; tools/package.mjs refuses to publish it
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argTarget = process.argv.indexOf('--target');
export const TARGET = argTarget >= 0 ? process.argv[argTarget + 1] : 'firefox';
if (!['firefox', 'chrome'].includes(TARGET)) throw new Error(`unknown --target ${TARGET}`);
const OUT = join(ROOT, TARGET === 'chrome' ? 'build-chrome' : 'build');
// Files only one browser needs (paths relative to the repository root).
const ONLY = {
  chrome: ['src/offscreen', 'src/background/service-worker.js', 'src/background/offscreen-host.js',
    'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png'],
  firefox: [],
};
const OTHER = TARGET === 'chrome' ? 'firefox' : 'chrome';
const skipped = path => ONLY[OTHER].some(f => path === join(ROOT, f) || path.startsWith(join(ROOT, f) + '/'));

// The Chrome manifest, derived from the Firefox one so the two can't drift.
function chromeManifest(manifest) {
  const m = structuredClone(manifest);
  delete m.browser_specific_settings; // gecko id, data_collection_permissions
  m.background = { service_worker: 'src/background/service-worker.js' };
  m.permissions = [...m.permissions, 'offscreen'];
  // runtime.getContexts (used to find the offscreen document) needs 116.
  m.minimum_chrome_version = '116';
  const icons = Object.fromEntries([16, 32, 48, 128].map(s => [String(s), `icons/icon-${s}.png`]));
  m.icons = icons;
  m.action.default_icon = icons;
  return m;
}
const ORT = join(ROOT, 'node_modules/onnxruntime-web/dist');
// Only onnxruntime's plain WASM build (14 MB) ships. transformers.js imports
// the WebGPU-capable entry, whose "asyncify" runtime is 27 MB; Firefox here
// has no WebGPU, so the bundle maps that import to the WASM-only entry.
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

// transformers.js points onnxruntime at jsDelivr unless wasmPaths is already
// set when it loads. asr-worker.js sets them to vendor/ort/ right after the
// import, so that default was never used, but the Chrome Web Store rejects
// any CDN URL in the package as remotely hosted code (0.4.7, 2026-11-04).
// The default is rewritten to the bundled folder instead.
const ORT_CDN = '`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNX_ENV.versions.web}/dist/`';
const ORT_LOCAL = 'new URL("../vendor/ort/", self.location.href).href';
const noOrtCdn = {
  name: 'no-ort-cdn',
  setup(b) {
    b.onLoad({ filter: /[\\/]@huggingface[\\/]transformers[\\/].*\.m?js$/ }, async args => {
      const code = await readFile(args.path, 'utf8');
      return { contents: code.replaceAll(ORT_CDN, ORT_LOCAL), loader: 'js' };
    });
  },
};
// Script hosts that must never appear in a built script (checked after every build).
const CDN_HOSTS = /\b(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|cdn\.skypack\.dev|ajax\.googleapis\.com|esm\.run)\b/;

async function checkNoCdn() {
  const files = (await readdir(OUT, { recursive: true, withFileTypes: true }))
    .filter(e => e.isFile() && /\.(m?js|html)$/.test(e.name))
    .map(e => join(e.parentPath, e.name));
  for (const f of files) {
    const lines = (await readFile(f, 'utf8')).split('\n');
    const i = lines.findIndex(l => CDN_HOSTS.test(l));
    if (i >= 0) throw new Error(`${f.slice(OUT.length + 1)}:${i + 1}: CDN URL in the build: ${lines[i].trim().slice(0, 120)}`);
  }
}

async function sameFile(a, b) {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.size === sb.size && sa.mtimeMs <= sb.mtimeMs;
  } catch {
    return false;
  }
}

async function copyIfChanged(from, to) {
  if (await sameFile(from, to)) return;
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { preserveTimestamps: true });
}

export async function build() {
  // Sources are small: always replace them so deleted files don't linger.
  for (const dir of ['src', 'icons']) await rm(join(OUT, dir), { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  await writeFile(join(OUT, 'manifest.json'),
    `${JSON.stringify(TARGET === 'chrome' ? chromeManifest(manifest) : manifest, null, 2)}\n`);
  // src/worker is bundled below rather than copied.
  await cp(join(ROOT, 'src'), join(OUT, 'src'), {
    recursive: true, filter: p => !p.startsWith(join(ROOT, 'src/worker')) && !skipped(p),
  });
  await cp(join(ROOT, 'icons'), join(OUT, 'icons'), { recursive: true, filter: p => !skipped(p) });

  // Inline the icon into the indicator, so the page never has to load a
  // file from the extension (that would need web_accessible_resources).
  const icon = (await readFile(join(ROOT, 'icons/icon.svg'), 'utf8')).trim();
  const indicator = join(OUT, 'src/content/indicator.js');
  const src = await readFile(indicator, 'utf8');
  const marker = "  const ICON_SVG = '';";
  if (!src.includes(marker)) throw new Error('indicator.js: ICON_SVG marker not found');
  await writeFile(indicator, src.replace(marker, `  const ICON_SVG = ${JSON.stringify(icon)};`));

  await esbuild.build({
    entryPoints: [join(ROOT, 'src/worker/asr-worker.js')],
    outfile: join(OUT, 'dist/asr-worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: TARGET === 'chrome' ? 'chrome116' : 'firefox140',
    // Readable output: AMO reviewers must be able to compare it with the
    // published library sources.
    minify: false,
    legalComments: 'inline',
    alias: { 'onnxruntime-web/webgpu': 'onnxruntime-web/wasm' },
    plugins: [noOrtCdn],
    logLevel: 'warning',
  });

  for (const f of ORT_FILES) await copyIfChanged(join(ORT, f), join(OUT, 'vendor/ort', f));

  // After a personal build, force the generic model back: the tuned one has
  // the same size, so the size/mtime check below wouldn't replace it.
  const previous = await readFile(join(OUT, 'BUILD-INFO.txt'), 'utf8').catch(() => '');
  if (previous.includes('PERSONAL BUILD')) {
    await rm(join(OUT, 'models/distilhubert-hiragana'), { recursive: true, force: true });
  }
  const { models } = JSON.parse(await readFile(join(ROOT, 'models/models.json'), 'utf8'));
  for (const [name, model] of Object.entries(models)) {
    // A model that's no longer bundled mustn't linger from an earlier build.
    if (!model.bundled) {
      await rm(join(OUT, 'models', name), { recursive: true, force: true });
      continue;
    }
    for (const file of Object.keys(model.files)) {
      await copyIfChanged(join(ROOT, 'models', name, file), join(OUT, 'models', name, file));
    }
    // Nor a file it no longer lists (e.g. after a change of precision).
    const built = await readdir(join(OUT, 'models', name), { recursive: true, withFileTypes: true });
    for (const entry of built.filter(e => e.isFile())) {
      const file = join(entry.parentPath, entry.name).slice(join(OUT, 'models', name).length + 1);
      if (!(file in model.files)) await rm(join(OUT, 'models', name, file));
    }
  }
  const personal = process.argv.includes('--personal');
  if (personal) {
    const tuned = join(ROOT, 'personal/models/distilhubert-hiragana');
    for (const file of ['config.json', 'onnx/model_quantized.onnx']) {
      await cp(join(tuned, file), join(OUT, 'models/distilhubert-hiragana', file));
    }
  }
  await writeFile(join(OUT, 'BUILD-INFO.txt'),
    'Generated by tools/build.mjs from the repository root. Do not edit.\n' +
    (personal ? 'PERSONAL BUILD: contains a model fine-tuned on one person\'s voice. Do not publish.\n' : ''));
  await checkNoCdn();
}

await build();
console.log(`built ${OUT}`);
