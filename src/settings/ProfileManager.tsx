import { useState } from 'react'
import { createAnalyzerRegistry } from '../analyzers/registry'
import { getProfiles, profiles } from '../profiles/profiles'
import { customProfileSchema, uniqueId, type CustomProfile } from './definitions'
import type { Settings } from './model'
export function ProfileManager({
  draft,
  onChange,
}: {
  draft: Settings
  onChange: (settings: Settings) => void
}) {
  const [editing, setEditing] = useState<CustomProfile | null>(null)
  const [originalId, setOriginalId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const all = getProfiles(draft),
    registry = createAnalyzerRegistry(draft)
  const start = (profile: CustomProfile, original: string | null = null) => {
    setEditing(structuredClone(profile))
    setOriginalId(original)
    setError('')
  }
  const save = () => {
    const parsed = customProfileSchema.safeParse(editing)
    if (!parsed.success) {
      setError('Enter a name and a lowercase unique profile ID.')
      return
    }
    if (Object.hasOwn(all, parsed.data.id) && parsed.data.id !== originalId) {
      setError('That profile ID already exists.')
      return
    }
    if (!originalId && draft.customProfiles.length >= 40) {
      setError('The limit is 40 custom profiles.')
      return
    }
    onChange({
      ...draft,
      customProfiles: [...draft.customProfiles.filter((p) => p.id !== originalId), parsed.data],
    })
    setEditing(null)
  }
  const remove = (id: string) => {
    onChange({
      ...draft,
      customProfiles: draft.customProfiles.filter((p) => p.id !== id),
      general: {
        ...draft.general,
        defaultProfile:
          draft.general.defaultProfile === id ? 'general' : draft.general.defaultProfile,
      },
    })
    if (originalId === id) setEditing(null)
  }
  return (
    <div>
      <h3>Writing profiles</h3>
      <p className="muted">
        A transparent analyzer preset. Globally disabled reviewers stay off. Backend/model selection
        remains analyzer/global-driven; profiles never change credentials. Documents retain the
        selected profile locally.
      </p>
      <button
        className="secondary-button"
        disabled={draft.customProfiles.length >= 40}
        onClick={() =>
          start({
            id: uniqueId('custom-profile', Object.keys(all)),
            name: '',
            description: '',
            enabled: [],
          })
        }
      >
        Create custom profile
      </button>
      {editing && (
        <section className="management-editor" aria-label="Custom profile editor">
          <label className="field">
            Profile ID
            <input
              disabled={!!originalId}
              value={editing.id}
              onChange={(e) => setEditing({ ...editing, id: e.target.value })}
            />
          </label>
          <label className="field">
            Profile name
            <input
              maxLength={100}
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label className="field">
            Profile description
            <textarea
              maxLength={1000}
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </label>
          <fieldset>
            <legend>Enabled analyzers in this profile</legend>
            {registry.map((a) => (
              <label key={a.id} className="check-field">
                <input
                  type="checkbox"
                  checked={editing.enabled.includes(a.id)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      enabled: e.target.checked
                        ? [...editing.enabled, a.id]
                        : editing.enabled.filter((id) => id !== a.id),
                    })
                  }
                />
                {a.name}
              </label>
            ))}
          </fieldset>
          {error && <p role="alert">{error}</p>}
          <div className="management-actions">
            <button className="secondary-button" onClick={() => setEditing(null)}>
              Cancel profile edit
            </button>
            <button className="primary-button" onClick={save}>
              Keep profile changes
            </button>
          </div>
        </section>
      )}
      {Object.entries(all).map(([id, profile]) => (
        <section
          className="analyzer-setting"
          key={id}
          aria-label={`${profile.name} profile settings`}
        >
          <strong>{profile.name}</strong>
          <p>{profile.description}</p>
          <p className="muted">
            {profile.enabled.map((a) => registry.find((r) => r.id === a)?.name ?? a).join(' · ') ||
              'No analyzers selected.'}
          </p>
          <div className="management-actions">
            {!Object.hasOwn(profiles, id) && (
              <button
                className="text-button"
                onClick={() =>
                  start(
                    draft.customProfiles.find((p) => p.id === id)!,
                    id,
                  )
                }
              >
                Edit {profile.name}
              </button>
            )}
            <button
              className="text-button"
              onClick={() =>
                start({
                  id: uniqueId('custom-profile', Object.keys(all)),
                  name: `${profile.name} copy`,
                  description: profile.description ?? '',
                  enabled: [...profile.enabled],
                })
              }
            >
              Duplicate {profile.name}
            </button>
            {!Object.hasOwn(profiles, id) && (
              <button className="text-button" onClick={() => remove(id)}>
                Delete {profile.name}
              </button>
            )}
          </div>
        </section>
      ))}
    </div>
  )
}
