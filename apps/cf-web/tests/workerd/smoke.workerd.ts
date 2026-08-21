import { expect, it } from 'vitest'

it('runs inside workerd', () => {
  expect(typeof WebSocketPair).toBe('function')
  expect(navigator.userAgent).toBe('Cloudflare-Workers')
})
