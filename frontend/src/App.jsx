import React, { useState, useEffect } from 'react';
import axios from 'axios';
import LoginPage from './pages/LoginPage';
import ControlPanel from './panel/ControlPanel';

function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(localStorage.getItem('token')));

  useEffect(() => {
    if (!token) { setUser(null); return; }
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    axios.get(`${apiUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 })
      .then((r) => setUser(r.data))
      .catch(() => {
        localStorage.removeItem('token');
        setToken(null);
      })
      .finally(() => setChecking(false));
  }, [token]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  };

  const handleLogin = (newToken) => {
    localStorage.setItem('token', newToken);
    setChecking(true);
    setToken(newToken);
  };

  if (!token) return <div className="app"><LoginPage onLogin={handleLogin} /></div>;
  if (checking || !user) return <div className="app" style={{ padding: 40, color: '#8a827d' }}>Loading…</div>;

  return (
    <div className="app">
      <ControlPanel user={user} onLogout={handleLogout} />
    </div>
  );
}

export default App;
