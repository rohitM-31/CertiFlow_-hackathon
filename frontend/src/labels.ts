import type { BatchStatus, Role } from './api'

export const STATUS_LABEL: Record<BatchStatus, string> = {
  DISTRICT_REVIEW: 'District review',
  QUALITY_REVIEW: 'Quality review',
  STATE_REVIEW: 'State review',
  SENT_BACK: 'Sent back',
  REJECTED: 'Rejected',
  APPROVED: 'Approved - generating',
  ISSUED: 'Issued',
}

export const ROLE_LABEL: Record<Role, string> = {
  CENTRE: 'Training centre',
  DISTRICT_OFFICER: 'District officer',
  QUALITY: 'Quality team',
  STATE: 'State office',
}

/** Which batch status is waiting for this role. */
export const STATUS_FOR_ROLE: Partial<Record<Role, BatchStatus>> = {
  DISTRICT_OFFICER: 'DISTRICT_REVIEW',
  QUALITY: 'QUALITY_REVIEW',
  STATE: 'STATE_REVIEW',
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '-'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}
