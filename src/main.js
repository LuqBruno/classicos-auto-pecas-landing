import { createFilm } from './film.js?v=23';
import { initHeader, initMenu, initChapters, initQuickForm, initConsultForm } from './ui.js?v=23';

const root = document.documentElement;
const stage = document.querySelector('.stage');
const chapters = [...document.querySelectorAll('[data-chapter]')];

initHeader();
initMenu();
initChapters(chapters);
initQuickForm();
initConsultForm();

// O filme é uma melhoria: sem ele (movimento reduzido, economia de dados, falha), a página
// mostra quadros estáticos em fluxo normal.
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const connection = navigator.connection;
const saveData = () => Boolean(connection?.saveData) || /(^|-)2g$/.test(connection?.effectiveType ?? '');

let film = null;

async function enableFilm() {
  if (film || reduced.matches || saveData()) return disableFilm();
  root.classList.remove('film-off');
  root.classList.add('film-on');
  film = createFilm({ stage, chapters, onFail: disableFilm });
  try {
    await film.init();
    window.__film = film; // inspeção em QA
  } catch {
    disableFilm();
  }
}

function disableFilm() {
  film?.destroy();
  film = null;
  root.classList.remove('film-on');
  root.classList.add('film-off');
}

reduced.addEventListener('change', () => (reduced.matches ? disableFilm() : enableFilm()));
enableFilm();
