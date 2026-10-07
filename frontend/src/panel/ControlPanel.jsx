import React, { useState } from 'react';
import '../styles/ControlPanel.css';
import { Overview, ContentSection, CyclesSection } from './sections/core';
import {
  AnalyticsSection, GrowthSection, MonetizationSection,
  AgentsSection, SettingsSection
} from './sections/growth';

const MENU = [
  {
    id: 'dashboard', label: 'Dashboard', icon: '📊',
    subs: [{ id: 'overview', label: 'Overview' }]
  },
  {
    id: 'content', label: 'Content Studio', icon: '📝',
    subs: [
      { id: 'queue', label: 'Approval Queue' },
      { id: 'approved', label: 'Approved' },
      { id: 'rejected', label: 'Rejected' }
    ]
  },
  {
    id: 'cycles', label: 'Autonomous Cycles', icon: '🔄',
    subs: [
      { id: 'run', label: 'Run & Monitor' },
      { id: 'history', label: 'History' }
    ]
  },
  {
    id: 'analytics', label: 'Analytics', icon: '📈',
    subs: [{ id: 'platforms', label: 'Platform Performance' }]
  },
  {
    id: 'growth', label: 'Growth Intelligence', icon: '🌱',
    subs: [
      { id: 'gaps', label: 'Trends & Content Gaps' },
      { id: 'schedule', label: 'Posting Schedule' }
    ]
  },
  {
    id: 'money', label: 'Monetization', icon: '💰',
    subs: [
      { id: 'ledger', label: 'Revenue Ledger' },
      { id: 'record', label: 'Record Income' },
      { id: 'opportunities', label: 'Opportunities' }
    ]
  },
  {
    id: 'agents', label: 'Agents', icon: '🤖',
    subs: [{ id: 'fleet', label: 'Agent Fleet' }]
  },
  {
    id: 'settings', label: 'Settings', icon: '⚙️',
    subs: [
      { id: 'system', label: 'System Health' },
      { id: 'brand', label: 'Brand & Automation' },
      { id: 'connections', label: 'Platform Connections' }
    ]
  }
];

function ControlPanel({ user, onLogout }) {
  const [active, setActive] = useState({ cat: 'dashboard', sub: 'overview' });
  const [openCats, setOpenCats] = useState(['dashboard', 'content', 'cycles']);

  const toggleCat = (catId) => {
    setOpenCats((prev) =>
      prev.includes(catId) ? prev.filter((c) => c !== catId) : [...prev, catId]
    );
  };

  const select = (cat, sub) => {
    setActive({ cat, sub });
    if (!openCats.includes(cat)) setOpenCats((prev) => [...prev, cat]);
  };

  const renderSection = () => {
    const key = `${active.cat}/${active.sub}`;
    switch (key) {
      case 'dashboard/overview': return <Overview goTo={select} />;
      case 'content/queue': return <ContentSection status="pending" key="pending" />;
      case 'content/approved': return <ContentSection status="approved" key="approved" />;
      case 'content/rejected': return <ContentSection status="rejected" key="rejected" />;
      case 'cycles/run': return <CyclesSection mode="run" key="run" />;
      case 'cycles/history': return <CyclesSection mode="history" key="history" />;
      case 'analytics/platforms': return <AnalyticsSection />;
      case 'growth/gaps': return <GrowthSection view="gaps" key="gaps" />;
      case 'growth/schedule': return <GrowthSection view="schedule" key="schedule" />;
      case 'money/ledger': return <MonetizationSection view="ledger" key="ledger" />;
      case 'money/record': return <MonetizationSection view="record" key="record" />;
      case 'money/opportunities': return <MonetizationSection view="opportunities" key="opps" />;
      case 'agents/fleet': return <AgentsSection />;
      case 'settings/system': return <SettingsSection view="system" key="system" />;
      case 'settings/brand': return <SettingsSection view="brand" key="brand" />;
      case 'settings/connections': return <SettingsSection view="connections" key="conn" />;
      default: return <Overview goTo={select} />;
    }
  };

  const activeCat = MENU.find((m) => m.id === active.cat);
  const activeSub = activeCat && activeCat.subs.find((s) => s.id === active.sub);

  return (
    <div className="cp">
      <aside className="cp-sidebar">
        <div className="cp-brand">
          <span className="cp-brand-icon">🍕</span>
          <div>
            <div className="cp-brand-name">Sam&apos;s Social</div>
            <div className="cp-brand-sub">Control Panel</div>
          </div>
        </div>
        <nav className="cp-nav">
          {MENU.map((cat) => (
            <div key={cat.id} className="cp-nav-group">
              <button
                className={`cp-nav-cat ${active.cat === cat.id ? 'active' : ''}`}
                onClick={() => toggleCat(cat.id)}
              >
                <span className="cp-nav-icon">{cat.icon}</span>
                <span className="cp-nav-label">{cat.label}</span>
                <span className="cp-nav-chevron">{openCats.includes(cat.id) ? '▾' : '▸'}</span>
              </button>
              {openCats.includes(cat.id) && (
                <div className="cp-nav-subs">
                  {cat.subs.map((sub) => (
                    <button
                      key={sub.id}
                      className={`cp-nav-sub ${active.cat === cat.id && active.sub === sub.id ? 'active' : ''}`}
                      onClick={() => select(cat.id, sub.id)}
                    >
                      {sub.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="cp-sidebar-footer">
          <div className="cp-user">{user && user.email}</div>
          <button className="cp-logout" onClick={onLogout}>Log out</button>
        </div>
      </aside>

      <main className="cp-main">
        <header className="cp-topbar">
          <div className="cp-breadcrumb">
            {activeCat ? activeCat.label : ''}
            {activeSub ? ` / ${activeSub.label}` : ''}
          </div>
        </header>
        <div className="cp-content">{renderSection()}</div>
      </main>
    </div>
  );
}

export default ControlPanel;
