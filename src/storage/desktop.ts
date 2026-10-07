import { invoke, isTauri } from '@tauri-apps/api/core'
import { open, confirm } from '@tauri-apps/plugin-dialog'
import type { Settings } from '../settings/model'
import { parseRecentProjects, type RecentProject } from './recentProjects'
export interface FileEntry {
  path: string
  name: string
  folder: boolean
  children: FileEntry[]
}
export interface Project {
  root: string
  name: string
  entries: FileEntry[]
  recentProjects?: RecentProject[]
  recentWarning?: string
}
export interface LoadedFile {
  content: string
  hash: string
}
export const desktopAvailable = isTauri()
export const storage = {
  openProject: (path: string) => invoke<Project>('open_project', { path }),
  loadRecentProjects: async () =>
    parseRecentProjects(await invoke<unknown>('load_recent_projects')),
  removeRecentProject: async (path: string) =>
    parseRecentProjects(await invoke<unknown>('remove_recent_project', { path })),
  async pickProject(): Promise<Project | null> {
    const path = await open({ directory: true, multiple: false, title: 'Open a Markdown project' })
    return typeof path === 'string' ? invoke<Project>('open_project', { path }) : null
  },
  list: () => invoke<FileEntry[]>('list_files'),
  read: (path: string) => invoke<LoadedFile>('read_document', { path }),
  save: (path: string, content: string, expectedHash: string | null) =>
    invoke<string>('save_document', { path, content, expectedHash }),
  createFolder: (path: string) => invoke<void>('create_folder', { path }),
  rename: (path: string, destination: string) =>
    invoke<void>('rename_entry', { path, destination }),
  delete: (path: string) => invoke<void>('delete_entry', { path }),
  confirm: (message: string) => confirm(message, { title: 'Draftbench', kind: 'warning' }),
  loadSettings: () => invoke<unknown>('load_settings'),
  saveSettings: (value: Settings) => invoke<void>('save_settings', { value }),
  metadata: (name: 'project' | 'analysis') => invoke<unknown>('read_metadata', { name }),
  setMetadata: (name: 'project' | 'analysis', value: unknown) =>
    invoke<void>('write_metadata', { name, value }),
  setKey: (key: string, credentialRef?: string) =>
    invoke<void>('set_api_key', { key, credentialRef }),
  hasKey: (credentialRef?: string) => invoke<boolean>('has_api_key', { credentialRef }),
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) return String(error.message)
  return String(error)
}
