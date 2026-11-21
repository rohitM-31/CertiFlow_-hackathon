import { useEffect, useReducer, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { http, errorMessage, rowErrors, type BatchDetail, type RowError, type TimelineEntry } from '../api'
import { useAuth } from '../auth'
import { RowErrorTable, StatusBadge } from '../components'
import { STATUS_FOR_ROLE, timeAgo } from '../labels'
import { useLiveUpdates } from '../realtime'

export function BatchPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const [batch, setBatch] = useState<BatchDetail | null>(null)
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [error, setError] = useState('')
  const [refresh, reload] = useReducer((n: number) => n + 1, 0) // reload() re-runs the fetch

  useEffect(() => {
    let active = true
    Promise.all([http.get<BatchDetail>(`/batches/${id}`), http.get<TimelineEntry[]>(`/batches/${id}/timeline`)]).then(
      ([b, t]) => {
        if (!active) return
        setBatch(b.data)
        setTimeline(t.data)
        setError('')
      },
      (e) => active && setError(errorMessage(e)),
    )
    return () => {
      active = false
    }
  }, [id, refresh])

  // Refresh whenever anything about THIS batch changes, wherever the change came from.
  useLiveUpdates((_event, payload) => {
    if (payload.batchId === id) reload()
  })

  if (error && !batch) return <main className="page"><p className="error">{error}</p><Link to="/">Back</Link></main>
  if (!batch || !user) return <main className="page"><p className="muted">Loading...</p></main>

  const myTurn = STATUS_FOR_ROLE[user.role] === batch.status
  const alreadyVoted = myTurn && batch.decisions.some((d) => d.round === batch.round && d.userId === user.id)

  return (
    <main className="page">
      <Link to="/">&larr; All batches</Link>
      <div className="batch-head">
        <div>
          <h1>B-{batch.number}: {batch.courseName}</h1>
          <p className="muted">
            {batch.centre.name} &middot; {batch._count.candidates} candidates from <code>{batch.sourceFile}</code> &middot; round {batch.round}
          </p>
        </div>
        <StatusBadge status={batch.status} />
      </div>

      <Pipeline batch={batch} />

      {batch.escalatedAt && <div className="alert">Escalated {timeAgo(batch.escalatedAt)}: waiting at this stage longer than the SLA.</div>}
      {batch.lastReason && (batch.status === 'SENT_BACK' || batch.status === 'REJECTED') && <div className="alert">Reason given: {batch.lastReason}</div>}
      {error && <p className="error">{error}</p>}

      {user.role === 'CENTRE' && batch.status === 'SENT_BACK' && <ResubmitCard batchId={batch.id} onDone={reload} />}
      {myTurn && !alreadyVoted && <ReviewCard batchId={batch.id} onDone={reload} />}
      {alreadyVoted && <p className="muted">You have given your decision. Waiting for the other officers.</p>}

      <section>
        <h2>Candidates</h2>
        <CandidateTable batch={batch} canRevoke={user.role === 'STATE'} onChange={reload} />
      </section>

      <section>
        <h2>History</h2>
        <ol className="timeline">
          {timeline.map((e) => (
            <li key={e.id}>
              <span className="when">{new Date(e.createdAt).toLocaleString()}</span>
              <strong>{e.action.replaceAll('_', ' ').toLowerCase()}</strong>
              <span> by {e.actor?.name ?? 'unknown'}</span>
              {e.details && <code>{JSON.stringify(e.details)}</code>}
            </li>
          ))}
        </ol>
      </section>
    </main>
  )
}

/** The whole automatic flow at a glance: done / current / waiting for each step. */
function Pipeline({ batch }: { batch: BatchDetail }) {
  const current = batch.decisions.filter((d) => d.round === batch.round)
  const districtApprovals = current.filter((d) => d.stage === 'DISTRICT' && d.type === 'APPROVE').length
  const large = batch._count.candidates > batch.rules.largeBatchThreshold
  const certs = batch.candidates.filter((c) => c.certificate)
  const sent = certs.filter((c) => c.certificate?.whatsapp?.status === 'SENT').length
  const order = ['DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW', 'APPROVED', 'ISSUED']
  const pos = order.indexOf(batch.status)
  const stopped = batch.status === 'SENT_BACK' || batch.status === 'REJECTED'

  const state = (stepIndex: number): 'done' | 'current' | 'todo' => {
    if (stopped) return 'todo'
    if (pos > stepIndex) return 'done'
    return pos === stepIndex ? 'current' : 'todo'
  }
  const steps = [
    { label: 'CSV validated', detail: `${batch._count.candidates} candidates`, state: 'done' as const },
    { label: 'District officers', detail: `${districtApprovals} of ${batch.rules.districtApprovalsRequired} approvals`, state: state(0) },
    ...(large ? [{ label: 'Quality team', detail: 'large batch', state: state(1) }] : []),
    { label: 'State office', detail: 'final approval', state: state(2) },
    { label: 'Certificates + QR', detail: `${certs.length} of ${batch._count.candidates}`, state: batch.status === 'ISSUED' ? ('done' as const) : state(3) },
    {
      label: 'WhatsApp',
      detail: `${sent} of ${batch._count.candidates} delivered`,
      state: batch.status === 'ISSUED' ? (sent === batch._count.candidates ? ('done' as const) : ('current' as const)) : ('todo' as const),
    },
  ]
  return (
    <ol className="pipeline">
      {steps.map((s) => (
        <li key={s.label} className={`step step-${s.state}`}>
          <strong>{s.label}</strong>
          <small>{s.detail}</small>
        </li>
      ))}
    </ol>
  )
}

function ResubmitCard({ batchId, onDone }: { batchId: string; onDone: () => void }) {
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
    form.append('file', file)
    try {
      await http.post(`/batches/${batchId}/resubmit`, form)
      onDone()
    } catch (err) {
      setErrors(rowErrors(err))
      setMessage(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>Upload the corrected CSV</h2>
      <p className="muted">The candidate list is replaced and the batch goes back for approval. Earlier approvals no longer count.</p>
      <form onSubmit={submit} className="inline-form">
        <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        <button type="submit" disabled={!file || busy}>Resubmit for approval</button>
      </form>
      {message && <p className="error">{message}</p>}
      <RowErrorTable errors={errors} />
    </section>
  )
}

function ReviewCard({ batchId, onDone }: { batchId: string; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const decide = async (type: 'APPROVE' | 'SEND_BACK' | 'REJECT') => {
    if (type !== 'APPROVE' && !reason.trim()) {
      setError('Please write a reason first.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await http.post(`/batches/${batchId}/decisions`, { type, reason: reason || undefined })
      setReason('')
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>Your decision</h2>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required to send back or reject)" rows={2} />
      <div className="actions">
        <button onClick={() => decide('APPROVE')} disabled={busy}>Approve</button>
        <button className="secondary" onClick={() => decide('SEND_BACK')} disabled={busy}>Send back to centre</button>
        <button className="danger" onClick={() => decide('REJECT')} disabled={busy}>Reject</button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function CandidateTable({ batch, canRevoke, onChange }: { batch: BatchDetail; canRevoke: boolean; onChange: () => void }) {
  const [error, setError] = useState('')

  const revoke = async (certificateId: string, number: string) => {
    const reason = window.prompt(`Why is certificate ${number} being cancelled?`)
    if (!reason) return
    try {
      await http.post(`/certificates/${certificateId}/revoke`, { reason })
      onChange()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="table-wrap">
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr><th>Enrolment</th><th>Name</th><th>Phone</th><th>Certificate</th><th>WhatsApp</th></tr>
        </thead>
        <tbody>
          {batch.candidates.map((c) => {
            const cert = c.certificate
            return (
              <tr key={c.id}>
                <td>{c.enrollmentNo}</td>
                <td>{c.fullName}</td>
                <td>{c.phone}</td>
                <td>
                  {!cert && <span className="muted">after final approval</span>}
                  {cert && (
                    <>
                      <Link to={`/verify/${cert.number}`}>{cert.number}</Link>{' '}
                      {cert.status === 'REVOKED' ? (
                        <span className="badge badge-rejected">Cancelled</span>
                      ) : cert.pdfReady ? (
                        <a href={cert.downloadUrl}>PDF</a>
                      ) : (
                        <small className="muted">rendering...</small>
                      )}
                      {canRevoke && cert.status === 'VALID' && (
                        <button className="link danger-text" onClick={() => revoke(cert.id, cert.number)}>Cancel</button>
                      )}
                    </>
                  )}
                </td>
                <td>
                  {cert?.whatsapp?.status === 'SENT' && <span className="badge badge-issued">Delivered</span>}
                  {cert?.whatsapp?.status === 'FAILED' && <span className="badge badge-rejected" title={cert.whatsapp.lastError ?? ''}>Failed</span>}
                  {cert?.whatsapp?.status === 'PENDING' && (
                    <small className="muted" title={cert.whatsapp.lastError ?? ''}>
                      sending{cert.whatsapp.attempts > 0 ? ` (retry ${cert.whatsapp.attempts})` : '...'}
                    </small>
                  )}
                  {!cert?.whatsapp && <span className="muted">-</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
