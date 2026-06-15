import { describe, it, expect } from 'vitest'

// Import directly — CONFIG_PATH is fixed, we test behavior
import { MemoryStore } from '../memory.js'

describe('MemoryStore', () => {
  describe('getConfig()', () => {
    it('returns a config with boolean hindsightEnabled', () => {
      const store = new MemoryStore()
      const cfg = store.getConfig()

      expect(typeof cfg.hindsightEnabled).toBe('boolean')
      expect(cfg.hindsightApiUrl).toBeDefined()
      expect(cfg.retainChunkChars).toBeGreaterThan(0)
      expect(cfg.uiPort).toBeGreaterThan(0)
    })

    it('returns an object with all expected keys', () => {
      const store = new MemoryStore()
      const cfg = store.getConfig()

      expect(cfg).toHaveProperty('hindsightEnabled')
      expect(cfg).toHaveProperty('hindsightApiUrl')
      expect(cfg).toHaveProperty('hindsightApiToken')
      expect(cfg).toHaveProperty('retainChunkChars')
      expect(cfg).toHaveProperty('observationsEnabled')
      expect(cfg).toHaveProperty('uiPort')
    })
  })

  describe('active', () => {
    it('is false before start()', () => {
      const store = new MemoryStore()
      expect(store.active).toBe(false)
    })

    it('startedAt is null before start()', () => {
      const store = new MemoryStore()
      expect(store.startedAt).toBeNull()
    })
  })

  describe('retain()', () => {
    it('is a no-op when not active (no errors thrown)', async () => {
      const store = new MemoryStore()
      // Should resolve without throwing even though not active
      await expect(
        store.retain('test content', 'doc-1', ['tag:value'], 'test context')
      ).resolves.toBeUndefined()
    })
  })

  describe('retainChunkChars', () => {
    it('returns a positive number', () => {
      const store = new MemoryStore()
      expect(store.retainChunkChars).toBeGreaterThan(0)
    })
  })
})
