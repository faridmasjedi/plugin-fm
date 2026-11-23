// NomadQA: typing in NomadQA's own boxes on a Salesforce page (the list of steps, "Find a record"). Salesforce's
// keyboard handling sees the focus on NomadQA's panel (not on a box) and swallows the keys. This runs before
// Salesforce's scripts, so its listener comes first and keeps those keys away from them. Plain script.
(() => {
  if (window.__nomadqaKeys) return;
  window.__nomadqaKeys = true;
  const ours = (e) => {
    const t = e.composedPath?.()[0];
    return Boolean(t?.matches?.('input, textarea, select') && t.getRootNode()?.host?.id === 'nomadqa-host');
  };
  // Enter and Escape still go on (NomadQA's own handlers save or close with them)
  for (const type of ['keydown', 'keypress', 'keyup'])
    window.addEventListener(
      type,
      (e) => {
        if (e.key !== 'Enter' && e.key !== 'Escape' && ours(e)) e.stopImmediatePropagation();
      },
      true
    );
})();
