import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import { tokenStore } from './api'

export type LiveEvent = 'batch.updated' | 'batch.escalated' | 'certificate.updated'
export type LivePayload = Record<string, string | number | boolean | null>

/**
 * Subscribe to live server events. The server sends only IDs and statuses; pages react
 * by refetching through the normal (permission-checked) API.
 */
export function useLiveUpdates(onEvent: (event: LiveEvent, payload: LivePayload) => void) {
  const handler = useRef(onEvent)
  useEffect(() => {
    handler.current = onEvent
  })

  useEffect(() => {
    const token = tokenStore.get()
    if (!token) return
    const socket = io({ auth: { token } })
    const events: LiveEvent[] = ['batch.updated', 'batch.escalated', 'certificate.updated']
    for (const e of events) socket.on(e, (payload: LivePayload) => handler.current(e, payload))
    return () => {
      socket.disconnect()
    }
  }, [])
}
