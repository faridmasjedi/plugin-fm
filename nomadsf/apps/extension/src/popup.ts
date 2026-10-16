import { apiHostFor } from '@nomadsf/core';

const main = document.getElementById('main')!;

function studioUrl(apiHost: string, page?: string): string {
  return chrome.runtime.getURL(`app/index.html?host=${encodeURIComponent(apiHost)}${page ? `#${page}` : ''}`);
}

async function render(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageHost = tab?.url ? new URL(tab.url).host : '';
  const apiHost = apiHostFor(pageHost);

  if (!apiHost) {
    main.innerHTML =
      '<p class="muted">Open a Salesforce page (Lightning, Setup or Classic) and click NomadSF again.</p>';
    return;
  }

  const sid = await chrome.cookies.get({ url: `https://${apiHost}`, name: 'sid' });
  main.innerHTML = '';
  const org = document.createElement('div');
  org.className = 'org';
  org.textContent = apiHost;
  main.append(org);

  if (!sid?.value) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'Not logged in to this org in this browser. Log in, then try again.';
    main.append(note);
    return;
  }

  const open = (label: string, page: string | undefined, primary = false): void => {
    const button = document.createElement('button');
    button.textContent = label;
    if (primary) button.className = 'primary';
    button.onclick = () => {
      void chrome.tabs.create({ url: studioUrl(apiHost, page), index: (tab?.index ?? 0) + 1 });
      window.close();
    };
    main.append(button);
  };
  open('Open NomadSF Studio', undefined, true);
  open('▶  Execute Apex', 'apex');
  open('☰  Debug logs', 'logs');
  open('⌕  Query', 'query');
}

render().catch((error: Error) => {
  main.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = error.message;
  main.append(p);
});
