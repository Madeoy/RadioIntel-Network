import React, { useState, useEffect } from 'react';
import './App.css';

export default function App() {
  const [activeTab, setActiveTab] = useState('feed');
  const [metrics, setMetrics] = useState({
    activeStreams: 14,
    adsDetectedToday: '1,284',
    estimatedValue: '$42,500',
    systemStatus: 'Optimal'
  });

  const [events, setEvents] = useState([
    { id: 1, time: '5:48 PM', station: 'WKTU 103.5 NYC', advertiser: 'Burger King', format: '30s Spot', confidence: '99.4%' },
    { id: 2, time: '5:46 PM', station: 'KIIS-FM LA', advertiser: 'Geico', format: '15s Spot', confidence: '98.1%' },
    { id: 3, time: '5:42 PM', station: 'KOST 103.5 LA', advertiser: 'State Farm', format: '60s Spot', confidence: '97.8%' }
  ]);

  return (
    <div className="radio-intel-container">
      {/* Top Header Bar */}
      <header className="app-header">
        <div className="brand">
          <div className="status-dot"></div>
          <h1>RadioIntel Network</h1>
        </div>
        <div className="user-badge">Node: Nashville-01</div>
      </header>

      {/* Metrics Row */}
      <section className="metrics-grid">
        <div className="metric-card">
          <span className="label">Active Streams</span>
          <span className="value">{metrics.activeStreams}</span>
        </div>
        <div className="metric-card">
          <span className="label">Ads Captured</span>
          <span className="value">{metrics.adsDetectedToday}</span>
        </div>
        <div className="metric-card">
          <span className="label">Est. Ad Spend</span>
          <span className="value">{metrics.estimatedValue}</span>
        </div>
        <div className="metric-card">
          <span className="label">System Status</span>
          <span className="value green">{metrics.systemStatus}</span>
        </div>
      </section>

      {/* Main Content Area */}
      <main className="main-content">
        <div className="section-header">
          <h2>Live Ad Ingestion Feed</h2>
          <span className="live-badge">REAL-TIME</span>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Station</th>
                <th>Advertiser</th>
                <th>Format</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td>{ev.time}</td>
                  <td className="bold">{ev.station}</td>
                  <td>{ev.advertiser}</td>
                  <td>{ev.format}</td>
                  <td><span className="conf-pill">{ev.confidence}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
