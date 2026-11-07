import React, { useState } from 'react';
import axios from 'axios';
import '../styles/LoginPage.css';

// The public front door (sams-social-system.vercel.app). Besides the owner's
// sign-in it says what the tool is and links its Privacy Policy and Terms -
// YouTube's and TikTok's app reviews look at exactly this page.

// YouTube icon, drawn to YouTube's brand proportions (red rounded rectangle,
// white play triangle) - used only to name the YouTube feature.
function YouTubeIcon() {
  return (
    <svg className="login-yt" viewBox="0 0 28 20" width="28" height="20" role="img" aria-label="YouTube">
      <rect x="0" y="0" width="28" height="20" rx="5" ry="5" fill="#FF0000" />
      <path d="M11 5.5v9l7.8-4.5z" fill="#FFFFFF" />
    </svg>
  );
}

function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      const response = await axios.post(`${apiUrl}/auth/login`, {
        email,
        password,
      });

      onLogin(response.data.token);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-box">
        <img src="/brand/sams-logo-full.png" alt="Sam’s - More Than Pizza" className="login-logo" />
        <h2>Sam's Social Studio</h2>
        <p className="login-about">
          The internal publishing tool of Sam's Pizza Ltd, Tbilisi. It prepares our own
          restaurant videos and, after the owner approves each one, posts them to our own accounts on:
        </p>
        <div className="login-platforms">
          <span>Instagram</span>
          <span>Facebook</span>
          <span>TikTok</span>
          <span className="login-yt-name"><YouTubeIcon /> YouTube</span>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
            />
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" disabled={loading}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        <p className="login-note">Sign-in is for Sam's Pizza Ltd staff only - there is no public registration.</p>
        <footer className="login-footer">
          <a href="/privacy.html">Privacy Policy</a>
          <span aria-hidden="true">·</span>
          <a href="/terms.html">Terms of Service</a>
          <span aria-hidden="true">·</span>
          <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a>
        </footer>
      </div>
    </div>
  );
}

export default LoginPage;
