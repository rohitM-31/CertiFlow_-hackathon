import { useEffect, useState } from 'react'
import { http, errorMessage, type Role } from '../api'
import { useAuth } from '../auth'
import { ROLE_LABEL } from '../labels'

interface DemoUser {
  username: string
  name: string
  role: Role
}

/** Demo login: pick a persona in one click (all demo passwords are "demo123"). */
export function LoginPage() {
  const { login } = useAuth()
  const [people, setPeople] = useState<DemoUser[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    http.get<DemoUser[]>('/auth/demo-users').then((r) => setPeople(r.data), (e) => setError(errorMessage(e)))
  }, [])

  const signIn = async (username: string) => {
    setBusy(username)
    setError('')
    try {
      await login(username, 'demo123')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="page narrow">
      <h1>Who are you?</h1>
      <p className="muted">Demo personas. Each browser tab keeps its own login, so open two tabs to be two officers at once.</p>
      {error && <p className="error">{error}</p>}
      <div className="persona-grid">
        {people.map((p) => (
          <button key={p.username} className="persona" onClick={() => signIn(p.username)} disabled={busy !== null}>
            <strong>{p.name.split(' (')[0]}</strong>
            <span>{ROLE_LABEL[p.role]}</span>
            {busy === p.username && <em>Signing in...</em>}
          </button>
        ))}
      </div>
    </main>
  )
}
