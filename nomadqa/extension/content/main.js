// NomadQA: runs in the page's own world (not the extension's). Chrome does not follow a "javascript:" link clicked
// from an extension (Setup's older pages use them: the A B C … filter of a list, some buttons), so NomadQA asks this
// script to click such a link; it marks the link so NomadQA knows it was done. Plain script, nothing else.
(() => {
  if (window.__nomadqaMain) return;
  window.__nomadqaMain = true;
  addEventListener(
    'nomadqa:click',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      el.setAttribute('data-nomadqa-clicked', '1');
      el.click();
    },
    true
  );
})();
