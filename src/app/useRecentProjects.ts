import { useEffect, useRef, useState } from 'react'
import { desktopAvailable, errorMessage, storage, type Project } from '../storage/desktop'
import {
  RECENT_PROJECT_LIMIT,
  parseRecentProjects,
  type RecentProject,
} from '../storage/recentProjects'

export function useRecentProjects(showNotice: (message: string, error?: boolean) => void) {
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const [recentErrors, setRecentErrors] = useState<Record<string, boolean>>({})
  const revision = useRef(0)
  useEffect(() => {
    if (!desktopAvailable) return
    let active = true
    const started = revision.current
    void storage
      .loadRecentProjects()
      .then((projects) => {
        if (active && revision.current === started) setRecentProjects(projects)
      })
      .catch((error) => {
        if (active && revision.current === started) showNotice(errorMessage(error), true)
      })
    return () => {
      active = false
    }
  }, [showNotice])
  const removeRecentProject = async (path: string) => {
    revision.current++
    const projects = await storage.removeRecentProject(path)
    setRecentProjects(projects)
    setRecentErrors((old) => {
      const next = { ...old }
      delete next[path]
      return next
    })
  }
  const rememberProject = (project: Project) => {
    revision.current++
    if (project.recentProjects) {
      try {
        setRecentProjects(parseRecentProjects(project.recentProjects))
      } catch (error) {
        showNotice(errorMessage(error), true)
      }
    } else {
      const opened = { path: project.root, name: project.name, lastOpened: Date.now() }
      setRecentProjects((old) =>
        [opened, ...old.filter((p) => p.path !== opened.path)].slice(0, RECENT_PROJECT_LIMIT),
      )
    }
    setRecentErrors((old) => {
      const next = { ...old }
      delete next[project.root]
      return next
    })
  }
  return { recentProjects, recentErrors, setRecentErrors, removeRecentProject, rememberProject }
}
