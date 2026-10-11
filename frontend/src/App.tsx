import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import World from './pages/World';
import Overview from './pages/Overview';
import Comparisons from './pages/Comparisons';
import Couples from './pages/Couples';
import CoupleDetail from './pages/CoupleDetail';
import Agents from './pages/Agents';
import AgentDetail from './pages/AgentDetail';
import Policy from './pages/Policy';
import Governance from './pages/Governance';
import NewExperiment from './pages/NewExperiment';
import { ArmLabelsProvider } from './arms';
import { ExperimentProvider, useExperiment, withExperimentQuery } from './experiment';
import { ErrorBox } from './components/Status';
import { interventionSummary } from './arms';

const NAV: [string, string][] = [
  ['/world', 'World'],
  ['/overview', 'Overview'],
  ['/comparisons', 'Comparisons'],
  ['/couples', 'Couples'],
  ['/agents', 'Agents'],
  ['/policy', 'Policy'],
  ['/governance', 'Governance'],
];

function TopBar() {
  const exp = useExperiment();
  const location = useLocation();
  return (
    <header className="topbar" aria-label="Experiment">
      <label>
        Experiment
        <select
          aria-label="Experiment"
          data-testid="experiment-select"
          value={exp.unknown ? '' : (exp.name ?? '')}
          onChange={(e) => exp.select(e.target.value)}
          disabled={exp.items.length === 0}
        >
          {exp.items.length === 0 ? <option value="">{exp.loading ? 'Loading...' : 'Single experiment'}</option> : null}
          {exp.unknown ? <option value="">Choose an experiment</option> : null}
          {exp.items.map((it) => (
            <option key={it.name} value={it.name}>
              {it.name} ({interventionSummary(it)})
            </option>
          ))}
        </select>
      </label>
      {exp.error ? <span className="muted">Experiment list unavailable: {exp.error}</span> : null}
      <NavLink to={withExperimentQuery('/new', exp.name)} className={({ isActive }) => `newlink${isActive ? ' active' : ''}`} aria-current={location.pathname === '/new' ? 'page' : undefined}>
        New experiment
      </NavLink>
    </header>
  );
}

function Shell() {
  const exp = useExperiment();
  const key = exp.name ?? 'single';
  return (
    <div className="shell">
      <nav className="nav" aria-label="Pages">
        <div className="brand">LoveWorld</div>
        {NAV.map(([to, label]) => (
          <NavLink key={to} to={withExperimentQuery(to, exp.name)} className={({ isActive }) => (isActive ? 'active' : '')}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main className="main">
        <TopBar />
        {exp.unknown ? (
          <div data-testid="unknown-experiment">
            <ErrorBox message={`there is no experiment named "${exp.unknown}" in the results root. Choose one from the list above.`} />
          </div>
        ) : (
        <ArmLabelsProvider key={key}>
          <Routes key={key}>
            <Route path="/" element={<Navigate to={withExperimentQuery('/world', exp.name)} replace />} />
            <Route path="/world" element={<World />} />
            <Route path="/overview" element={<Overview />} />
            <Route path="/comparisons" element={<Comparisons />} />
            <Route path="/couples" element={<Couples />} />
            <Route path="/couples/:id" element={<CoupleDetail />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/:id" element={<AgentDetail />} />
            <Route path="/policy" element={<Policy />} />
            <Route path="/governance" element={<Governance />} />
            <Route path="/new" element={<NewExperiment />} />
            <Route path="*" element={<Navigate to={withExperimentQuery('/world', exp.name)} replace />} />
          </Routes>
        </ArmLabelsProvider>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ExperimentProvider>
      <Shell />
    </ExperimentProvider>
  );
}
