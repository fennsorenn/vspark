import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Project } from '../api/client';

export function Home() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getProjects()
      .then(setProjects)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const project = await api.createProject(
        newName.trim(),
        newDesc.trim() || undefined
      );
      setProjects((prev) => [...prev, project]);
      setShowNewForm(false);
      setNewName('');
      setNewDesc('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete project "${name}"? This cannot be undone.`))
      return;
    try {
      await api.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to delete project');
    }
  };

  const cardStyle: React.CSSProperties = {
    background: '#1e1e1e',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    transition: 'border-color 0.15s',
  };

  const btnStyle: React.CSSProperties = {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '6px 14px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  };

  const inputStyle: React.CSSProperties = {
    background: '#2a2a2a',
    border: '1px solid #3a3a3a',
    borderRadius: 6,
    color: '#fff',
    padding: '8px 12px',
    fontSize: 14,
    outline: 'none',
    width: '100%',
  };

  return (
    <div
      style={{
        background: '#0f0f0f',
        minHeight: '100vh',
        color: '#e0e0e0',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '20px 32px',
          borderBottom: '1px solid #1e1e1e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: '#fff',
            letterSpacing: -0.5,
          }}
        >
          vspark
        </span>
        <button style={btnStyle} onClick={() => setShowNewForm(true)}>
          + New Project
        </button>
      </div>

      <div style={{ padding: '32px' }}>
        {error && (
          <div
            style={{
              background: '#3a1a1a',
              border: '1px solid #7a2a2a',
              borderRadius: 6,
              padding: '10px 16px',
              color: '#f88',
              marginBottom: 24,
            }}
          >
            {error}
          </div>
        )}

        {/* New Project Form */}
        {showNewForm && (
          <div
            style={{
              background: '#1e1e1e',
              border: '1px solid #2a2a2a',
              borderRadius: 8,
              padding: 24,
              marginBottom: 32,
              maxWidth: 480,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 15 }}>
              New Project
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                style={inputStyle}
                placeholder="Project name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                autoFocus
              />
              <input
                style={inputStyle}
                placeholder="Description (optional)"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  style={btnStyle}
                  onClick={handleCreate}
                  disabled={creating || !newName.trim()}
                >
                  {creating ? 'Creating…' : 'Create'}
                </button>
                <button
                  style={{ ...btnStyle, background: '#2a2a2a' }}
                  onClick={() => {
                    setShowNewForm(false);
                    setNewName('');
                    setNewDesc('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Projects grid */}
        {loading ? (
          <div style={{ color: '#888', fontSize: 14 }}>Loading projects…</div>
        ) : projects.length === 0 ? (
          <div
            style={{
              color: '#666',
              fontSize: 14,
              textAlign: 'center',
              marginTop: 64,
            }}
          >
            No projects yet. Click "New Project" to get started.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 16,
            }}
          >
            {projects.map((p) => (
              <div key={p.id} style={cardStyle}>
                <div style={{ fontWeight: 600, fontSize: 16, color: '#fff' }}>
                  {p.name}
                </div>
                {p.description && (
                  <div style={{ fontSize: 13, color: '#888', lineHeight: 1.5 }}>
                    {p.description}
                  </div>
                )}
                <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
                  Created {new Date(p.createdAt).toLocaleDateString()}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    style={btnStyle}
                    onClick={() => navigate(`/editor/${p.id}`)}
                  >
                    Open
                  </button>
                  <button
                    style={{
                      ...btnStyle,
                      background: '#3a1a1a',
                      color: '#f88',
                    }}
                    onClick={() => handleDelete(p.id, p.name)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
