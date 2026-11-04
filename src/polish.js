// image-zoom--sereno remains in the film; short line-mask--preciso support for copy.
// WAAPI adds movement only to already visible content. No opacity gate or scroll interception.
export function initPolish() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const active = new Set();
  const seen = new WeakSet();
  let raf = 0;
  const header = document.querySelector('[data-header]');
  const observer = new IntersectionObserver(entries => {
    for (const {target, isIntersecting} of entries) {
      if (!isIntersecting || seen.has(target)) continue;
      seen.add(target);
      if (reduced.matches) continue;
      const animation = target.animate([
        { transform: 'translateY(18px)', opacity: .75 },
        { transform: 'translateY(0)', opacity: 1 },
      ], { duration: 620, easing: 'cubic-bezier(.23,1,.32,1)' });
      active.add(animation);
      animation.finished.catch(() => {}).finally(() => active.delete(animation));
    }
  }, { threshold: .2 });
  document.querySelectorAll('.display, .copy > .lede, .steps, .contact-grid').forEach(el => observer.observe(el));
  function progress() {
    raf = 0;
    const distance = document.documentElement.scrollHeight - innerHeight;
    header.style.setProperty('--page-progress', String(Math.min(1, Math.max(0, scrollY / Math.max(1, distance)))));
  }
  function schedule() { if (!raf && !document.hidden) raf = requestAnimationFrame(progress); }
  function cancelMotion() { if (reduced.matches) for (const animation of active) animation.cancel(); }
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  reduced.addEventListener('change', cancelMotion);
  progress();
  return () => {
    observer.disconnect(); cancelAnimationFrame(raf);
    for (const animation of active) animation.cancel();
    removeEventListener('scroll', schedule); removeEventListener('resize', schedule);
    reduced.removeEventListener('change', cancelMotion);
  };
}
