// Genera el código de Scriptable (iOS) responsive, con el token embebido.
export function buildWidgetScript(base: string, token: string): string {
  const script = `// HappyTrading - Widget RESPONSIVE para la app "Scriptable" (iOS)
// 1) Instala "Scriptable" (App Store, gratis)
// 2) En Scriptable: + (nuevo script) -> pega TODO esto -> nombre: "HappyTrading"
// 3) Pantalla de inicio: deja pulsado -> + -> Scriptable -> elige el tamano (Small/Medium/Large)
//    -> edita el widget -> Script: HappyTrading
// El widget se centra en LA BOVEDA (lo que ya llevamos GANADO).
//   SMALL  = Clawd + $ de la boveda
//   MEDIUM = + cuanto falta para los $50 + frase
//   LARGE  = + total ganado / cobrado / volatiles

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
function bar(p) {
  const n = Math.max(0, Math.min(10, Math.round((Number(p) || 0) * 10)));
  let s = "";
  for (let i = 0; i < 10; i++) s += i < n ? "█" : "░";
  return s;
}

async function getData() {
  try {
    const r = new Request(BASE + "/api/widget?token=" + TOKEN);
    return await r.loadJSON();
  } catch (e) { return null; }
}
async function getMascot() {
  try {
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
function vaultTitle(t) {
  t.font = Font.boldSystemFont(9);
  t.textColor = new Color("#ffe600");
  return t;
}

async function makeSmall(d, mascot) {
  const w = baseWidget();
  w.addSpacer();
  const col = w.addStack();
  col.layoutVertically();
  col.centerAlignContent();
  if (mascot) { const im = col.addImage(mascot); im.imageSize = new Size(66, 66); }
  col.addSpacer(2);
  const v = col.addText("🏺 " + money(d.vault));
  v.font = Font.boldMonospacedSystemFont(22);
  v.textColor = new Color("#37d67a");
  v.centerAlignText();
  v.lineLimit = 1;
  v.minimumScaleFactor = 0.5;
  const s = col.addText("de " + money(d.goal) + "  " + Math.round((Number(d.progress) || 0) * 100) + "%");
  s.font = Font.systemFont(9);
  s.textColor = new Color("#7984a6");
  s.centerAlignText();
  const b = col.addText(bar(d.progress));
  b.font = Font.systemFont(9);
  b.textColor = new Color("#37d67a");
  b.centerAlignText();
  w.addSpacer();
  return w;
}

async function makeMedium(d, mascot, mood) {
  const w = baseWidget();
  const row = w.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  const left = row.addStack();
  left.layoutVertically();
  const t = left.addText("🏺 BÓVEDA (GANADO)"); vaultTitle(t);
  const big = left.addText(money(d.vault));
  big.font = Font.boldMonospacedSystemFont(26);
  big.textColor = new Color("#37d67a");
  big.lineLimit = 1;
  big.minimumScaleFactor = 0.5;
  const sub = left.addText(bar(d.progress) + "  " + Math.round((Number(d.progress) || 0) * 100) + "% de " + money(d.goal));
  sub.font = Font.systemFont(9);
  sub.textColor = new Color("#00e5ff");
  sub.lineLimit = 1;
  const falta = Math.max(0, (Number(d.goal) || 50) - (Number(d.vault) || 0));
  const f = left.addText("faltan " + money(falta) + " para tu CLABE 🏦");
  f.font = Font.systemFont(8);
  f.textColor = new Color("#7984a6");
  const ph = left.addText("“" + pick(mood) + "”");
  ph.font = Font.systemFont(8);
  ph.textColor = new Color("#ffe600");
  ph.lineLimit = 2;
  row.addSpacer(6);
  if (mascot) { const im = row.addImage(mascot); im.imageSize = new Size(54, 54); }
  return w;
}

async function makeLarge(d, mascot, mood) {
  const w = baseWidget();
  const t = w.addText("HAPPYTRADING 🦀"); t.font = Font.boldSystemFont(12); t.textColor = new Color("#00ff9d"); t.centerAlignText();
  w.addSpacer(4);
  if (mascot) { const im = w.addImage(mascot); im.imageSize = new Size(104, 104); im.centerAlignImage(); }
  w.addSpacer(6);
  const lbl = w.addText("🏺 BÓVEDA (LO GANADO)"); lbl.font = Font.boldSystemFont(10); lbl.textColor = new Color("#ffe600"); lbl.centerAlignText();
  const big = w.addText(money(d.vault) + " de " + money(d.goal)); big.font = Font.boldMonospacedSystemFont(28); big.textColor = new Color("#37d67a"); big.centerAlignText(); big.lineLimit = 1; big.minimumScaleFactor = 0.4;
  const b = w.addText(bar(d.progress) + "  " + Math.round((Number(d.progress) || 0) * 100) + "%"); b.font = Font.systemFont(11); b.textColor = new Color("#37d67a"); b.centerAlignText();
  w.addSpacer(4);
  const e = w.addText("Ganado en total: " + money(d.totalEarned) + "  ·  Ya cobrado: " + money(d.totalWithdrawn)); e.font = Font.systemFont(9); e.textColor = new Color("#00e5ff"); e.centerAlignText(); e.lineLimit = 1; e.minimumScaleFactor = 0.6;
  const z = w.addText("Valor: " + money(d.currentValue) + "  ·  Invertido: " + money(d.invested)); z.font = Font.systemFont(9); z.textColor = new Color("#7984a6"); z.centerAlignText(); z.lineLimit = 1; z.minimumScaleFactor = 0.6;
  w.addSpacer(4);
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
  const mascot = await getMascot();
  if (family === "small") return await makeSmall(d, mascot);
  if (family === "large") return await makeLarge(d, mascot, mood);
  return await makeMedium(d, mascot, mood);
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
