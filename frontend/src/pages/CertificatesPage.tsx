import { useEffect, useReducer, useState } from 'react'
import { Link } from 'react-router-dom'
import { http, errorMessage, type DeliveryStatus } from '../api'
import { useLiveUpdates } from '../realtime'

interface CertificateRow {
  id: string
  number: string
  status: 'VALID' | 'REVOKED'
  revokeReason: string | null
  batchId: string
  candidate: { fullName: string; enrollmentNo: string }
  batch: { number: number; courseName: string; centre: { name: string } }
  delivery: { status: DeliveryStatus; attempts: number } | null
}

/** State office: find any certificate, see WhatsApp delivery, cancel if it should never have been issued. */
export function CertificatesPage() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<CertificateRow[]>([])
  const [error, setError] = useState('')
  const [refresh, bump] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      http.get<CertificateRow[]>('/certificates', { params: q ? { q } : {} }).then(
        (r) => active && setRows(r.data),
        (e) => active && setError(errorMessage(e)),
      )
    }, 250) // small debounce while typing
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [q, refresh])

  useLiveUpdates(() => bump())

  const revoke = async (row: CertificateRow) => {
    const reason = window.prompt(`Why is ${row.number} (${row.candidate.fullName}) being cancelled?`)
    if (!reason) return
    try {
      await http.post(`/certificates/${row.id}/revoke`, { reason })
      bump()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <main className="page">
      <h1>Certificates</h1>
      <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by number, enrolment or name" />
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Number</th><th>Holder</th><th>Course</th><th>Batch</th><th>Status</th><th>WhatsApp</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/verify/${r.number}`}>{r.number}</Link></td>
                <td>{r.candidate.fullName}<br /><small className="muted">{r.candidate.enrollmentNo}</small></td>
                <td>{r.batch.courseName}<br /><small className="muted">{r.batch.centre.name}</small></td>
                <td><Link to={`/batches/${r.batchId}`}>B-{r.batch.number}</Link></td>
                <td>
                  {r.status === 'VALID' ? <span className="badge badge-issued">Valid</span> : <span className="badge badge-rejected">Cancelled</span>}
                  {r.revokeReason && <><br /><small className="muted">{r.revokeReason}</small></>}
                </td>
                <td>{r.delivery ? `${r.delivery.status.toLowerCase()} (${r.delivery.attempts} attempt${r.delivery.attempts === 1 ? '' : 's'})` : '-'}</td>
                <td>{r.status === 'VALID' && <button className="link danger-text" onClick={() => revoke(r)}>Cancel</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  )
}
