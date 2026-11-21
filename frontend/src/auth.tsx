import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { http, tokenStore, type User } from './api'

interface AuthState {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

async function fetchMe(): Promise<User | null> {
  try {
    const { data } = await http.get<User>('/auth/me')
    return data
  } catch {
    tokenStore.clear() // expired or invalid token
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(() => tokenStore.get() !== null)

  useEffect(() => {
    if (!tokenStore.get()) return
    void fetchMe().then((me) => {
      setUser(me)
      setLoading(false)
    })
  }, [])

  const login = async (username: string, password: string) => {
    const { data } = await http.post<{ token: string }>('/auth/login', { username, password })
    tokenStore.set(data.token)
    setUser(await fetchMe())
  }

  const logout = () => {
    tokenStore.clear()
    setUser(null)
  }

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
