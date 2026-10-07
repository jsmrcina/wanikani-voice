// Audio on the wire between extension contexts. Firefox passes typed arrays
// through runtime messages, but Chrome serialises messages as JSON, which
// turns a Float32Array into an object of numbered keys. So a clip travels as
// base64 of its raw bytes (~130 KB for a 1.5 s, 16 kHz clip), the same in
// both browsers. Classic script: attaches WKV.wire.
(function (WKV) {
  'use strict';

  const CHUNK = 0x8000;

  function packAudio(samples) {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function unpackAudio(packed) {
    if (typeof packed !== 'string') return null;
    const binary = atob(packed);
    if (binary.length % 4) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }

  WKV.wire = { packAudio, unpackAudio };
})(globalThis.WKV = globalThis.WKV || {});
