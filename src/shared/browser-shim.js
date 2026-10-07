// Chrome names the extension API `chrome`; Firefox has both. Since Chrome 99
// the `chrome.*` calls this extension uses all return promises, like
// Firefox's `browser.*`, so an alias is all that's needed (no polyfill).
// Loaded first in every context; a no-op in Firefox.
globalThis.browser ??= globalThis.chrome;
