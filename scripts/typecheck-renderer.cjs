// vue-tsc patches the JS compiler API, which the native TypeScript 7 compiler
// no longer exposes. Keep TS 5 isolated to this check; main still builds with 7.
require('vue-tsc').run(require.resolve('typescript-vue/lib/tsc'));
