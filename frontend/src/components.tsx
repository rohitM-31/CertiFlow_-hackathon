import { Link } from 'react-router-dom'
import type { BatchStatus, RowError } from './api'
import { useAuth } from './auth'
import { STATUS_LABEL } from './labels'

export function StatusBadge({ status }: { status: BatchStatus }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>
}

export function Header() {
  const { user, logout } = useAuth()
  return (
    <header className="header">
      <Link to="/" className="brand">CertiFlow</Link>
      <nav>
        <Link to="/verify">Verify a certificate</Link>
        <Link to="/phone">Candidate's phone (demo)</Link>
        {user?.role === 'STATE' && <Link to="/certificates">Certificates</Link>}
      </nav>
      {user && (
        <div className="who">
          <span>{user.name}</span>
          <button className="link" onClick={logout}>Switch person</button>
        </div>
      )}
    </header>
  )
}

/** The table of problems returned when a CSV is rejected. */
export function RowErrorTable({ errors }: { errors: RowError[] }) {
  if (errors.length === 0) return null
  return (
    <table className="errors">
      <thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead>
      <tbody>
        {errors.map((e, i) => (
          <tr key={i}><td>{e.row}</td><td>{e.field}</td><td>{e.message}</td></tr>
        ))}
      </tbody>
    </table>
  )
}
