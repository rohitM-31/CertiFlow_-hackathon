import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
import { Header } from './components'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { BatchPage } from './pages/BatchPage'
import { VerifyPage } from './pages/VerifyPage'
import { CertificatesPage } from './pages/CertificatesPage'
import { PhonePage } from './pages/PhonePage'

function AppRoutes() {
  const { user, loading } = useAuth()
  if (loading) return null

  return (
    <>
      <Header />
      <Routes>
        {/* Public: no login */}
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/verify/:number" element={<VerifyPage />} />
        <Route path="/phone" element={<PhonePage />} />

        {user ? (
          <>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/batches/:id" element={<BatchPage />} />
            {user.role === 'STATE' && <Route path="/certificates" element={<CertificatesPage />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        ) : (
          <Route path="*" element={<LoginPage />} />
        )}
      </Routes>
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
