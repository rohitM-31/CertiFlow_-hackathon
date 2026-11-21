import { useEffect, useReducer, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { http, errorMessage, rowErrors, type BatchSummary, type RowError } from '../api'
import { useAuth } from '../auth'
import { RowErrorTable, StatusBadge } from '../components'
import { STATUS_FOR_ROLE, timeAgo } from '../labels'
import { useLiveUpdates } from '../realtime'

export function DashboardPage() {
  const { user } = useAuth()
  const role = user?.role
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [stuck, setStuck] = useState<BatchSummary[]>([])
  const [alert, setAlert] = useState('')
  const [error, setError] = useState('')
  const [refresh, bump] = useReducer((n: number) => n + 1, 0) // bump() re-runs the fetch

  useEffect(() => {
    let active = true // ignore responses that arrive after the page changed
    Promise.all([
      http.get<BatchSummary[]>('/batches'),
      role === 'STATE' ? http.get<BatchSummary[]>('/batches/stuck') : Promise.resolve(null),
    ]).then(
      ([all, stuckRes]) => {
        if (!active) return
        setBatches(all.data)
        setStuck(stuckRes ? stuckRes.data : [])
        setError('')
      },
      (e) => active && setError(errorMessage(e)),
    )
    return () => {
      active = false
    }
  }, [role, refresh])

  useLiveUpdates((event, payload) => {
    if (event === 'batch.escalated') setAlert(`Batch B-${payload.number} has been waiting too long (${payload.status}).`)
    bump()
  })

  if (!user) return null
  const myStatus = STATUS_FOR_ROLE[user.role]
  const waiting = myStatus ? batches.filter((b) => b.status === myStatus && !b.myVoteThisRound) : []
  const sentBack = user.role === 'CENTRE' ? batches.filter((b) => b.status === 'SENT_BACK') : []

  return (
    <main className="page">
      {alert && (
        <div className="alert" role="alert">
          {alert} <button className="link" onClick={() => setAlert('')}>Dismiss</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {user.role === 'CENTRE' && <UploadCard />}

      {sentBack.length > 0 && (
        <section>
          <h2>Sent back to you <span className="count warn">{sentBack.length}</span></h2>
          <BatchTable batches={sentBack} empty="" />
        </section>
      )}

      {myStatus && (
        <section>
          <h2>Waiting for your decision <span className="count">{waiting.length}</span></h2>
          <BatchTable batches={waiting} empty="Nothing waiting for you right now." />
        </section>
      )}

      {user.role === 'STATE' && (
        <section>
          <h2>Stuck past the SLA <span className="count warn">{stuck.length}</span></h2>
          <BatchTable batches={stuck} empty="Nothing is stuck." />
        </section>
      )}

      <section>
        <h2>{user.role === 'CENTRE' ? 'Your batches' : 'All batches you can see'}</h2>
        <BatchTable batches={batches} empty="No batches yet." />
      </section>
    </main>
  )
}

/** The centre's one action: upload the CSV. Everything after that is automatic. */
function UploadCard() {
  const navigate = useNavigate()
  const [courseName, setCourseName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [errors, setErrors] = useState<RowError[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    setErrors([])
    setMessage('')
    const form = new FormData()
    form.append('courseName', courseName)
    form.append('file', file)
    try {
      const { data } = await http.post<{ id: string }>('/batches', form)
      navigate(`/batches/${data.id}`)
    } catch (err) {
      setErrors(rowErrors(err))
      setMessage(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>Upload passed candidates</h2>
      <p className="muted">
        CSV with columns <code>enrollment_no, full_name, phone, date_of_birth</code> (YYYY-MM-DD). The file is checked row by row;
        if it is clean, the batch is created and sent for approval automatically. Certificates are generated and sent on WhatsApp only
        after every approval.
      </p>
      <form onSubmit={submit} className="inline-form">
        <input value={courseName} onChange={(e) => setCourseName(e.target.value)} placeholder="Course name, e.g. Electrician - Domestic" required minLength={3} />
        <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        <button type="submit" disabled={!file || busy}>{busy ? 'Checking...' : 'Upload and submit'}</button>
      </form>
      {message && <p className="error">{message}</p>}
      <RowErrorTable errors={errors} />
    </section>
  )
}

function BatchTable({ batches, empty }: { batches: BatchSummary[]; empty: string }) {
  if (batches.length === 0) return empty ? <p className="muted">{empty}</p> : null
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Batch</th><th>Course</th><th>Centre</th><th>Candidates</th><th>Status</th><th>At this stage since</th></tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} className={b.escalatedAt ? 'row-escalated' : ''}>
              <td><Link to={`/batches/${b.id}`}>B-{b.number}</Link></td>
              <td>{b.courseName}</td>
              <td>{b.centre.name}<br /><small className="muted">{b.centre.district.name}</small></td>
              <td>{b._count.candidates}</td>
              <td>
                <StatusBadge status={b.status} />
                {b.status === 'DISTRICT_REVIEW' && <small className="muted"> {b.districtApprovals} approval(s)</small>}
                {b.escalatedAt && <small className="warn-text"> escalated</small>}
              </td>
              <td>{timeAgo(b.stageEnteredAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
