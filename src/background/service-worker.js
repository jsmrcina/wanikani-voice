// CHROME ONLY: the background entry point (Chrome MV3 backgrounds are service
// workers). Loads the same scripts as Firefox's background page, plus the
// offscreen relay for the speech worker. Paths are relative to this file.
importScripts(
  '../shared/browser-shim.js',
  '../shared/settings.js',
  '../shared/normalize.js',
  '../shared/wire.js',
  'offscreen-host.js',
  'background.js',
);
