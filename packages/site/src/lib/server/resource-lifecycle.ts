type Closer = () => void | Promise<void>
interface Resources { closers: Set<Closer>; installed: boolean }
const key = Symbol.for('aiusage.site.resources')
const store = globalThis as unknown as Record<symbol, Resources>
const resources = store[key] ??= { closers: new Set(), installed: false }

export function registerSiteResource(close: Closer): () => void {
  resources.closers.add(close)
  return () => { resources.closers.delete(close) }
}

export async function closeSiteResources(): Promise<void> {
  const closers = [...resources.closers]
  resources.closers.clear()
  await Promise.allSettled(closers.map(close => Promise.resolve().then(close)))
}

if (!resources.installed) {
  resources.installed = true
  // adapter-node emits this after its HTTP connections have drained.
  process.on('sveltekit:shutdown', () => { void closeSiteResources() })
  process.once('beforeExit', () => { void closeSiteResources() })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // Standalone migration/maintenance scripts have no HTTP shutdown owner.
      // Let adapter-node finish in-flight requests before closing their clients.
      if (process.listenerCount(signal) <= 1) void closeSiteResources()
    })
  }
}
