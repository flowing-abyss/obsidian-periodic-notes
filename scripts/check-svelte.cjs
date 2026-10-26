// The pinned source-map 0.7.3 mistakes Node's built-in fetch for a browser.
// Keep its filesystem loader active without changing the plugin's dependencies.
delete globalThis.fetch;
require("svelte-check/bin/svelte-check");
