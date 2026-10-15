import React from 'react';
import { Panel } from '../components/Retro';

function Row({ emoji, title, children }: any) {
  return (
    <div className="how-row">
      <div className="how-emoji">{emoji}</div>
      <div>
        <div className="how-title">{title}</div>
        <div className="how-text">{children}</div>
      </div>
    </div>
  );
}

export default function HowItWorks() {
  return (
    <div>
      <div className="spread mb">
        <h2 style={{ fontFamily: 'var(--font-pixel)', fontSize: 14, color: 'var(--green)' }}>
          ❓ ¿CÓMO FUNCIONA?
        </h2>
        <span className="floaty" style={{ fontSize: 26 }}>🤝</span>
      </div>
      <p className="muted mb">Explicado simple, sin tecnicismos:</p>

      <Panel title="🧠 DOS CEREBROS: EL QUE PIENSA Y EL QUE ACTÚA">
        <Row emoji="🤖" title="LA IA (el cerebro)">
          Cada <b>1 minuto</b> mira el mercado y <b>decide</b> qué hacer, y deja un <b>plan</b>
          (por ejemplo: «compra XRP si baja a $24»). <b>No compra ni vende directamente</b>.
        </Row>
        <Row emoji="⚙️" title="EL WORKER (el músculo, sin IA)">
          Cada <b>20 segundos</b> mira los precios y <b>ejecuta el plan</b> cuando se cumple.
          Es rápido y no gasta tokens. Como un empleado aplicado que solo sigue órdenes.
        </Row>
      </Panel>

      <Panel title="🔁 EL CICLO, PASO A PASO">
        <div className="how-step"><b>1.</b> La IA lee tu saldo y los precios de Bitso.</div>
        <div className="how-step"><b>2.</b> Le pregunta a la IA (Gemini/OpenRouter) por cada moneda → <b>COMPRAR / ESPERAR / VENDER</b>.</div>
        <div className="how-step"><b>3.</b> Si dice comprar, deja una <b>escalera</b> (DCA): «compra si baja a X, luego a Y, luego a Z» (por tramos, no todo de golpe).</div>
        <div className="how-step"><b>4.</b> Si ya tienes la moneda, deja «vende si sube a T (ganancia) o baja a S (pérdida)».</div>
        <div className="how-step"><b>5.</b> El <b>Worker</b> vigila cada 20 s y ejecuta cuando el precio llega al nivel.</div>
        <div className="how-step"><b>6.</b> Si un plan expira (8 h) sin cumplirse, la IA lo renueva o lo cambia.</div>
      </Panel>

      <Panel title="🔧 ¿LA ESTRATEGIA SE AJUSTA SOLA?">
        <Row emoji="✅" title="Sí, se ajusta">
          Cada minuto la IA <b>re-analiza todo</b> y actualiza su opinión (el mercado cambia).
        </Row>
        <Row emoji="⏸️" title="…pero sin volverse loca">
          Un plan que ya está <b>activo se respeta</b> hasta que se ejecuta o expira. No se anda
          cancelando y recreando a cada minuto (eso sería un caos de órdenes).
        </Row>
        <Row emoji="🌦️" title="El clima del mercado">
          Cada <b>30 min</b> se calcula el <b>Régimen</b> (RISK-ON / NEUTRAL / RISK-OFF). Si está
          en rojo, el bot <b>deja de comprar</b> por seguridad.
        </Row>
      </Panel>

      <Panel title="🛡️ QUÉ TE PROTEGE">
        <div className="how-step"><b>Stop-Loss / Take-Profit:</b> vende solo al tocar los niveles que configuraste.</div>
        <div className="how-step"><b>Reserva de efectivo:</b> guarda un % para no gastar todo.</div>
        <div className="how-step"><b>Régimen:</b> no compra cuando el mercado está en rojo.</div>
        <div className="how-step"><b>Mínimos de Bitso:</b> no manda órdenes inválidas.</div>
        <div className="how-step"><b>Tu perfil:</b> conservador, equilibrado o agresivo (más/menos operaciones).</div>
      </Panel>

      <Panel title="💰 GANANCIAS REALES">
        <div className="how-step">Los <b>depósitos por transferencia NO cuentan como ganancia</b>.</div>
        <div className="how-step">
          <b>Ganancia = valor actual − (inversión inicial + depósitos)</b>.
        </div>
        <div className="how-step muted">Así ves tu ganancia de verdad, no el dinero que tú metiste.</div>
      </Panel>

      <p className="muted center" style={{ fontFamily: 'var(--font-pixel)', fontSize: 8, marginTop: 10 }}>
        RESUMEN: LA IA PIENSA Y DEJA EL PLAN · EL WORKER LO EJECUTA · TÚ VIGILAS LAS GANANCIAS 💛
      </p>
    </div>
  );
}
