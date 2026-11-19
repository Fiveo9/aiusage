import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

copyFileSync(
  fileURLToPath(new URL('../../../README.md', import.meta.url)),
  fileURLToPath(new URL('../README.md', import.meta.url)),
)
