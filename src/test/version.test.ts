import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { version } from '../../package.json'
import tauriConfig from '../../src-tauri/tauri.conf.json'

describe('application release version', () => {
  it('keeps the npm package and root lockfile versions synchronized', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(lock.version).toBe(version)
    expect(lock.packages[''].version).toBe(version)
  })
  it('keeps desktop packaging and Rust package metadata synchronized with the displayed version', () => {
    const manifest = readFileSync('src-tauri/Cargo.toml', 'utf8')
    const lock = readFileSync('src-tauri/Cargo.lock', 'utf8')
    expect(tauriConfig.version).toBe(version)
    expect(manifest.match(/name = "draftbench"\r?\nversion = "([^"]+)"/)?.[1]).toBe(version)
    expect(lock.match(/name = "draftbench"\r?\nversion = "([^"]+)"/)?.[1]).toBe(version)
  })
})
