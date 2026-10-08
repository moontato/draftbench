import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function checkReleaseTag(tag: string | undefined, version: string): string {
  if (!tag || tag !== tag.trim() || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag))
    throw new Error('Release tags must be stable versions in the form vX.Y.Z (for example v0.2.1).')
  if (tag !== `v${version}`)
    throw new Error(
      `Release tag ${tag} does not match application version ${version}. Update npm, Tauri, Cargo and their lockfiles before tagging.`,
    )
  return tag
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    console.log(`Verified release tag ${checkReleaseTag(process.argv[2], version)}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
