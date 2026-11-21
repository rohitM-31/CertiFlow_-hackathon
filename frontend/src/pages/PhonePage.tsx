import { useEffect, useReducer, useState } from 'react'
import axios from 'axios'

interface Message {
  id: string
  to: string
  text: string
  receivedAt: string
}

/** Turn URLs in a message into clickable links (React escapes everything else). */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g)
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : <span key={i}>{part}</span>,
      )}
    </>
  )
}

/**
 * DEMO ONLY: what candidates receive on WhatsApp, read from the stand-in provider.
 * In production there is no such page; messages go to real phones.
 */
export function PhonePage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [phone, setPhone] = useState('')
  const [tick, bump] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    const timer = setInterval(bump, 3000) // the stand-in provider has no push; poll it
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let active = true
    const digits = phone.replace(/\D/g, '').slice(-10)
    axios.get<Message[]>('/mock-whatsapp/inbox', { params: digits.length === 10 ? { to: `+91${digits}` } : {} }).then(
      (r) => active && setMessages(r.data),
      () => active && setMessages([]),
    )
    return () => {
      active = false
    }
  }, [phone, tick])

  return (
    <main className="page narrow">
      <h1>Candidate's phone (demo)</h1>
      <p className="muted">
        Messages delivered by the stand-in WhatsApp provider. It randomly fails and times out on purpose; each candidate still gets exactly one message.
      </p>
      <input className="search" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Filter by 10-digit phone number" />
      {messages.length === 0 && <p className="muted">No messages yet. Messages arrive after a batch's final approval.</p>}
      <ul className="inbox">
        {messages.map((m) => (
          <li key={m.id} className="bubble">
            <div className="bubble-head">
              <strong>{m.to}</strong>
              <small>{new Date(m.receivedAt).toLocaleString()}</small>
            </div>
            <p><Linkified text={m.text} /></p>
          </li>
        ))}
      </ul>
    </main>
  )
}
