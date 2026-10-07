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
// - copies onnxruntime's WASM runtime, so nothing is fetched from a CDN
// - copies the bundled models listed in models/models.json ("bundled": true)
// - --personal: uses your fine-tuned hiragana model from
//   personal/models/distilhubert-hiragana (tools/finetune-hiragana.py) and marks
//   the build as personal; tools/package.mjs refuses to publish it
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
}

await build();
console.log(`built ${OUT}`);
