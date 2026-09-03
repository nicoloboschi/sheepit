import { describe, it, expect } from 'vitest'
import {
  parsePreviewUrl, isLoopback, refusesFraming, forwardableHeaders,
  injectBase, rewriteLoopbackPaths, isHtml,
} from '../preview.js'

const headers = (h: Record<string, string>) => new Headers(h)

describe('parsePreviewUrl', () => {
  it('reads what people actually type', () => {
    expect(parsePreviewUrl('localhost:3000')?.href).toBe('http://localhost:3000/')
    expect(parsePreviewUrl('  127.0.0.1:8080/app  ')?.href).toBe('http://127.0.0.1:8080/app')
    expect(parsePreviewUrl('react.dev')?.href).toBe('http://react.dev/')
    expect(parsePreviewUrl('https://react.dev/learn')?.href).toBe('https://react.dev/learn')
  })

  // `file:` would read the disk through the server; `data:`/`javascript:` are
  // only ever an attempt to run something inside sheepit's own page.
  it('refuses anything that is not http', () => {
    expect(parsePreviewUrl('file:///etc/passwd')).toBeNull()
    expect(parsePreviewUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(parsePreviewUrl('javascript:alert(1)')).toBeNull()
    expect(parsePreviewUrl('')).toBeNull()
    expect(parsePreviewUrl('   ')).toBeNull()
  })

  // Previewing sheepit through sheepit's own proxy nests until something gives.
  it('refuses to preview itself', () => {
    expect(parsePreviewUrl('localhost:4445', { selfPort: 4445 })).toBeNull()
    expect(parsePreviewUrl('127.0.0.1:4445', { selfPort: 4445 })).toBeNull()
    // Another port on the same machine is exactly the point of the feature.
    expect(parsePreviewUrl('localhost:3000', { selfPort: 4445 })).not.toBeNull()
    // And the same port elsewhere is somebody else's server.
    expect(parsePreviewUrl('example.com:4445', { selfPort: 4445 })).not.toBeNull()
  })
})

describe('isLoopback', () => {
  it('knows the machine sheepit is on', () => {
    for (const u of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:9000', 'http://0.0.0.0:5000']) {
      expect(isLoopback(new URL(u)), u).toBe(true)
    }
    for (const u of ['https://react.dev', 'http://192.168.1.10:3000']) {
      expect(isLoopback(new URL(u)), u).toBe(false)
    }
  })
})

describe('refusesFraming', () => {
  // Checked against the real headers of the sites this will be pointed at.
  it('matches what google and github actually send', () => {
    expect(refusesFraming(headers({ 'x-frame-options': 'SAMEORIGIN' }))).toBe(true)
    expect(refusesFraming(headers({ 'x-frame-options': 'deny' }))).toBe(true)
    expect(refusesFraming(headers({ 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" }))).toBe(true)
    expect(refusesFraming(headers({ 'content-security-policy': "frame-ancestors 'self'" }))).toBe(true)
  })

  it('lets through a page that does not mind being framed', () => {
    expect(refusesFraming(headers({}))).toBe(false)
    expect(refusesFraming(headers({ 'content-type': 'text/html' }))).toBe(false)
    // A CSP without frame-ancestors says nothing about framing.
    expect(refusesFraming(headers({ 'content-security-policy': "default-src 'self'; script-src 'self'" }))).toBe(false)
    // And one that explicitly allows anyone.
    expect(refusesFraming(headers({ 'content-security-policy': 'frame-ancestors *' }))).toBe(false)
  })
})

describe('forwardableHeaders', () => {
  it('drops the headers that refused the frame', () => {
    const out = forwardableHeaders(headers({
      'content-type': 'text/html',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    }))
    expect(out['content-type']).toBe('text/html')
    expect(out['x-frame-options']).toBeUndefined()
    expect(out['content-security-policy']).toBeUndefined()
  })

  // The body is re-encoded on the way through, so its old description is a lie.
  it('drops the headers that describe a body we rewrote', () => {
    const out = forwardableHeaders(headers({ 'content-length': '1234', 'content-encoding': 'gzip' }))
    expect(out['content-length']).toBeUndefined()
    expect(out['content-encoding']).toBeUndefined()
  })
})

describe('injectBase', () => {
  it('puts the base first inside head, so it beats the page own one', () => {
    const out = injectBase('<html><head><base href="/nope/"><title>x</title></head><body></body></html>', 'https://ex.com/a/')
    expect(out.indexOf('https://ex.com/a/')).toBeLessThan(out.indexOf('/nope/'))
  })

  it('copes with a document that has no head, and with no html at all', () => {
    expect(injectBase('<html><body>hi</body></html>', 'https://ex.com/')).toContain('<head><base href="https://ex.com/"></head>')
    expect(injectBase('hi', 'https://ex.com/')).toBe('<base href="https://ex.com/">hi')
  })

  // frame-ancestors in a meta is ignored by browsers, but the other directives
  // are enforced and would block the very assets the base tag redirected.
  it('removes CSP meta tags', () => {
    const out = injectBase(
      `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>t</title></head></html>`,
      'https://ex.com/',
    )
    expect(out).not.toContain('Content-Security-Policy')
    expect(out).toContain('<title>t</title>')
  })

  it('escapes the url it writes into the attribute', () => {
    expect(injectBase('<head></head>', 'https://ex.com/"><script>')).not.toContain('"><script>')
  })
})

describe('rewriteLoopbackPaths', () => {
  it('sends a loopback page assets back through the proxy', () => {
    const out = rewriteLoopbackPaths('<script src="/main.js"></script><a href="/about">a</a>', 'http://localhost:3000')
    expect(out).toContain(`src="/api/preview?url=${encodeURIComponent('http://localhost:3000/main.js')}"`)
    expect(out).toContain(encodeURIComponent('http://localhost:3000/about'))
  })

  it('rewrites url() in inline css', () => {
    const out = rewriteLoopbackPaths('<style>body{background:url(/bg.png)}</style>', 'http://localhost:3000')
    expect(out).toContain(encodeURIComponent('http://localhost:3000/bg.png'))
  })

  it('leaves alone what it must not touch', () => {
    const src = '<img src="https://cdn.example.com/a.png"><img src="//cdn/b.png"><img src="rel.png">'
    expect(rewriteLoopbackPaths(src, 'http://localhost:3000')).toBe(src)
  })
})

describe('isHtml', () => {
  it('knows what to rewrite and what to pass through', () => {
    expect(isHtml('text/html; charset=utf-8')).toBe(true)
    expect(isHtml('application/xhtml+xml')).toBe(true)
    expect(isHtml('application/json')).toBe(false)
    expect(isHtml('image/png')).toBe(false)
    expect(isHtml(null)).toBe(false)
  })
})
