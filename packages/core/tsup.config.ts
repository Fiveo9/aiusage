import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/format.ts', 'src/exchange-rate.ts'],
  format: ['esm'],
  dts: true,
  clean: false,
})
