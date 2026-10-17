// Genera el código de Scriptable (iOS) responsive, con el token embebido.
export function buildWidgetScript(base: string, token: string): string {
  const script = `// HappyTrading - Widget RESPONSIVE para la app "Scriptable" (iOS)
// 1) Instala "Scriptable" (App Store, gratis)
// 2) En Scriptable: + (nuevo script) -> pega TODO esto -> nombre: "HappyTrading"
// 3) Pantalla de inicio: deja pulsado -> + -> Scriptable -> elige el tamano (Small/Medium/Large)
//    -> edita el widget -> Script: HappyTrading
// El widget se adapta: SMALL = Clawd + %  ·  MEDIUM = + monto + frase  ·  LARGE = todo el detalle

const BASE = "__BASE__";
const TOKEN = "__TOKEN__";

const LINES = {
  profit: ["¡EL SHOW SIGUE! 🚀", "¡MÁS ES MÁS!", "¡ESTAMOS FORRADOS! 💸", "¿QUÍMICA? ¡DE LA BUENA!", "MI YATE NO SE PAGA SOLO 🛥️", "¡VÉNDEME ESTE BOLÍGRAFO!"],
  loss: ["NO ES REAL HASTA QUE LO VENDES 😅", "ESTOY BIEN... ESTOY BIEN 😰", "NO MIRES EL GRÁFICO 🙈", "¿QUIÉN VENDE? NADIE VENDE", "AGUANTA, ES SOLO UN BACHE"],
  idle: ["VIGILANDO EL MERCADO 👀", "EL SHOW SIGUE", "ESPERANDO LA JUGADA", "TÓMATE UN MARTINI 🍸", "MANTÉN LA CALMA Y COMPRA MÁS"]
};
function pick(mood) {
  const a = LINES[mood] || LINES.idle;
  return a[Math.floor(Math.random() * a.length)];
}
function money(n) { return "$" + Math.abs(Number(n) || 0).toFixed(2); }
function pct(n) { const v = Number(n) || 0; return (v >= 0 ? "+" : "") + v.toFixed(2) + "%"; }

async function getData() {
  try {
    const r = new Request(BASE + "/api/widget?token=" + TOKEN);
    return await r.loadJSON();
  } catch (e) { return null; }
}
async function getMascot() {
  try {
    // Clawd (mascota de Claude Code). El widget no anima GIFs: se ve su primer cuadro.
    const r = new Request(BASE + "/clawd.gif");
    return await r.loadImage();
  } catch (e) { return null; }
}

function baseWidget() {
  const w = new ListWidget();
  w.backgroundColor = new Color("#07070d");
  w.url = BASE;
  w.setPadding(10, 10, 10, 10);
  return w;
}

async function makeSmall(d, gain, mascot) {
  const w = baseWidget();
  w.addSpacer();
  const col = w.addStack();
  col.layoutVertically();
  col.centerAlignContent();
  if (mascot) { const im = col.addImage(mascot); im.imageSize = new Size(78, 78); }
  col.addSpacer(4);
  const p = col.addText(pct(d.pnlPct));
  p.font = Font.boldMonospacedSystemFont(20);
  p.textColor = new Color(gain ? "#00ff9d" : "#ff4d4d");
  p.centerAlignText();
  p.lineLimit = 1;
  p.minimumScaleFactor = 0.5;
  const v = col.addText((gain ? "+" : "-") + money(d.pnl));
  v.font = Font.systemFont(11);
  v.textColor = new Color(gain ? "#00ff9d" : "#ff4d4d");
  v.centerAlignText();
  v.lineLimit = 1;
  v.minimumScaleFactor = 0.6;
  w.addSpacer();
  return w;
}

async function makeMedium(d, gain, mascot, mood) {
  const w = baseWidget();
  const row = w.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  const left = row.addStack();
  left.layoutVertically();
  const t = left.addText("HAPPYTRADING 🦀"); t.font = Font.boldSystemFont(9); t.textColor = new Color("#00ff9d");
  const lbl = left.addText(gain ? "▲ GANANCIA" : "▼ PÉRDIDA"); lbl.font = Font.systemFont(8); lbl.textColor = new Color("#7984a6");
  const big = left.addText((gain ? "+" : "-") + money(d.pnl)); big.font = Font.boldMonospacedSystemFont(22); big.textColor = new Color(gain ? "#00ff9d" : "#ff4d4d"); big.lineLimit = 1; big.minimumScaleFactor = 0.5;
  const sub = left.addText(pct(d.pnlPct) + "  ·  " + (gain ? "+" : "-") + money(d.pnl) + "  ·  " + money(d.currentValue)); sub.font = Font.systemFont(8); sub.textColor = new Color("#00e5ff"); sub.lineLimit = 1;
  const ph = left.addText("“" + pick(mood) + "”"); ph.font = Font.systemFont(8); ph.textColor = new Color("#ffe600"); ph.lineLimit = 2;
  row.addSpacer(6);
  if (mascot) { const im = row.addImage(mascot); im.imageSize = new Size(56, 56); }
  return w;
}

async function makeLarge(d, gain, mascot, mood) {
  const w = baseWidget();
  const t = w.addText("HAPPYTRADING 🦀"); t.font = Font.boldSystemFont(12); t.textColor = new Color("#00ff9d"); t.centerAlignText();
  w.addSpacer(6);
  if (mascot) { const im = w.addImage(mascot); im.imageSize = new Size(118, 118); im.centerAlignImage(); }
  w.addSpacer(8);
  const lbl = w.addText(gain ? "▲ GANANCIA TOTAL" : "▼ PÉRDIDA TOTAL"); lbl.font = Font.systemFont(10); lbl.textColor = new Color("#7984a6"); lbl.centerAlignText();
  const big = w.addText((gain ? "+" : "-") + money(d.pnl)); big.font = Font.boldMonospacedSystemFont(34); big.textColor = new Color(gain ? "#00ff9d" : "#ff4d4d"); big.centerAlignText(); big.lineLimit = 1; big.minimumScaleFactor = 0.4;
  const p = w.addText(pct(d.pnlPct) + "  ·  " + (gain ? "+" : "-") + money(d.pnl)); p.font = Font.systemFont(12); p.textColor = new Color(gain ? "#00ff9d" : "#ff4d4d"); p.centerAlignText();
  w.addSpacer(6);
  const sub = w.addText("Valor: " + money(d.currentValue) + "  ·  Invertido: " + money(d.invested)); sub.font = Font.systemFont(9); sub.textColor = new Color("#00e5ff"); sub.centerAlignText(); sub.lineLimit = 1; sub.minimumScaleFactor = 0.6;
  const z = w.addText("Régimen: " + (d.zone || "—")); z.font = Font.systemFont(9); z.textColor = new Color("#7984a6"); z.centerAlignText();
  w.addSpacer(6);
  const ph = w.addText("“" + pick(mood) + "”"); ph.font = Font.systemFont(9); ph.textColor = new Color("#ffe600"); ph.centerAlignText(); ph.lineLimit = 2;
  if (d.top && d.top.length) {
    const tp = w.addText("Volátiles: " + d.top.map(function (x) { return x.symbol.split("_")[0].toUpperCase() + " " + Number(x.vol).toFixed(1) + "%"; }).join(" · "));
    tp.font = Font.systemFont(9); tp.textColor = new Color("#ff8a00"); tp.centerAlignText(); tp.lineLimit = 1; tp.minimumScaleFactor = 0.6;
  }
  return w;
}

async function make(family) {
  const d = (await getData()) || {};
  const mood = d.mood || "idle";
  const gain = Number(d.pnl) >= 0;
  const mascot = await getMascot();
  if (family === "small") return await makeSmall(d, gain, mascot);
  if (family === "large") return await makeLarge(d, gain, mascot, mood);
  return await makeMedium(d, gain, mascot, mood);
}

const fam = config.widgetFamily;
const widget = await make(fam);
if (config.runsInWidget) { Script.setWidget(widget); }
else {
  if (fam === "small") { await widget.presentSmall(); }
  else if (fam === "large") { await widget.presentLarge(); }
  else { await widget.presentMedium(); }
}
Script.complete();
`;
  return script.replace('__BASE__', base).replace('__TOKEN__', token);
}
