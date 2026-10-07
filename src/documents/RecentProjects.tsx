import { ArrowUpRight, FolderOpen, X } from 'lucide-react'
import type { RecentProject } from '../storage/recentProjects'

export function RecentProjects({
  projects,
  errors,
  busy,
  onOpen,
  onRemove,
}: {
  projects: RecentProject[]
  errors: Record<string, boolean>
  busy: boolean
  onOpen: (path: string) => void
  onRemove: (path: string) => void
}) {
  if (!projects.length) return null
  return (
    <section className="recent-projects" aria-labelledby="recent-projects-title">
      <h2 id="recent-projects-title">Recent projects</h2>
      <ul>
        {projects.map((project) => (
          <li key={project.path}>
            <button
              className="recent-project-open"
              disabled={busy}
              onClick={() => onOpen(project.path)}
              title={project.path}
              aria-label={`Open recent project ${project.name} at ${project.path}`}
            >
              <FolderOpen size={16} />
              <span>
                <strong>{project.name}</strong>
                <span className="recent-project-path">{project.path}</span>
                {errors[project.path] && (
                  <span className="recent-project-error">
                    Folder unavailable. Locate it again or remove this entry.
                  </span>
                )}
              </span>
              <ArrowUpRight size={14} />
            </button>
            <button
              className="icon-button"
              disabled={busy}
              title="Remove from recent projects (does not delete files)"
              aria-label={`Remove recent project ${project.name} at ${project.path}`}
              onClick={() => onRemove(project.path)}
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
