// Genera el código de Scriptable (iOS) con el token del usuario embebido.
export function buildWidgetScript(base: string, token: string): string {
  const script = `// HappyTrading - Widget para la app "Scriptable" (iOS)
// 1) Instala "Scriptable" (App Store, gratis)
// 2) En Scriptable: + (nuevo script) -> pega TODO esto -> ponle nombre "HappyTrading"
// 3) En la pantalla de inicio: deja pulsado -> + -> Scriptable -> elige el widget (Mediano) -> edítalo -> Script: HappyTrading

const BASE = "__BASE__";
const TOKEN = "__TOKEN__";

const LINES = {
  profit: ["¡EL SHOW SIGUE! 🚀", "¡MÁS ES MÁS!", "¡ESTAMOS FORRADOS! 💸", "¿QUÍMICA? ¡DE LA BUENA!", "MI YATE NO SE PAGA SOLO 🛥️", "¡VÉNDEME ESTE BOLÍGRAFO!", "EL MERCADO ME AMA"],
  loss: ["NO ES REAL HASTA QUE LO VENDES 😅", "ESTOY BIEN... ESTOY BIEN 😰", "NO MIRES EL GRÁFICO 🙈", "¿QUIÉN VENDE? NADIE VENDE", "AGUANTA, ES SOLO UN BACHE", "RESPIRA... RES... PIRA 😮‍💨"],
  idle: ["VIGILANDO EL MERCADO 👀", "EL SHOW SIGUE", "ESPERANDO LA JUGADA", "TÓMATE UN MARTINI 🍸", "MANTÉN LA CALMA Y COMPRA MÁS"]
};
function pick(mood) {
  const a = LINES[mood] || LINES.idle;
  return a[Math.floor(Math.random() * a.length)];
}
async function getData() {
  try {
    const r = new Request(BASE + "/api/widget?token=" + TOKEN);
    return await r.loadJSON();
  } catch (e) { return null; }
}
async function getWolf() {
  try {
    const r = new Request(BASE + "/wolf.png");
    return await r.loadImage();
  } catch (e) { return null; }
}
async function make() {
  const d = (await getData()) || {};
  const mood = d.mood || "idle";
  const gain = Number(d.pnl) >= 0;
  const w = new ListWidget();
  w.backgroundColor = new Color("#07070d");
  w.url = BASE;

  const row = w.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  const left = row.addStack();
  left.layoutVertically();

  const t = left.addText("HAPPYTRADING 🐺");
  t.font = Font.boldSystemFont(10);
  t.textColor = new Color("#00ff9d");

  const lbl = left.addText(gain ? "▲ GANANCIA" : "▼ PÉRDIDA");
  lbl.font = Font.systemFont(9);
  lbl.textColor = new Color("#7984a6");

  const big = left.addText((gain ? "+" : "-") + "$" + Math.abs(Number(d.pnl) || 0).toFixed(2));
  big.font = Font.boldMonospacedSystemFont(22);
  big.textColor = new Color(gain ? "#00ff9d" : "#ff4d4d");

  const sub = left.addText(((Number(d.pnlPct) || 0) >= 0 ? "+" : "") + (Number(d.pnlPct) || 0).toFixed(2) + "%  ·  $" + (Number(d.currentValue) || 0).toFixed(2));
  sub.font = Font.systemFont(8);
  sub.textColor = new Color("#00e5ff");

  const ph = left.addText("“" + pick(mood) + "”");
  ph.font = Font.systemFont(8);
  ph.textColor = new Color("#ffe600");

  row.addSpacer(6);
  const wolf = await getWolf();
  if (wolf) {
    const im = row.addImage(wolf);
    im.imageSize = new Size(56, 68);
  }
  return w;
}
const widget = await make();
if (config.runsInWidget) { Script.setWidget(widget); }
else { await widget.presentMedium(); }
Script.complete();
`;
  return script.replace('__BASE__', base).replace('__TOKEN__', token);
}
