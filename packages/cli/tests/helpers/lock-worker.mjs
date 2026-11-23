import { acquireLock, releaseLock } from '../../src/lock.ts'

const lockPath = process.argv[2]
if (!acquireLock(lockPath)) {
  process.stdout.write('busy\n')
  process.exitCode = 2
} else {
  process.stdout.write('held\n')
  process.stdin.resume()
  process.stdin.on('data', () => {
    releaseLock(lockPath)
    process.exit(0)
  })
}
