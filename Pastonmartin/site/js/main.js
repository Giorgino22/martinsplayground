// Startpunkt der Seite: Daten laden und die vier Ansichten verbinden.
import { loadJson, formatStamp } from './util.js';
import { initTips } from './tips.js';
import { initBacktest } from './backtest.js';
import { initJournal } from './journal.js';

// Tabs umschalten
const tabs = document.querySelectorAll('nav [data-view]');
function show(name) {
  tabs.forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.view === name)));
  document.querySelectorAll('section[id^="view-"]').forEach(section =>
    section.classList.toggle('hidden', section.id !== `view-${name}`));
  history.replaceState(null, '', `#${name}`);
}
tabs.forEach(tab => tab.addEventListener('click', () => show(tab.dataset.view)));
const views = [...tabs].map(tab => tab.dataset.view);
show(views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'tips');

// Alle drei Dateien gleichzeitig laden
const [tips, backtest, results] = await Promise.all([
  loadJson('data/tips.json'), loadJson('data/backtest.json'), loadJson('data/results.json'),
]);

if (tips) {
  document.getElementById('stand').textContent =
    `Stand ${formatStamp(tips.generated)}${tips.odds_api ? ' · Pinnacle live' : ''}`;
}
initTips(tips);
initBacktest(backtest);
await initJournal(results);
