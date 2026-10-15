import React from 'react';

export function PixelButton({ children, onClick, variant = '', type = 'button', disabled }: any) {
  return (
    <button type={type} className={`pixel-btn ${variant}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Panel({ title, children, className = '' }: any) {
  return (
    <div className={`pixel-panel ${className}`}>
      {title && <div className="panel-title">{title}</div>}
      <div className="panel-body">{children}</div>
    </div>
  );
}

export function Stat({ label, value, accent = '' }: any) {
  return (
    <div className={`stat ${accent}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

export function Field({ label, help, children }: any) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {help && <small className="field-help">{help}</small>}
    </label>
  );
}

export function Toggle({ label, checked, onChange }: any) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
      <span className="toggle-label">{label}</span>
    </button>
  );
}
