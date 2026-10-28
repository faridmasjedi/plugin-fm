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
    // The newest published (not pre-release) version, in the hero and on the download cards
    const latest = releases.find((r) => !r.prerelease);
    if (latest) {
      const tag = document.getElementById('latest');
      if (tag) tag.textContent = `${latest.tag_name} · free · open source · no CLI needed`;
      const name = document.getElementById('latest-name');
      if (name) name.textContent = latest.name || latest.tag_name;
    }
    if (!releases.length) throw new Error('none');
    // A few words per version (whats-new.js); the newest release without its own entry shows "next"
    const notes = window.NOMADSF_WHATS_NEW || {};
    const newest = releases.find((r) => !r.prerelease);
    const changes = (r) => {
      const own = notes[r.tag_name.replace(/^v/, '')];
      return own || (r === newest && notes.next) || [];
    };
    const list = (items) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
    const box2 = document.getElementById('whats-new');
    if (box2 && newest && changes(newest).length) {
      box2.innerHTML = `<h3>What's new in ${esc(newest.name || newest.tag_name)}</h3>${list(changes(newest))}`;
      box2.hidden = false;
    }
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
        )}</b></a>${kind}</td><td>${date}</td><td class="changes">${list(changes(r)) || '—'}</td><td>${
          files || '—'
        }</td></tr>`;
      })
      .join('');
    box.innerHTML = `<table class="versions"><thead><tr><th>Version</th><th>Date</th><th>What's new</th><th>Downloads</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch {
    box.innerHTML = `<p class="note">The list of versions could not be loaded here. See <a href="https://github.com/${repo}/releases">all releases on GitHub</a>.</p>`;
  }
})();
