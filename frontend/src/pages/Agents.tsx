import { useState } from 'react';
import { ExpLink, useExpNavigate } from '../nav';

export default function Agents() {
  const navigate = useExpNavigate();
  const [id, setId] = useState('');
  const go = () => {
    const n = Number(id);
    if (Number.isInteger(n) && n >= 0) navigate(`/agents/${n}`);
  };
  return (
    <div>
      <h1>Agents</h1>
      <p className="muted">Agents are numbered from 0; the members of couple k are agents 2k and 2k+1.</p>
      <div className="card">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <label>
            Agent id
            <input type="number" min={0} value={id} onChange={(e) => setId(e.target.value)} aria-label="Agent id" />
          </label>
          <button type="submit" disabled={id === ''}>Open</button>
        </form>
        <p className="muted">
          Or browse <ExpLink to="/couples">couples</ExpLink> and open a member from there.
        </p>
      </div>
    </div>
  );
}
