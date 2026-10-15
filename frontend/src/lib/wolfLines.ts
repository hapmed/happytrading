// Frases del lobo: icónicas (inspiradas en la película) + inventadas hilarantes.
export const WOLF_LINES: Record<string, string[]> = {
  profit: [
    '¡EL SHOW SIGUE! 🚀',
    '¡MÁS ES MÁS!',
    '¡ESTAMOS FORRADOS! 💸',
    '¿QUÍMICA? ¡DE LA BUENA!',
    'MI YATE NO SE PAGA SOLO 🛥️',
    '¡VÉNDEME ESTE BOLÍGRAFO!',
    'EL MERCADO ME AMA',
    '¿ALGUIEN DIJO MARTINI? 🍸',
    'IMPRIMIENDO DINERO 🖨️',
    '¡ESTO ES MEJOR QUE EL SEXO... Y LAS DROGAS!',
    '¡SOY EL REY DE WALL STREET! 👑',
  ],
  loss: [
    'NO ES REAL HASTA QUE LO VENDES 😅',
    'ESTOY BIEN... ESTOY BIEN 😰',
    'NECESITO QUÍMICA, MUCHA QUÍMICA',
    'EL SHOW SIGUE... CREO',
    'NO MIRES EL GRÁFICO 🙈',
    '¿QUIÉN VENDE? NADIE VENDE',
    'ES UNA OPORTUNIDAD... DICEN',
    'AGUANTA, ES SOLO UN BACHE',
    'RESPIRA... RES... PIRA 😮‍💨',
    '¿ALGUIEN TIENE UN MARTINI? 🍸',
    'ESTO NO ESTÁ PASANDO 🤡',
  ],
  idle: [
    'VIGILANDO EL MERCADO 👀',
    'EL SHOW SIGUE',
    'ESPERANDO LA JUGADA',
    'AQUÍ NO PASA NADA... AÚN',
    'TÓMATE UN MARTINI 🍸',
    '¿COMPRAMOS O ESPERAMOS?',
    'EL S&P... DIGO, EL BTC, ESTÁ RARO',
    'MANTÉN LA CALMA Y COMPRA MÁS',
  ],
};

export function pickLine(mood: string): string {
  const arr = WOLF_LINES[mood] ?? WOLF_LINES.idle;
  return arr[Math.floor(Math.random() * arr.length)];
}
