import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'

const runtime = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: () => true, unlinkSync: vi.fn() }))
vi.mock('../../src/config.js', async original => ({ ...await original<typeof import('../../src/config.js')>(), loadConfig: () => ({ exchangeRate: 1 }) }))
vi.mock('../../src/api/server.js', () => ({ createApiServer: () => http.createServer() }))
vi.mock('../../src/init.js', () => ({ getState: () => null }))
vi.mock('../../src/runtime/settings-controller.js', () => ({ RuntimeSettingsController: class { start = runtime.start; stop = runtime.stop } }))
const { parseServePort, serve } = await import('../../src/commands/serve.js')

describe('review serve lifecycle boundaries', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('AIUSAGE_DASHBOARD_PASSWORD', '') })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers() })

  it.each([0, -1, 65536, 1.5, NaN])('rejects invalid port %j before scheduling or binding', port => {
    const listen = vi.spyOn(http.Server.prototype, 'listen').mockReturnThis()
    vi.spyOn(process, 'on').mockReturnThis()
    expect(() => serve({ port, db: {} as any })).toThrow('Port must be')
    expect(runtime.start).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
  })
  it('parses only whole decimal port arguments within the TCP range', () => {
    for (const value of ['3847junk', '1.5', '1e3', '0', '65536']) expect(() => parseServePort(value)).toThrow('Port must be')
    expect(parseServePort('1')).toBe(1)
    expect(parseServePort('65535')).toBe(65535)
  })
  it('keeps both signal listeners active, stops timers before closing the database, and force-exits on the second signal', () => {
    vi.useFakeTimers()
    const handlers = new Map<string, () => void>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => { handlers.set(event, listener); return process }) as any)
    vi.spyOn(http.Server.prototype, 'listen').mockReturnThis()
    const close = vi.spyOn(http.Server.prototype, 'close').mockReturnThis()
    vi.spyOn(http.Server.prototype, 'closeIdleConnections').mockImplementation(() => {})
    const force = vi.spyOn(http.Server.prototype, 'closeAllConnections').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    const events: string[] = []
    runtime.stop.mockImplementation(() => { events.push('stop') })
    const db = { open: true, close: vi.fn(() => { events.push('close-db'); db.open = false }) }
    serve({ port: 3847, db: db as any })
    expect([...handlers.keys()]).toEqual(['SIGINT', 'SIGTERM'])
    handlers.get('SIGINT')!()
    expect(events).toEqual(['stop', 'close-db'])
    expect(db.close).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    handlers.get('SIGTERM')!()
    expect(close).toHaveBeenCalledOnce()
    expect(force).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
  })
})
