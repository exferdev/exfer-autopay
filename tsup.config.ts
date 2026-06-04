import { defineConfig } from 'tsup'

export default defineConfig({
  entry:      ['src/index.ts'],
  format:     ['esm'],
  dts:        true,
  outDir:     'dist',
  platform:   'node',
  // Bundle exfer-js into the output so the server doesn't need it installed separately
  noExternal: ['exfer-js'],
})
