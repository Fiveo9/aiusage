#!/usr/bin/env node
// Copies the web SPA build into the CLI dist so it ships inside the npm package.
import { cpSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const webBuildDir = join(__dirname, '..', '..', 'web', 'build')
const destDir = join(__dirname, '..', 'dist', 'web')
const { recycleOutput } = createRequire(import.meta.url)('../../../scripts/recycle-output.cjs')

if (!existsSync(webBuildDir)) {
  console.error('Web build not found at', webBuildDir)
  console.error('Run: pnpm --filter @aiusage/web build')
  process.exit(1)
}

if (existsSync(destDir)) {
  recycleOutput(join(__dirname, '..', '..', '..'), destDir)
}

cpSync(webBuildDir, destDir, { recursive: true })
console.log('Web build copied to dist/web')
