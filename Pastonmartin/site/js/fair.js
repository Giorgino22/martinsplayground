// Faire Quoten berechnen: dieselbe Mathematik wie engine/odds.py, markets.py und combine.py.
// Die Website braucht das, wenn sie frische Marktquoten holt und alles neu rechnen muss.
// Ein Test (engine/test_engine.py) prüft, dass Python und JavaScript gleich rechnen.

const MAX_GOALS = 10;
const GOALS = Array.from({ length: MAX_GOALS + 1 }, (_, k) => k);
const LOG_FACTORIAL = GOALS.map(k => GOALS.slice(1, k + 1).reduce((sum, i) => sum + Math.log(i), 0));
const sum = list => list.reduce((a, b) => a + b, 0);
const normalize = list => { const total = sum(list); return list.map(x => x / total); };

// Quoten -> faire Wahrscheinlichkeiten (siehe odds.devig in Python für die Erklärung)
export function devig(odds, method) {
  if (!odds || !odds.every(o => o > 1)) return null;
  const implied = odds.map(o => 1 / o);
  const total = sum(implied);
  const proportional = implied.map(p => p / total);
  if (method === 'power') {
    let low = 0.2, high = 5;
    for (let i = 0; i < 60; i++) {
      const k = (low + high) / 2;
      if (sum(implied.map(p => p ** k)) > 1) low = k; else high = k;
    }
    return normalize(implied.map(p => p ** ((low + high) / 2)));
  }
  if (method === 'shin') {
    if (total <= 1) return proportional;
    const shin = z => implied.map(p => (Math.sqrt(z * z + 4 * (1 - z) * p * p / total) - z) / (2 * (1 - z)));
    let low = 0, high = 0.5;
    for (let i = 0; i < 60; i++) {
      const z = (low + high) / 2;
      if (sum(shin(z)) > 1) low = z; else high = z;
    }
    return normalize(shin((low + high) / 2));
  }
  return proportional;
}

// Markt und Modell kombinieren (siehe combine.py)
export function combine(kind, params, pMarket, pModel) {
  if (!pMarket) return null;
  if (kind === 'linear') {
    return pModel ? pModel.map((m, i) => params.w * m + (1 - params.w) * pMarket[i]) : pMarket;
  }
  const useModel = pModel && params.full;
  const p = useModel ? params.full : params.ref_only;
  const clip = x => Math.min(Math.max(x, 1e-9), 1);
  const points = pMarket.map((q, i) =>
    p.bias[i] + p.w_market * Math.log(clip(q)) + (useModel && p.w_model ? p.w_model * Math.log(clip(pModel[i])) : 0));
  const top = Math.max(...points);
  return normalize(points.map(x => Math.exp(x - top)));
}

// Erwartete Tore -> Wahrscheinlichkeit jedes Resultats (mit Dixon-Coles-Korrektur rho)
export function scoreGrid(goalsHome, goalsAway, rho = 0) {
  const pmf = rate => GOALS.map(k => Math.exp(-rate + k * Math.log(rate) - LOG_FACTORIAL[k]));
  const home = pmf(goalsHome), away = pmf(goalsAway);
  const grid = home.map(h => away.map(a => h * a));
  if (rho) {
    grid[0][0] *= 1 - goalsHome * goalsAway * rho;
    grid[0][1] *= 1 + goalsHome * rho;
    grid[1][0] *= 1 + goalsAway * rho;
    grid[1][1] *= 1 - rho;
    for (const row of grid) row.forEach((v, j) => { row[j] = Math.max(v, 0); });
  }
  const total = sum(grid.map(sum));
  return grid.map(row => row.map(v => v / total));
}

// Resultat-Tabelle -> Wahrscheinlichkeit jeder Wette
export function fromGoals(goalsHome, goalsAway, rho = 0) {
  const grid = scoreGrid(goalsHome, goalsAway, rho);
  let H = 0, D = 0, A = 0, O15 = 0, O = 0, O35 = 0, BY = 0;
  grid.forEach((row, i) => row.forEach((p, j) => {
    if (i > j) H += p; else if (i === j) D += p; else A += p;
    if (i + j >= 2) O15 += p;
    if (i + j >= 3) O += p;
    if (i + j >= 4) O35 += p;
    if (i > 0 && j > 0) BY += p;
  }));
  return { H, D, A, '1X': H + D, '12': H + A, X2: D + A, O15, U15: 1 - O15, O, U: 1 - O,
    O35, U35: 1 - O35, BY, BN: 1 - BY };
}

// Welche erwarteten Tore passen zu 1X2 (und Über 2.5)? Gauss-Newton wie in markets.py
export function impliedGoals(pHome, pDraw, pAway, pOver, rho = 0) {
  const keys = pOver == null ? ['H', 'D', 'A'] : ['H', 'D', 'A', 'O'];
  const target = pOver == null ? [pHome, pDraw, pAway] : [pHome, pDraw, pAway, pOver];
  const model = x => { const p = fromGoals(Math.exp(x[0]), Math.exp(x[1]), rho); return keys.map(k => p[k]); };
  let x = [Math.log(1.45), Math.log(1.15)];
  const h = 1e-4, low = Math.log(0.05), high = Math.log(6);
  for (let iteration = 0; iteration < 40; iteration++) {
    const current = model(x);
    const error = current.map((v, i) => v - target[i]);
    const columns = [0, 1].map(j => {
      const shifted = [...x]; shifted[j] += h;
      return model(shifted).map((v, i) => (v - current[i]) / h);
    });
    // 2x2-Normalgleichungen: (JᵀJ) · Schritt = -Jᵀ · Fehler
    const a = sum(columns[0].map(v => v * v)) + 1e-6, b = sum(columns[0].map((v, i) => v * columns[1][i]));
    const d = sum(columns[1].map(v => v * v)) + 1e-6;
    const e0 = sum(columns[0].map((v, i) => v * error[i])), e1 = sum(columns[1].map((v, i) => v * error[i]));
    const det = a * d - b * b;
    const step = [-(d * e0 - b * e1) / det, -(a * e1 - b * e0) / det];
    x = x.map((v, j) => Math.min(Math.max(v + Math.min(Math.max(step[j], -0.5), 0.5), low), high));
  }
  return [Math.exp(x[0]), Math.exp(x[1])];
}

// Alles für ein Spiel: Marktquoten (+ Modellchancen) -> faire Chance jeder Wette.
// refOdds = { '1X2': [h, d, a], OU: [über, unter] }, model = { '1X2': [...], OU: [...] } oder null
export function matchProbabilities(params, refOdds, model) {
  const market = {}, final = {};
  for (const m of ['1X2', 'OU']) {
    market[m] = devig(refOdds[m], params.devig);
    final[m] = combine(params.combine.kind, params.combine[m], market[m], model ? model[m] : null);
  }
  const expand = (p1, pou) => {
    const result = {};
    if (p1) Object.assign(result, { H: p1[0], D: p1[1], A: p1[2], '1X': p1[0] + p1[1], '12': p1[0] + p1[2], X2: p1[1] + p1[2] });
    if (pou) Object.assign(result, { O: pou[0], U: pou[1] });
    if (p1 && pou) {
      const rho = params.derived_rho || 0;
      const implied = fromGoals(...impliedGoals(p1[0], p1[1], p1[2], pou[0], rho), rho);
      for (const k of ['O15', 'U15', 'O35', 'U35', 'BY', 'BN']) result[k] = implied[k];
    }
    return result;
  };
  return { final: expand(final['1X2'], final.OU), market: expand(market['1X2'], market.OU) };
}
