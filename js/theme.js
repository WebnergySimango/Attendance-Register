// theme.js — dark/light mode. Applied as early as possible (called inline in
// <head>, before the page renders) so there's no flash of the wrong theme.
(function () {
  const saved = localStorage.getItem('theme');
  const theme = saved || 'light';
  document.documentElement.setAttribute('data-theme', theme);
})();

function initThemeToggle(buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  const current = () => document.documentElement.getAttribute('data-theme') || 'light';
  const render = () => { btn.textContent = current() === 'dark' ? 'Light mode' : 'Dark mode'; };
  render();
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    render();
  });
}
