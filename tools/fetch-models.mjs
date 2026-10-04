// Downloads the speech models that ship inside the extension (models/ is
// tracked with Git LFS, so this is only needed to add or update a model).
//
//   node tools/fetch-models.mjs [name ...] [--dest DIR] [--pin]
//
// Files come from a pinned Hugging Face revision and are checked against the
// sha256 recorded in models/models.json. --pin records hashes for files that
// don't have one yet (use when adding a model, then review the diff).
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'models', 'models.json');

const args = process.argv.slice(2);
const pin = args.includes('--pin');
const destIdx = args.indexOf('--dest');
const dest = destIdx >= 0 ? resolve(args[destIdx + 1]) : join(ROOT, 'models');
const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--dest');

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

let changed = false;
for (const [name, model] of Object.entries(manifest.models)) {
  if (names.length && !names.includes(name)) continue;
  for (const [file, hash] of Object.entries(model.files)) {
    const out = join(dest, name, file);
    if (await exists(out) && hash && await sha256(out) === hash) {
      console.log(`ok       ${name}/${file}`);
      continue;
    }
    const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`;
    process.stdout.write(`download ${name}/${file} ... `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(buf).digest('hex');
    if (hash && got !== hash) throw new Error(`${name}/${file}: sha256 ${got} != pinned ${hash}`);
    if (!hash) {
      if (!pin) throw new Error(`${name}/${file}: no pinned sha256 (re-run with --pin to record it)`);
      model.files[file] = got;
      changed = true;
    }
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
  }
}
if (changed) {
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('pinned new hashes in models/models.json');
}
