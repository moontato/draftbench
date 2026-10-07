import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../../src-tauri/tauri.conf.json'

describe('desktop bundle icons', () => {
  it('explicitly supplies macOS, Windows, and PNG icons that exist in the package', () => {
    expect(config.bundle.icon).toContain('icons/icon.icns')
    expect(config.bundle.icon).toContain('icons/icon.ico')
    expect(config.bundle.icon).toContain('icons/128x128.png')
    for (const path of config.bundle.icon) expect(existsSync(join('src-tauri', path))).toBe(true)
  })
  it('supplies a complete macOS ICNS container including a high-resolution icon', () => {
    const bytes = readFileSync('src-tauri/icons/icon.icns')
    expect(bytes.toString('ascii', 0, 4)).toBe('icns')
    expect(bytes.readUInt32BE(4)).toBe(bytes.length)
    const types: string[] = []
    let offset = 8
    while (offset < bytes.length) {
      const size = bytes.readUInt32BE(offset + 4)
      expect(size).toBeGreaterThan(8)
      expect(offset + size).toBeLessThanOrEqual(bytes.length)
      types.push(bytes.toString('ascii', offset, offset + 4))
      offset += size
    }
    expect(offset).toBe(bytes.length)
    expect(types).toContain('ic10') // 1024px macOS icon.
  })
})
