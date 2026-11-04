// Filme ligado à rolagem: um palco fixo, quadros WebP desenhados num canvas.
// Tempos e quadros vêm do manifesto (public/v2/film/manifest.json); nada é fixado aqui.

const BASE = 'public/v3/film/';
const INTRO_SCROLL_EXIT = 40; // px de rolagem que interrompem a abertura
const INTRO_TIMEOUT = 2600; // ms sem reprodução → acende direto
const SMOOTHING_MS = 55; // constante de tempo do acompanhamento do quadro
const JUMP_FRAMES = 36; // saltos maiores (âncoras) não percorrem quadro a quadro
const SPARSE_STEP = 4; // primeira passada do carregamento: quadros múltiplos de 4 (os primeiros aquecidos)
const WARM_LEVELS = [8, 4, 2, 1]; // ordem do aquecimento: do esboço ao filme completo


const tuning = {
  d: { cache: 28, ahead: 18, behind: 5, concurrency: 6, warm: 6, maxDpr: 1.5 },
  m: { cache: 22, ahead: 10, behind: 4, concurrency: 3, warm: 4, maxDpr: 2 },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = (n) => String(n).padStart(3, '0');

export function createFilm({ stage, chapters, onFail }) {
  const canvas = stage.querySelector('.stage__canvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  const video = stage.querySelector('.stage__intro');
  // Quadro escuro da abertura: criado só quando o filme roda (sem <img> vazio no HTML).
  const dark = Object.assign(document.createElement('img'), { className: 'stage__dark', alt: '', decoding: 'async' });
  video.before(dark);
  const labelLayer = stage.querySelector('.stage__labels');
  const poster = stage.querySelector('.stage__poster img');

  let manifest = null;
  let key = null; // 'd' | 'm'
  let frames = []; // [{ shot, index, url }]
  let shotRanges = []; // [{ id, start, count, labels }]
  let segments = []; // [{ y0, y1, f0, f1 }]
  let cache = new Map(); // globalFrame -> { img, ready, failed, used }
  let queue = [];
  let inflight = 0;
  let target = 0;
  let shown = 0;
  let drawn = -1;
  let lastTime = 0;
  let raf = 0;
  let direction = 1;
  let introState = 'idle';
  let introEnd = '';
  let failures = 0;
  let destroyed = false;
  let tags = [];
  let warmed = new Set(); // quadros já baixados para o cache HTTP
  let warming = 0;

  const pickVariant = () => (innerWidth / innerHeight < 0.8 ? 'm' : 'd');

  async function start() {
    const res = await fetch(BASE + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('manifesto indisponível');
    manifest = await res.json();
    setVariant(pickVariant());
    sizeCanvas();
    measure();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    target = shown = frameForScroll(scrollY);
    request(Math.round(target));
    schedule();
    intro();
  }

  function setVariant(next) {
    key = next;
    const v = manifest.variants[key];
    stage.style.setProperty('--focus-x', `${v.focusX * 100}%`);
    frames = [];
    shotRanges = [];
    for (const shot of manifest.shots) {
      const count = shot.frames[key] ?? 0;
      shotRanges.push({ id: shot.id, start: frames.length, count, labels: shot.labels ?? [] });
      for (let i = 1; i <= count; i++) frames.push({ url: `${BASE}${key}/${shot.id}/${pad(i)}.webp` });
    }
    for (const entry of cache.values()) release(entry);
    cache = new Map();
    queue = [];
    warmed = new Set();
    drawn = -1;
    buildLabels();
  }

  // Cada capítulo cobre os planos listados em data-shots; entre capítulos o quadro final fica parado.
  function measure() {
    const vh = innerHeight;
    segments = [];
    const used = new Set();
    for (const el of chapters) {
      const all = (el.dataset.shots || '').split(/\s+/).filter(Boolean);
      const ids = all.filter((id) => !used.has(id));
      const top = el.getBoundingClientRect().top + scrollY;
      // Capítulo que repete o último plano estende esse plano até o seu fim (consulta + contato).
      if (!ids.length) {
        const last = segments[segments.length - 1];
        const range = shotRanges.find((r) => r.id === all[all.length - 1]);
        if (last && range && last.f1 === range.start + range.count - 1) {
          last.y1 = Math.max(last.y1, top + el.offsetHeight - vh);
        }
        continue;
      }
      const y0 = segments.length ? top - vh * 0.5 : 0;
      const y1 = Math.max(y0 + 1, top + el.offsetHeight - vh);
      const span = (y1 - y0) / ids.length;
      ids.forEach((id, n) => {
        used.add(id);
        const range = shotRanges.find((r) => r.id === id);
        if (!range || !range.count) return;
        segments.push({ y0: y0 + span * n, y1: y0 + span * (n + 1), f0: range.start, f1: range.start + range.count - 1 });
      });
    }
  }

  function frameForScroll(y) {
    if (!segments.length) return 0;
    let f = segments[0].f0;
    for (const s of segments) {
      if (y < s.y0) break;
      const p = clamp((y - s.y0) / (s.y1 - s.y0), 0, 1);
      f = s.f0 + (s.f1 - s.f0) * p;
    }
    return f;
  }

  // ---------- carregamento ----------

  function request(center) {
    const t = tuning[key];
    const ahead = direction > 0 ? t.ahead : t.behind;
    const behind = direction > 0 ? t.behind : t.ahead;
    // Downloads que ficaram para trás da janela são cancelados: liberam vaga para o que vem pela frente.
    for (const [i, e] of cache) {
      if (!e.ready && (i < center - behind - 2 || i > center + ahead + 2)) { release(e); cache.delete(i); }
    }
    // Primeiro quadros espaçados (sempre há um pronto perto do alvo em rolagem rápida), depois o preenchimento.
    const wanted = [center];
    const span = Math.max(ahead, behind);
    for (const pass of [true, false]) {
      for (let d = 1; d <= span; d++) {
        if (d <= ahead && ((center + d) % SPARSE_STEP === 0) === pass) wanted.push(center + d);
        if (d <= behind && ((center - d) % SPARSE_STEP === 0) === pass) wanted.push(center - d);
      }
    }
    queue = wanted.filter((i) => i >= 0 && i < frames.length && !cache.has(i));
    pump();
    evict(center);
    warm();
  }

  function pump() {
    if (destroyed || document.hidden) return;
    const t = tuning[key];
    while (inflight < t.concurrency && queue.length) load(queue.shift());
  }

  // O quadro só entra no cache já decodificado (ImageBitmap, decodificado fora da thread principal).
  // Antes, o <img> era marcado pronto no onload e a decodificação do WebP acontecia dentro do
  // drawImage, durante a rolagem: era isso que travava o filme.
  async function decodeFrame(url, signal) {
    if (window.createImageBitmap) {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return createImageBitmap(await res.blob());
    }
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }

  function load(i) {
    if (cache.has(i)) return;
    const ctrl = new AbortController();
    const entry = { img: null, ready: false, ctrl, used: performance.now() };
    cache.set(i, entry);
    inflight++;
    const settle = () => {
      if (entry.done) return;
      entry.done = true;
      inflight--;
      if (!destroyed) pump();
    };
    decodeFrame(frames[i].url, ctrl.signal).then((img) => {
      if (entry.released) { img.close?.(); return; }
      entry.img = img;
      entry.ready = true;
      failures = 0;
      if (Math.abs(i - Math.round(shown)) < 3) schedule();
      settle();
    }, () => {
      if (entry.released) return;
      cache.delete(i);
      failures++;
      if (failures > 8 && drawn < 0) fail();
      settle();
    });
  }

  // Descarta um quadro: cancela o download pendente e libera a memória decodificada.
  function release(entry) {
    entry.released = true;
    if (!entry.done) { entry.done = true; inflight--; }
    entry.ctrl?.abort();
    entry.img?.close?.();
    entry.img = null;
  }

  function evict(center) {
    const limit = tuning[key].cache;
    if (cache.size <= limit) return;
    const far = [...cache.keys()].sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
    for (const i of far.slice(0, cache.size - limit)) {
      release(cache.get(i));
      cache.delete(i);
    }
  }

  // Aquecimento: baixa (sem decodificar) os arquivos para o cache HTTP, do grosso ao fino: primeiro
  // 1 quadro a cada 8 do filme inteiro, depois a cada 4, 2 e 1, sempre a partir de onde a pessoa está e no
  // sentido da rolagem. Em rede real, quem rola rápido logo tem um esboço completo do filme (nunca congela
  // esperando download); quem rola devagar recebe os quadros intermediários a tempo.
  function nextToWarm(c) {
    const n = frames.length;
    for (const step of WARM_LEVELS) {
      for (let d = 0; d < n; d++) {
        const i = direction > 0 ? (c + d) % n : (c - d + n) % n;
        if (i % step === 0 && !warmed.has(i) && !cache.has(i)) return i;
      }
    }
    return -1;
  }

  function warm() {
    if (destroyed || document.hidden) return;
    const c = clamp(Math.round(target), 0, frames.length - 1);
    const t = tuning[key];
    while (warming < t.warm) {
      const next = nextToWarm(c);
      if (next < 0) return;
      warmed.add(next);
      warming++;
      const url = frames[next].url;
      fetch(url, { priority: 'low' })
        .then((r) => r.arrayBuffer())
        .catch(() => warmed.delete(next))
        .finally(() => { warming--; if (url === frames[next]?.url) warm(); });
    }
  }

  // Mantém o aquecimento andando quando a página está parada.
  let idleHandle = 0;
  function prefetchIdle() {
    clearTimeout(idleHandle);
    if (destroyed || document.hidden) return;
    warm();
    idleHandle = setTimeout(prefetchIdle, 400);
  }

  // ---------- desenho ----------

  function nearestReady(i) {
    for (let d = 0; d < 40; d++) {
      const a = cache.get(i - d);
      if (a?.ready) return i - d;
      const b = cache.get(i + d);
      if (b?.ready) return i + d;
    }
    return -1;
  }

  function sizeCanvas() {
    const dpr = Math.min(devicePixelRatio || 1, tuning[key].maxDpr);
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      drawn = -1;
    }
    layoutMedia();
  }

  // Abertura, quadro escuro e pôster usam exatamente o enquadramento do canvas: sem salto na troca.
  function layoutMedia() {
    if (!manifest) return;
    const b = coverBox();
    const dpr = canvas.width / innerWidth;
    // Só transform: não altera a caixa de layout (sem deslocamento cumulativo).
    const sx = b.w / canvas.width;
    const sy = b.h / canvas.height;
    for (const el of [video, dark, poster]) {
      if (!el) continue;
      Object.assign(el.style, {
        objectFit: 'fill',
        transformOrigin: '0 0',
        transform: `translate(${b.x / dpr}px, ${b.y / dpr}px) scale(${sx}, ${sy})`,
      });
    }
  }

  // Encaixe "cover" com ponto focal do manifesto; também usado para posicionar os rótulos.
  // A variante vertical aceita uma faixa escura mínima (minCover) para não cortar o carro nas laterais.
  function coverBox() {
    const v = manifest.variants[key];
    const fitH = (canvas.height / v.height) * (v.minCover ?? 1);
    const scale = Math.max(canvas.width / v.width, fitH);
    const w = v.width * scale;
    const h = v.height * scale;
    const x = (canvas.width - w) * v.focusX;
    const y = (canvas.height - h) * (v.focusY ?? 0.5);
    return { x, y, w, h };
  }

  function draw(i) {
    const ready = nearestReady(i);
    if (ready < 0 || ready === drawn) return;
    const entry = cache.get(ready);
    entry.used = performance.now();
    const b = coverBox();
    ctx.drawImage(entry.img, b.x, b.y, b.w, b.h);
    // Faixas fora do quadro (variante vertical): estende a primeira e a última linha do próprio quadro
    // (parede e piso do estúdio), sem caixa preta. As sombras do palco escurecem as bordas.
    if (b.y > 0.5) {
      const iw = entry.img.naturalWidth || entry.img.width;
      const ih = entry.img.naturalHeight || entry.img.height;
      const edge = Math.max(2, Math.round(ih * 0.02));
      ctx.drawImage(entry.img, 0, 0, iw, edge, b.x, 0, b.w, Math.ceil(b.y));
      const bottom = b.y + b.h;
      ctx.drawImage(entry.img, 0, ih - edge, iw, edge, b.x, Math.floor(bottom), b.w, canvas.height - Math.floor(bottom));
    }
    drawn = ready;
  }

  function tick(now) {
    raf = 0;
    const dt = lastTime ? Math.min(64, now - lastTime) : 16;
    lastTime = now;
    if (Math.abs(target - shown) > JUMP_FRAMES) shown = target;
    else shown += (target - shown) * (1 - Math.exp(-dt / SMOOTHING_MS));
    if (Math.abs(target - shown) < 0.02) shown = target;
    const i = Math.round(shown);
    draw(i);
    updateLabels(shown);
    if (shown !== target) schedule();
    else lastTime = 0;
  }

  function schedule() {
    if (!raf && !destroyed && !document.hidden) raf = requestAnimationFrame(tick);
  }

  // ---------- rótulos ----------

  function buildLabels() {
    labelLayer.replaceChildren();
    tags = [];
    for (const range of shotRanges) {
      for (const label of range.labels) {
        if (!label.pos[key]) continue;
        const el = document.createElement('div');
        el.className = label.pos[key][0] > 0.55 ? 'tag tag--left' : 'tag';
        const span = document.createElement('span');
        span.textContent = label.text;
        el.append(span);
        labelLayer.append(el);
        tags.push({ el, range, label });
      }
    }
  }

  function updateLabels(f) {
    if (!tags.length) return;
    const dpr = canvas.width / innerWidth;
    const b = coverBox();
    for (const t of tags) {
      const local = (f - t.range.start) / Math.max(1, t.range.count - 1);
      const visible = local >= t.label.from && local <= t.label.to + 0.001 && Math.abs(target - shown) < 1.5;
      t.el.classList.toggle('is-visible', visible);
      if (visible) {
        const [nx, ny] = t.label.pos[key];
        t.el.style.setProperty('--x', `${(b.x + nx * b.w) / dpr}px`);
        t.el.style.setProperty('--y', `${(b.y + ny * b.h) / dpr}px`);
      }
    }
  }

  // ---------- abertura ----------

  function intro() {
    if (scrollY > INTRO_SCROLL_EXIT || !manifest.intro?.[key]) return;
    introState = 'dark';
    dark.src = BASE + manifest.intro.dark[key];
    stage.dataset.intro = 'dark';
    video.src = BASE + manifest.intro[key];
    const timer = setTimeout(() => endIntro('timeout'), INTRO_TIMEOUT);
    video.addEventListener('playing', () => {
      clearTimeout(timer);
      if (introState !== 'dark') return;
      introState = 'playing';
      stage.dataset.intro = 'playing';
    }, { once: true });
    video.addEventListener('ended', () => endIntro('ended'), { once: true });
    video.addEventListener('error', () => endIntro('error'), { once: true });
    video.play().catch(() => endIntro('blocked'));
  }

  function endIntro(reason = 'scroll') {
    if (introState === 'done' || introState === 'idle') return;
    introState = 'done';
    introEnd = reason;
    delete stage.dataset.intro;
    setTimeout(() => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }, 600);
  }

  // ---------- eventos ----------

  function onScroll() {
    if (introState === 'dark' || introState === 'playing') {
      if (scrollY > INTRO_SCROLL_EXIT) endIntro();
    }
    const next = frameForScroll(scrollY);
    if (next !== target) {
      direction = next > target ? 1 : -1;
      target = next;
      request(Math.round(target));
      schedule();
    }
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const next = pickVariant();
      if (next !== key) setVariant(next);
      sizeCanvas();
      measure();
      target = shown = frameForScroll(scrollY);
      drawn = -1;
      request(Math.round(target));
      schedule();
    }, 150);
  }

  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      lastTime = 0;
      clearTimeout(idleHandle);
      endIntro('hidden');
    } else {
      pump();
      prefetchIdle();
      schedule();
    }
  }

  function fail() {
    destroy();
    onFail?.();
  }

  function destroy() {
    destroyed = true;
    cancelAnimationFrame(raf);
    clearTimeout(idleHandle);
    clearTimeout(resizeTimer);
    removeEventListener('load', onScroll);
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const entry of cache.values()) release(entry);
    cache.clear();
    endIntro();
    labelLayer.replaceChildren();
    for (const el of [video, poster]) el?.removeAttribute('style');
    dark.remove();
  }

  return {
    async init() {
      await start();
      prefetchIdle();
      // Remede quando fontes e conteúdo assentarem (alturas dos capítulos mudam).
      document.fonts?.ready.then(() => { measure(); onScroll(); });
      addEventListener('load', onScroll, { once: true });
    },
    destroy,
    remeasure() { measure(); onScroll(); },
    get state() { return { key, target, shown, drawn, cached: cache.size, frames: frames.length, intro: introState, introEnd }; },
  };
}
