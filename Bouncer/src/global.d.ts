// Build-time flags injected by esbuild's `define` (see build.js).

// True only in `--dev` builds. Gates the dev-only latency-benchmark surface
// (background worker + page) so it is never reachable in a production build.
declare const __DEV__: boolean;
