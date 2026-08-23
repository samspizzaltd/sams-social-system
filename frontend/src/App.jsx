import React, { useState } from 'react';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';

function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
  };

  const handleLogin = (newToken) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
  };

  return (
    <div className="app">
      {!token ? (
        <LoginPage onLogin={handleLogin} />
      ) : (
        <DashboardPage token={token} onLogout={handleLogout} />
      )}
    </div>
  );
}

export default App;
