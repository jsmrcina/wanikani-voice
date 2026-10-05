// Minimal ZIP reader for custom model files (.wkv-model.zip): stored and
// deflated entries, no zip64. Runs in the settings page, the background page
// and workers. Classic script: attaches WKV.zip.
(function (WKV) {
  'use strict';

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Returns Map(path -> Uint8Array). Throws on anything it can't read.
  async function read(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // End of central directory: last 22+ bytes, signature 0x06054b50.
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();
    const files = new Map();
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory');
      const method = view.getUint16(p + 10, true);
      const compressed = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const local = view.getUint32(p + 42, true);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`corrupt zip entry ${name}`);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + compressed);
      if (method === 0) files.set(name, data);
      else if (method === 8) files.set(name, await inflateRaw(data));
      else throw new Error(`unsupported compression in ${name}`);
    }
    return files;
  }

  WKV.zip = { read };
})(globalThis.WKV = globalThis.WKV || {});
