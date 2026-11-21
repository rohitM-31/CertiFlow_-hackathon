import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { http, errorMessage, type VerifyResult } from '../api'

/** Public page: anyone can check a certificate, no login. The QR code on the PDF links here. */
export function VerifyPage() {
  const { number: fromUrl = '' } = useParams()
  const navigate = useNavigate()
  const [input, setInput] = useState(fromUrl)
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!fromUrl) return
    http.get<VerifyResult>(`/verify/${encodeURIComponent(fromUrl)}`).then(
      (r) => {
        setResult(r.data)
        setError('')
      },
      (e) => setError(errorMessage(e)),
    )
  }, [fromUrl])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    navigate(`/verify/${input.trim().toUpperCase()}`)
  }

  return (
    <main className="page narrow">
      <h1>Verify a certificate</h1>
      <p className="muted">Enter the number printed on the certificate (or scan its QR code), e.g. PSM-DEMO000001.</p>
      <form onSubmit={submit} className="inline-form">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="PSM-XXXXXXXXXX" required />
        <button type="submit">Check</button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && result.certificateNumber === fromUrl.toUpperCase() && <VerifyCard result={result} />}
    </main>
  )
}

function VerifyCard({ result }: { result: VerifyResult }) {
  if (result.status === 'NOT_FOUND') {
    return (
      <div className="verify verify-bad">
        <h2>Not found</h2>
        <p>No certificate with number {result.certificateNumber} exists. It may be fake.</p>
      </div>
    )
  }
  return (
    <div className={`verify ${result.valid ? 'verify-ok' : 'verify-bad'}`}>
      <h2>{result.valid ? 'Genuine certificate' : 'NOT VALID: this certificate has been cancelled'}</h2>
      <dl>
        <dt>Number</dt><dd>{result.certificateNumber}</dd>
        <dt>Holder</dt><dd>{result.holderName}</dd>
        <dt>Course</dt><dd>{result.course}</dd>
        <dt>Centre</dt><dd>{result.centre}, {result.district}</dd>
        <dt>Issued on</dt><dd>{result.issuedOn}</dd>
        {result.revokedOn && (<><dt>Cancelled on</dt><dd>{result.revokedOn}</dd></>)}
      </dl>
      <p className="muted small">Only partial details are shown to protect the holder's privacy. Compare them with the paper certificate.</p>
    </div>
  )
}
