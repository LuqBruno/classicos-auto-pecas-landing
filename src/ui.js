// Interface: cabeçalho, menu móvel, capítulos ativos e mensagens de consulta para o WhatsApp.

export const WHATSAPP_PHONE = '554830532121';
const GREETING = 'Olá, Clássicos! Gostaria de consultar uma peça.';

export function whatsappURL(fields) {
  const lines = [GREETING];
  for (const [label, value] of fields) {
    const clean = String(value ?? '').trim();
    if (clean) lines.push(`${label}: ${clean}`);
  }
  const text = lines.join('\n');
  return { text, url: `https://api.whatsapp.com/send?phone=${WHATSAPP_PHONE}&text=${encodeURIComponent(text)}` };
}

// Sem 'noopener' nas features: com ele window.open devolve sempre null e não dá para saber se abriu.
function openWhatsApp(url) {
  const win = window.open(url, '_blank');
  if (!win) return false;
  try { win.opener = null; } catch { /* outra origem */ }
  return true;
}

export function initHeader() {
  const header = document.querySelector('[data-header]');
  const update = () => header.toggleAttribute('data-scrolled', scrollY > 8);
  update();
  addEventListener('scroll', update, { passive: true });
}

export function initMenu() {
  const toggle = document.querySelector('[data-menu-toggle]');
  const menu = document.querySelector('[data-menu]');
  const close = menu.querySelector('[data-menu-close]');
  let lastFocus = null;
  let hideTimer = 0;

  const focusables = () => [...menu.querySelectorAll('a[href], button')];

  function open() {
    clearTimeout(hideTimer);
    lastFocus = document.activeElement;
    menu.hidden = false;
    requestAnimationFrame(() => menu.setAttribute('data-open', ''));
    toggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    close.focus();
    document.addEventListener('keydown', onKey);
  }

  function shut({ restore = true } = {}) {
    menu.removeAttribute('data-open');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    hideTimer = setTimeout(() => { menu.hidden = true; }, 320);
    if (restore) (lastFocus || toggle).focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); shut(); return; }
    if (e.key !== 'Tab') return;
    const list = focusables();
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  toggle.addEventListener('click', open);
  close.addEventListener('click', () => shut());
  menu.addEventListener('click', (e) => {
    if (e.target === menu) shut();
    if (e.target.closest('nav a')) shut({ restore: false });
  });
}

// Capítulo ativo pela posição de rolagem: muda quando o topo do capítulo entra no último quinto da tela,
// antes de o texto aparecer, para o escurecimento do palco chegar junto com ele.
export function initChapters(chapters) {
  const links = [...document.querySelectorAll('[data-reel-link], .site-nav a')];
  let current = '';
  let pending = 0;
  function update() {
    pending = 0;
    const line = innerHeight * 0.8;
    let id = chapters[0].id;
    for (const c of chapters) if (c.getBoundingClientRect().top < line) id = c.id;
    if (id === current) return;
    current = id;
    document.documentElement.dataset.chapter = id;
    for (const link of links) {
      const match = link.dataset.reelLink === id || link.getAttribute('href') === `#${id}`;
      if (match) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  }
  const schedule = () => { if (!pending) pending = requestAnimationFrame(update); };
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  update();
}

export function initQuickForm() {
  const form = document.querySelector('[data-quick]');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { url } = whatsappURL([
      ['Veículo', form.veiculo.value],
      ['Peça ou referência', form.peca.value],
    ]);
    if (!openWhatsApp(url)) location.href = url;
  });
}

export function initConsultForm() {
  const form = document.querySelector('[data-consult]');
  const status = form.querySelector('[data-consult-status]');
  const preview = form.querySelector('[data-consult-preview]');
  const again = form.querySelector('[data-consult-link]');
  const required = [form.veiculo, form.peca];

  function validate(input) {
    const ok = input.value.trim().length > 0;
    input.setAttribute('aria-invalid', String(!ok));
    document.getElementById(`${input.id}-erro`).hidden = ok;
    return ok;
  }

  required.forEach((input) => input.addEventListener('blur', () => {
    if (input.getAttribute('aria-invalid') === 'true') validate(input);
  }));
  required.forEach((input) => input.addEventListener('input', () => {
    if (input.getAttribute('aria-invalid') === 'true') validate(input);
  }));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const invalid = required.filter((input) => !validate(input));
    if (invalid.length) { invalid[0].focus(); return; }
    const { url, text } = whatsappURL([
      ['Veículo', form.veiculo.value],
      ['Ano', form.ano.value],
      ['Motorização', form.motor.value],
      ['Peça ou referência', form.peca.value],
    ]);
    preview.textContent = text;
    again.href = url;
    status.hidden = false;
    if (!openWhatsApp(url)) {
      status.querySelector('p').textContent = 'Mensagem pronta. Toque no link abaixo para abrir o WhatsApp.';
      again.textContent = 'Abrir o WhatsApp';
    }
  });

  // Categorias levam à consulta com a peça já preenchida.
  document.querySelectorAll('[data-part]').forEach((link) => {
    link.addEventListener('click', () => {
      form.peca.value = link.dataset.part;
      if (form.peca.getAttribute('aria-invalid') === 'true') validate(form.peca);
      setTimeout(() => form.veiculo.focus({ preventScroll: true }), 650);
    });
  });
}
