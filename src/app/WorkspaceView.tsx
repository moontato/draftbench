import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Circle,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Maximize2,
  MoreHorizontal,
  PanelLeftClose,
  PanelRightClose,
  PenLine,
  Plus,
  Save,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import { AnalysisHistoryDialog } from '../diagnostics/AnalysisHistoryDialog'
import { hash } from '../diagnostics/hash'
import { ProblemsPanel } from '../diagnostics/ProblemsPanel'
import { writeMarkdown } from '../documents/markdown'
import { RecentProjects } from '../documents/RecentProjects'
import { WritingEditor } from '../editor/WritingEditor'
import type { ProfileId } from '../profiles/profiles'
import { SettingsDialog } from '../settings/SettingsDialog'
import { desktopAvailable, storage, type FileEntry } from '../storage/desktop'
import { Modal } from '../ui/Modal'
import { useWorkspaceSession } from './useWorkspaceSession'
import { backendConfig } from '../settings/model'
function FileTree({
  entries,
  selected,
  onOpen,
  onAction,
}: {
  entries: FileEntry[]
  selected?: string
  onOpen: (path: string) => void
  onAction: (entry: FileEntry) => void
}) {
  return (
    <ul className="file-tree">
      {entries.map((entry) => (
        <li key={entry.path}>
          {entry.folder ? (
            <details open>
              <summary>
                <Folder size={15} />
                <span>{entry.name}</span>
                <button
                  className="tree-action"
                  aria-label={`Actions for ${entry.name}`}
                  onClick={(e) => {
                    e.preventDefault()
                    onAction(entry)
                  }}
                >
                  <MoreHorizontal size={15} />
                </button>
              </summary>
              <FileTree
                entries={entry.children}
                selected={selected}
                onOpen={onOpen}
                onAction={onAction}
              />
            </details>
          ) : (
            <div className={`tree-row ${selected === entry.path ? 'selected' : ''}`}>
              <button onClick={() => onOpen(entry.path)}>
                <FileText size={15} />
                <span>{entry.name.replace(/\.md$/i, '')}</span>
              </button>
              <button
                className="tree-action"
                aria-label={`Actions for ${entry.name}`}
                onClick={() => onAction(entry)}
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
export function WorkspaceView({
  workspace,
}: {
  workspace: ReturnType<typeof useWorkspaceSession>
}) {
  const {
    project,
    analyzers,
    profiles,
    globallyEnabled,
    session,
    recentProjects,
    recentErrors,
    settings,
    settingsLoaded,
    dirty,
    saving,
    fileBusy,
    findings,
    selected,
    dismissed,
    leftOpen,
    rightOpen,
    settingsTab,
    historyOpen,
    busy,
    status,
    notice,
    profile,
    ask,
    askValue,
    unsaved,
    entryActions,
    editorRef,
    history,
    provider,
    running,
    saveRef,
    persistRef,
    settingsRef,
    cache,
    savedReviews,
    task,
    fileTask,
    askName,
    loadDocument,
    removeRecentProject,
    openProject,
    save,
    onReady,
    onChange,
    enabled,
    run,
    selectFinding,
    findingClick,
    accept,
    createDocument,
    createFolder,
    renameEntry,
    deleteEntry,
    changeProfile,
    saveSettings,
    words,
    title,
    showNotice,
    dismissNotice,
    setLeftOpen,
    setRightOpen,
    setSettingsTab,
    setHistoryOpen,
    setDismissed,
    setSelected,
    setStatus,
    setFindings,
    setSettings,
    setAsk,
    setAskValue,
    setUnsaved,
    setEntryActions,
    setHistoryRevision,
  } = workspace
  const defaultAI = backendConfig(settings, settings.defaultBackend)
  return (
    <div
      className="app-shell"
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('.action-menu summary'))
          document.querySelectorAll<HTMLDetailsElement>('.action-menu[open]').forEach((menu) => {
            menu.open = false
          })
      }}
    >
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <PenLine size={19} />
          </div>
          <span>Draftbench</span>
          <span className="version-tag">v0.2</span>
        </div>
        <div className="header-center">
          <span className="header-project">{project?.name ?? 'A workspace for your words'}</span>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            aria-label="Open settings"
            disabled={!settingsLoaded}
            onClick={() => setSettingsTab('AI')}
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      <div
        className={`workspace ${leftOpen ? '' : 'left-hidden'} ${rightOpen ? '' : 'right-hidden'}`}
      >
        {leftOpen && (
          <aside className="documents-pane" aria-label="Project documents">
            <div className="pane-heading">
              <h2>Workspace</h2>
              <button
                className="icon-button"
                aria-label="Hide documents"
                onClick={() => setLeftOpen(false)}
              >
                <PanelLeftClose size={17} />
              </button>
            </div>
            <button
              className="open-project-button"
              disabled={!desktopAvailable}
              onClick={() => fileTask(openProject)}
            >
              <FolderOpen size={16} />
              {project ? 'Open another folder' : 'Open a folder'}
              <ChevronRight size={13} />
            </button>
            {project ? (
              <>
                <div className="project-heading">
                  <Folder size={14} />
                  <span>{project.name}</span>
                  <button
                    className="icon-button"
                    title="New document"
                    aria-label="New document"
                    onClick={() => fileTask(createDocument)}
                  >
                    <Plus size={16} />
                  </button>
                </div>
                <div className="tree-scroll">
                  <FileTree
                    entries={project.entries}
                    selected={session?.path}
                    onOpen={(path) => fileTask(() => loadDocument(path))}
                    onAction={setEntryActions}
                  />
                  {!project.entries.length && (
                    <p className="muted small">This folder has no Markdown documents yet.</p>
                  )}
                </div>
                <div className="document-actions">
                  <button className="text-button" onClick={() => fileTask(createDocument)}>
                    <FilePlus2 size={15} />
                    New document
                  </button>
                  <button className="text-button" onClick={() => fileTask(createFolder)}>
                    <Folder size={15} />
                    New folder
                  </button>
                </div>
              </>
            ) : (
              <div className="sidebar-empty">
                <span className="eyebrow">
                  A NORMAL FOLDER.
                  <br />
                  REAL MARKDOWN FILES.
                </span>
                <p>Open your existing writing or start a new project in any folder.</p>
              </div>
            )}
            <div className="sidebar-bottom">
              <BookOpen size={15} />
              <span>Write with intention.</span>
            </div>
          </aside>
        )}
        <main className={`writing-pane ${!session ? 'welcome-pane' : ''}`}>
          <div className="document-bar">
            <div className="document-breadcrumb">
              {!leftOpen && (
                <button
                  className="icon-button"
                  aria-label="Show documents"
                  onClick={() => setLeftOpen(true)}
                >
                  <FolderOpen size={16} />
                </button>
              )}
              <FileText size={15} />
              <span>{session?.path ?? 'Your next draft'}</span>
              {dirty && <Circle size={7} fill="currentColor" />}
            </div>
            <div className="document-bar-actions">
              <button
                className="icon-button"
                aria-label="Toggle focus mode"
                title="Focus mode"
                onClick={() => {
                  const hide = leftOpen || rightOpen
                  setLeftOpen(!hide)
                  setRightOpen(!hide)
                }}
              >
                <Maximize2 size={15} />
              </button>
              <button
                className="icon-button"
                aria-label={rightOpen ? 'Hide analysis' : 'Show analysis'}
                onClick={() => setRightOpen(!rightOpen)}
              >
                <PanelRightClose size={17} />
              </button>
            </div>
          </div>
          {session ? (
            <>
              <div className="document-heading">
                <div>
                  <span className="eyebrow">
                    {profile === 'general' ? 'GENERAL PROSE' : profiles[profile].name.toUpperCase()}
                  </span>
                  <h1>{title}</h1>
                </div>
                <div className="document-heading-actions">
                  <select
                    aria-label="Writing profile"
                    value={profile}
                    onChange={(e) => task(() => changeProfile(e.target.value as ProfileId))}
                  >
                    {Object.entries(profiles).map(([id, p]) => (
                      <option key={id} value={id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="secondary-button save-button"
                    disabled={saving || !dirty || !!session.source.unsupported.length}
                    onClick={() => {
                      void save()
                    }}
                  >
                    <Save size={14} />
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <details className="action-menu">
                    <summary aria-label="Document actions">
                      <MoreHorizontal size={17} />
                    </summary>
                    <div>
                      <button
                        onClick={() => {
                          void save(true)
                        }}
                      >
                        Save a copy…
                      </button>
                      <button onClick={() => fileTask(() => loadDocument(session.path))}>
                        Reload from disk…
                      </button>
                    </div>
                  </details>
                </div>
              </div>
              {session.source.unsupported.length > 0 && (
                <div className="read-only-note">
                  Read-only: unsupported {session.source.unsupported.join(', ')}.{' '}
                  <button
                    className="text-button"
                    onClick={() => {
                      void save(true)
                    }}
                  >
                    Save a converted copy
                  </button>
                </div>
              )}
              <WritingEditor
                key={session.token}
                content={session.source.body}
                readOnly={saving || fileBusy || !!session.source.unsupported.length}
                settings={settings.editor}
                onReady={onReady}
                onChange={onChange}
                onFinding={findingClick}
                askLink={() =>
                  askName(
                    'Insert a link',
                    'Use https://, http://, or mailto:. Leave empty to remove a link.',
                    editorRef.current?.getAttributes('link').href ?? '',
                  )
                }
              />
              <div className="editor-footer">
                <span>
                  {words.toLocaleString()} words <span className="footer-separator">·</span>{' '}
                  {Math.max(1, Math.ceil(words / 220))} min read
                </span>
                <span>
                  {dirty ? 'Unsaved changes' : 'Saved locally'}{' '}
                  <span className={`save-dot ${dirty ? 'dirty' : ''}`} />
                </span>
              </div>
            </>
          ) : (
            <div className={`welcome ${!project && recentProjects.length ? 'with-recents' : ''}`}>
              <span className="eyebrow">STATIC ANALYSIS FOR WRITING</span>
              <h1>
                Make your point.
                <br />
                <em>Make it well.</em>
              </h1>
              <p>
                A quiet place to write. Thoughtful analysis to help you see what your reader might
                miss.
              </p>
              <div className="welcome-actions">
                <button
                  className="primary-button"
                  disabled={!desktopAvailable || fileBusy || saving}
                  onClick={() => fileTask(project ? createDocument : openProject)}
                >
                  <FolderOpen size={17} />
                  {project ? 'Create a document' : 'Open a writing folder'}
                  <ArrowRight size={16} />
                </button>
                <button
                  className="text-button"
                  disabled={!settingsLoaded}
                  onClick={() => setSettingsTab('AI')}
                >
                  Set up local AI <ChevronRight size={14} />
                </button>
              </div>
              {!project && desktopAvailable && (
                <RecentProjects
                  projects={recentProjects}
                  errors={recentErrors}
                  busy={fileBusy || saving}
                  onOpen={(path) => fileTask(() => openProject(path))}
                  onRemove={(path) => fileTask(() => removeRecentProject(path))}
                />
              )}
              <div className="workflow">
                <span>
                  01 <strong>Write</strong>
                </span>
                <ChevronRight size={14} />
                <span>
                  02 <strong>Analyze</strong>
                </span>
                <ChevronRight size={14} />
                <span>
                  03 <strong>Decide</strong>
                </span>
              </div>
              <div className="welcome-note">
                <PenLine size={18} />
                <p>
                  You remain the author.
                  <br />
                  <span>Suggestions are yours to accept, dismiss, or ignore.</span>
                </p>
              </div>
              {!desktopAvailable && (
                <div className="desktop-only-note">
                  This is the frontend preview. Local files and AI require the desktop app:{' '}
                  <code>npm run tauri dev</code>.
                </div>
              )}
            </div>
          )}
        </main>
        {rightOpen && (
          <ProblemsPanel
            findings={findings}
            selected={selected}
            dismissed={dismissed}
            analyzers={analyzers}
            busy={busy}
            status={status}
            hasDocument={!!session}
            canApply={!!session && !saving && !fileBusy && !session.source.unsupported.length}
            onSelect={selectFinding}
            onApply={accept}
            onDismiss={(id) => {
              setDismissed((old) => new Set([...old, id]))
              setSelected(null)
            }}
            onResetDismissed={() => setDismissed(new Set())}
            onRun={(id) =>
              task(() =>
                run(
                  analyzers.find((a) => a.id === id)?.preferredScope === 'selection'
                    ? 'selection'
                    : 'document',
                  id,
                ),
              )
            }
            onSettings={() => setSettingsTab('Analysis')}
            onHistory={() => setHistoryOpen(true)}
          />
        )}
      </div>
      <footer className="app-footer">
        <div>
          <span className="local-dot" />
          <span>{project ? 'Markdown project' : 'No project open'}</span>
          <span className="footer-separator">/</span>
          <span className="footer-endpoint" title={`${defaultAI.backendName} · ${defaultAI.model}`}>
            {defaultAI.backendName} · {defaultAI.serverUrl}
          </span>
        </div>
        <div className="run-controls">
          {session && (
            <>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => task(() => run('selection'))}
              >
                Analyze selection
              </button>
              <details className="action-menu upward">
                <summary>
                  <span>Run analyzer</span>
                  <ChevronDown size={13} />
                </summary>
                <div>
                  <button disabled={busy} onClick={() => task(() => run('block'))}>
                    Analyze current paragraph
                  </button>
                  {analyzers.map((a) => (
                    <button
                      key={a.id}
                      disabled={
                        busy || !(a.origin === 'custom' ? globallyEnabled(a.id) : enabled(a.id))
                      }
                      onClick={() =>
                        task(() =>
                          run(a.scopes.includes('document') ? 'document' : 'selection', a.id),
                        )
                      }
                    >
                      {a.name}
                    </button>
                  ))}
                  <button
                    disabled={busy}
                    onClick={() => task(() => run('document', undefined, true))}
                  >
                    Force rerun all
                  </button>
                </div>
              </details>
              <button
                className="primary-button"
                disabled={!!session.source.unsupported.length}
                onClick={() => (busy ? running.current?.abort() : task(() => run()))}
              >
                {busy ? <X size={14} /> : <Sparkles size={14} />}{' '}
                {busy ? 'Cancel analysis' : 'Analyze document'}
              </button>
            </>
          )}
        </div>
      </footer>
      {notice && (
        <div
          className={`notice ${notice.error ? 'notice-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          <span>{notice.message}</span>
          <button className="icon-button" aria-label="Dismiss notification" onClick={dismissNotice}>
            <X size={14} />
          </button>
        </div>
      )}
      {historyOpen && session && (
        <AnalysisHistoryDialog
          runs={history.current.forDocument(session.id)}
          documentName={session.path}
          currentHash={
            editorRef.current
              ? hash(writeMarkdown(session.source, editorRef.current.getMarkdown()))
              : undefined
          }
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {settingsTab && settingsLoaded && (
        <SettingsDialog
          settings={settings}
          initialTab={settingsTab}
          provider={provider.current}
          onSave={saveSettings}
          onWarning={(message) => showNotice(message, true)}
          onClose={() => setSettingsTab(null)}
          onCredentialChange={async (backendId = 'default') => {
            running.current?.abort()
            cache.current.clear()
            savedReviews.current.clear()
            setStatus('')
            setFindings([])
            const next = {
              ...settingsRef.current,
              ai: {
                ...settingsRef.current.ai,
                credentialGeneration:
                  settingsRef.current.ai.credentialGeneration + (backendId === 'default' ? 1 : 0),
              },
              backends: settingsRef.current.backends.map((b) =>
                b.id === backendId ? { ...b, credentialGeneration: b.credentialGeneration + 1 } : b,
              ),
            }
            settingsRef.current = next
            setSettings(next)
            await storage.saveSettings(next)
            await persistRef.current()
          }}
          onClearCache={() => {
            running.current?.abort()
            cache.current.clear()
            savedReviews.current.clear()
            history.current.clear()
            setHistoryRevision((old) => old + 1)
            setStatus('')
            setFindings([])
            setDismissed(new Set())
            task(async () => {
              await persistRef.current()
              showNotice('Analysis cache cleared.')
            })
          }}
        />
      )}
      {ask && (
        <Modal
          onEscape={() => {
            ask.resolve(null)
            setAsk(null)
          }}
        >
          <form
            className="small-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={ask.title}
            onSubmit={(e) => {
              e.preventDefault()
              ask.resolve(askValue)
              setAsk(null)
            }}
          >
            <h2>{ask.title}</h2>
            <p>{ask.description}</p>
            <input
              autoFocus
              value={askValue}
              onChange={(e) => setAskValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  ask.resolve(null)
                  setAsk(null)
                }
              }}
            />
            <footer>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  ask.resolve(null)
                  setAsk(null)
                }}
              >
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Continue
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {unsaved && (
        <Modal
          onEscape={() => {
            unsaved(false)
            setUnsaved(null)
          }}
        >
          <div
            className="small-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Unsaved changes"
          >
            <h2>Keep your changes?</h2>
            <p>
              This draft has unsaved changes. Save them before continuing, or discard them
              explicitly.
            </p>
            <footer>
              <button
                className="secondary-button"
                onClick={() => {
                  unsaved(false)
                  setUnsaved(null)
                }}
              >
                Cancel
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  unsaved(true)
                  setUnsaved(null)
                }}
              >
                Discard
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  const resolve = unsaved
                  setUnsaved(null)
                  void saveRef.current().then(resolve)
                }}
              >
                Save
              </button>
            </footer>
          </div>
        </Modal>
      )}
      {entryActions && (
        <Modal onEscape={() => setEntryActions(null)}>
          <div className="small-dialog" role="dialog" aria-modal="true" aria-label="File actions">
            <h2>{entryActions.name}</h2>
            <p>{entryActions.path}</p>
            <footer>
              <button className="secondary-button" onClick={() => setEntryActions(null)}>
                Cancel
              </button>
              <button
                className="secondary-button"
                onClick={() => fileTask(() => renameEntry(entryActions))}
              >
                Rename
              </button>
              <button
                className="danger-button"
                onClick={() => fileTask(() => deleteEntry(entryActions))}
              >
                Delete
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  )
}
