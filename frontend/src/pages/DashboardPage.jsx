import React, { useState, useEffect } from 'react';
import axios from 'axios';
import '../styles/DashboardPage.css';

function DashboardPage({ token, onLogout }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await axios.get('http://localhost:3000/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        setUser(response.data);
      } catch (err) {
        console.error('Failed to fetch user:', err);
        onLogout();
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, [token, onLogout]);

  if (loading) return <div className="loading">Loading...</div>;
  if (!user) return null;

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="header-left">
          <h1>🍕 Sam's Social Media Dashboard</h1>
          <p>Phase 1: Foundation</p>
        </div>
        <div className="header-right">
          <span>{user.email}</span>
          <button onClick={onLogout} className="logout-btn">Logout</button>
        </div>
      </header>

      <nav className="dashboard-nav">
        <button
          className={`nav-btn ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          📊 Overview
        </button>
        <button
          className={`nav-btn ${activeTab === 'content' ? 'active' : ''}`}
          onClick={() => setActiveTab('content')}
        >
          📝 Content
        </button>
        <button
          className={`nav-btn ${activeTab === 'analytics' ? 'active' : ''}`}
          onClick={() => setActiveTab('analytics')}
        >
          📈 Analytics
        </button>
        <button
          className={`nav-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          ⚙️ Settings
        </button>
      </nav>

      <main className="dashboard-content">
        {activeTab === 'overview' && (
          <div className="tab-content">
            <h2>Overview</h2>
            <div className="status-grid">
              <div className="card">
                <h3>Database</h3>
                <p className="status-badge success">Initialized</p>
              </div>
              <div className="card">
                <h3>Authentication</h3>
                <p className="status-badge success">Active</p>
              </div>
              <div className="card">
                <h3>Content API</h3>
                <p className="status-badge warning">Ready</p>
              </div>
              <div className="card">
                <h3>Dashboard</h3>
                <p className="status-badge success">Running</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'content' && (
          <div className="tab-content">
            <h2>Content Management</h2>
            <p style={{ color: '#666' }}>Phase 1: Coming soon in Week 2</p>
          </div>
        )}

        {activeTab === 'analytics' && (
          <div className="tab-content">
            <h2>Analytics</h2>
            <p style={{ color: '#666' }}>Phase 5: Analytics dashboards launching in weeks 10-11</p>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="tab-content">
            <h2>Settings</h2>
            <div className="settings-section">
              <h3>Business Configuration</h3>
              <p><strong>Owner:</strong> {user.email}</p>
              <p><strong>Role:</strong> {user.role}</p>
              <p><strong>Status:</strong> Active</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default DashboardPage;
