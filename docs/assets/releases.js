// Lists every GitHub release with its downloads (the public API; 60 requests an hour per visitor).
(async () => {
  const box = document.getElementById('versions');
  if (!box) return;
  const repo = 'faridmasjedi/plugin-fm';
  const label = (name) =>
    /extension.*\.zip$/.test(name)
      ? 'Browser extension'
      : /\.vsix$/.test(name)
      ? 'VS Code'
      : /\.tgz$/.test(name)
      ? 'CLI plugin'
      : name;
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const releases = (await res.json()).filter((r) => !r.draft);
    if (!releases.length) throw new Error('none');
    const rows = releases
      .map((r) => {
        const date = new Date(r.published_at).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
        const files = r.assets
          .map((a) => `<a href="${esc(a.browser_download_url)}">${esc(label(a.name))}</a>`)
          .join('');
        const kind = r.prerelease ? ' <span class="badge">pre-release</span>' : '';
        return `<tr><td><a href="${esc(r.html_url)}"><b>${esc(
          r.name || r.tag_name
        )}</b></a>${kind}</td><td>${date}</td><td>${files || '—'}</td></tr>`;
      })
      .join('');
    box.innerHTML = `<table class="versions"><thead><tr><th>Version</th><th>Date</th><th>Downloads</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch {
    box.innerHTML = `<p class="note">The list of versions could not be loaded here. See <a href="https://github.com/${repo}/releases">all releases on GitHub</a>.</p>`;
  }
})();
