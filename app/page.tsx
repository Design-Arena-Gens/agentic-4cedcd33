'use client';

import { useState } from 'react';
import './globals.css';
import ArmSimulator from '../components/ArmSimulator';

export default function Page() {
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);

  return (
    <div className="container">
      <div className="header">
        <h1>Robotic Arm Sorter</h1>
        <div className="subtitle">Picks and places boxes into color bins (Red, Green, Blue)</div>
      </div>

      <div className="panel">
        <div className="controls">
          <button className="button" onClick={() => setRunning((v) => !v)}>
            {running ? 'Pause' : 'Start'}
          </button>
          <button className="button secondary" onClick={() => window.dispatchEvent(new CustomEvent('sim-reset'))}>
            Reset
          </button>
          <label>
            Speed
            <input
              className="range"
              type="range"
              min={0.25}
              max={3}
              step={0.25}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              style={{ marginLeft: 8, verticalAlign: 'middle' }}
            />
            <span style={{ marginLeft: 8 }}>{speed.toFixed(2)}x</span>
          </label>
        </div>
      </div>

      <div className="panel canvasWrap">
        <ArmSimulator running={running} speed={speed} />
      </div>

      <div className="footer">Tip: Drag on canvas to pan. Use mouse wheel to zoom.</div>
    </div>
  );
}
