import React from 'react';

interface State {
  error: Error | null;
}

/**
 * Captura errores de render en cualquier parte del árbol y muestra una pantalla
 * retro con opción de recargar, en lugar de dejar la app en blanco.
 */
export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash-screen">
          <div className="pixel-panel">
            <h1 className="crash-title">💥 ERROR</h1>
            <p className="muted">Algo se rompió. Recarga para continuar.</p>
            <pre className="crash-detail">{String(this.state.error.message).slice(0, 200)}</pre>
            <button className="pixel-btn" onClick={() => window.location.reload()}>
              ⟳ RECARGAR
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
