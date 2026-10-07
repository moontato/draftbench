import { useWorkspaceSession } from './useWorkspaceSession'
import { WorkspaceView } from './WorkspaceView'

// Composition only: native/document lifecycle and review execution have explicit owners.
export function App() {
  const workspace = useWorkspaceSession()
  return <WorkspaceView workspace={workspace} />
}
