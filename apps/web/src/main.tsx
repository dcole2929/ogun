import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router'
import './styles.css'
import { RunsPage } from './pages/Runs.tsx'
import { RunDetailPage } from './pages/RunDetail.tsx'
import { FindingsPage } from './pages/Findings.tsx'
import { WorkersPage } from './pages/Workers.tsx'
import { CoveragePage } from './pages/Coverage.tsx'
import { SkillDetailPage, SkillsPage } from './pages/Skills.tsx'
import { RunnersPage } from './pages/Runners.tsx'
import { TokenGate } from './TokenGate.tsx'
import { SettingsPage } from './pages/Settings.tsx'

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // Runs and findings change under you while the runner works; a short stale time
      // beats a manual refresh button on every page.
      staleTime: 2000,
      refetchInterval: 5000,
      retry: 1,
    },
  },
})

function Shell() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          Ogun
          <small>software factory</small>
        </div>
        <nav className="nav">
          <NavLink to="/findings">Findings</NavLink>
          <NavLink to="/runs">Runs</NavLink>
          <NavLink to="/workers">Workers</NavLink>
          <NavLink to="/skills">Skills</NavLink>
          <NavLink to="/coverage">Coverage</NavLink>
          <NavLink to="/runners">Runners</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          {/* The findings inbox is the home screen: the runs list is how you debug the
              factory, the inbox is what the factory is for. */}
          <Route path="/" element={<Navigate to="/findings" replace />} />
          <Route path="/findings" element={<FindingsPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/skills/:project/:name" element={<SkillDetailPage />} />
          <Route path="/coverage" element={<CoveragePage />} />
          <Route path="/runners" element={<RunnersPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <TokenGate>
          <Shell />
        </TokenGate>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
