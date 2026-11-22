import { expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { createServer, request, type IncomingMessage } from 'node:http'
import { BodyTooLargeError, readJsonBody, readBodyBuffer } from '../../src/api/request-body.js'

function input(headers = {}) {
  const stream = new PassThrough() as PassThrough & IncomingMessage
  stream.headers = headers
  return stream
}

it('accepts exactly the byte limit and assembles split UTF-8', async () => {
  const body = Buffer.from('{"value":"中文"}')
  const req = input()
  const result = readJsonBody(req, body.length)
  for (const byte of body) req.write(Buffer.from([byte]))
  req.end()
  expect(await result).toEqual({ value: '中文' })
})

it('rejects declared oversize before consuming data', async () => {
  const req = input({ 'content-length': '101' })
  await expect(readJsonBody(req, 100)).rejects.toBeInstanceOf(BodyTooLargeError)
  expect(req.listenerCount('data')).toBe(0)
})

it('rejects chunked oversize while streaming', async () => {
  const req = input()
  const result = readJsonBody(req, 10)
  req.write(Buffer.alloc(6))
  req.write(Buffer.alloc(5))
  await expect(result).rejects.toBeInstanceOf(BodyTooLargeError)
  expect(req.isPaused()).toBe(true)
})

it('preserves exact binary upload bytes', async () => {
  const req = input()
  const body = Buffer.from([0, 255, 128, 13, 10])
  const result = readBodyBuffer(req, body.length)
  req.end(body)
  expect(await result).toEqual(body)
})

it('limits chunked binary uploads and pauses input', async () => {
  const req = input()
  const result = readBodyBuffer(req, 8)
  req.write(Buffer.alloc(5))
  req.write(Buffer.alloc(4))
  await expect(result).rejects.toBeInstanceOf(BodyTooLargeError)
  expect(req.isPaused()).toBe(true)
})

it.each(['{', 'null', '[]', '1'])('rejects invalid JSON object %s', async (text) => {
  const req = input()
  const result = readJsonBody(req)
  req.end(text)
  await expect(result).rejects.toBeInstanceOf(SyntaxError)
})

it('delivers an HTTP 413 instead of resetting the socket', async () => {
  const server = createServer(async (req, res) => {
    try { await readJsonBody(req, 16); res.end('ok') }
    catch (error) { res.writeHead(error instanceof BodyTooLargeError ? 413 : 400, { Connection: 'close' }); res.end() }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, method: 'POST' }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.write('1234567890')
      req.end('1234567890')
    })
    expect(status).toBe(413)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})
