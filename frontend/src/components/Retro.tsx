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

function CountUp({ n }: { n: number }) {
  const [v, setV] = React.useState(n);
  const from = React.useRef(n);
  React.useEffect(() => {
    const a = from.current;
    const b = n;
    if (a === b) return;
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 700);
      const e = 1 - Math.pow(1 - p, 3);
      setV(a + (b - a) * e);
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = b;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [n]);
  return <>{Math.round(v).toLocaleString('es-MX')}</>;
}

export function Stat({ label, value, accent = '' }: any) {
  return (
    <div className={`stat ${accent}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{typeof value === 'number' ? <CountUp n={value} /> : value}</div>
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
