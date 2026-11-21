import axios, { AxiosError } from 'axios'

export type Role = 'CENTRE' | 'DISTRICT_OFFICER' | 'QUALITY' | 'STATE'
export type BatchStatus = 'DISTRICT_REVIEW' | 'QUALITY_REVIEW' | 'STATE_REVIEW' | 'SENT_BACK' | 'REJECTED' | 'APPROVED' | 'ISSUED'
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED'

export interface User {
  id: string
  username: string
  name: string
  role: Role
  districtId: string | null
  centreId: string | null
}

export interface BatchSummary {
  id: string
  number: number
  courseName: string
  sourceFile: string
  status: BatchStatus
  round: number
  stageEnteredAt: string
  escalatedAt: string | null
  lastReason: string | null
  centre: { name: string; code: string; district: { name: string } }
  _count: { candidates: number; certificates: number }
  districtApprovals: number
  myVoteThisRound: boolean
}

export interface Candidate {
  id: string
  enrollmentNo: string
  fullName: string
  phone: string
  certificate: {
    id: string
    number: string
    status: 'VALID' | 'REVOKED'
    pdfReady: boolean
    downloadUrl: string
    whatsapp: { status: DeliveryStatus; attempts: number; sentAt: string | null; lastError: string | null } | null
  } | null
}

export interface Decision {
  id: string
  round: number
  stage: 'DISTRICT' | 'QUALITY' | 'STATE'
  type: 'APPROVE' | 'REJECT' | 'SEND_BACK'
  reason: string | null
  userId: string
  createdAt: string
  user: { name: string; role: Role }
}

export interface BatchDetail {
  id: string
  number: number
  courseName: string
  sourceFile: string
  status: BatchStatus
  round: number
  stageEnteredAt: string
  escalatedAt: string | null
  lastReason: string | null
  centre: { name: string }
  _count: { candidates: number }
  candidates: Candidate[]
  decisions: Decision[]
  rules: { districtApprovalsRequired: number; largeBatchThreshold: number }
}

export interface TimelineEntry {
  id: string
  action: string
  details: Record<string, unknown> | null
  createdAt: string
  actor: { name: string; role: string } | null
}

export interface RowError {
  row: number
  field: string
  message: string
}

export interface VerifyResult {
  status: 'VALID' | 'REVOKED' | 'NOT_FOUND'
  valid: boolean
  certificateNumber: string
  holderName?: string
  course?: string
  centre?: string
  district?: string
  issuedOn?: string
  revokedOn?: string | null
}

// Stored per browser TAB, so you can be Dev in one tab and Meera in another.
const TOKEN_KEY = 'certiflow.token'
export const tokenStore = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
}

export const http = axios.create({ baseURL: '/api' })
http.interceptors.request.use((config) => {
  const token = tokenStore.get()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

/** Any API error as a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    const data = err.response?.data as { error?: string } | undefined
    return data?.error ?? err.message
  }
  return err instanceof Error ? err.message : String(err)
}

/** Row-by-row problems from a rejected CSV upload. */
export function rowErrors(err: unknown): RowError[] {
  if (err instanceof AxiosError && err.response?.status === 422) {
    return (err.response.data as { details?: RowError[] }).details ?? []
  }
  return []
}
