// NomadSF: a small button on Salesforce pages that opens the Studio for this org.
// Plain script (content scripts cannot be ES modules); it only sends a message.
(() => {
  if (window.top !== window || document.getElementById('nomadsf-button')) return;
  const button = document.createElement('button');
  button.id = 'nomadsf-button';
  button.title = 'NomadSF Studio (Alt+Shift+N)';
  // NomadSF logo (listed in web_accessible_resources so Salesforce pages may show it)
  const logo = document.createElement('img');
  logo.src = chrome.runtime.getURL('icons/48.png');
  logo.alt = 'NomadSF';
  Object.assign(logo.style, { width: '22px', height: '22px', display: 'block', pointerEvents: 'none' });
  button.append(logo);
  Object.assign(button.style, {
    position: 'fixed',
    right: '0',
    top: '42%',
    zIndex: '2147483646',
    width: '30px',
    height: '40px',
    padding: '0 0 0 4px',
    display: 'flex',
    alignItems: 'center',
    border: '1px solid #464854',
    borderRight: '0',
    borderRadius: '10px 0 0 10px',
    background: '#101116',
    cursor: 'pointer',
    opacity: '0.75',
    boxShadow: '0 2px 6px rgba(0,0,0,.25)',
  });
  const open = () => chrome.runtime.sendMessage({ type: 'nomadsf:open-studio' });
  button.addEventListener('mouseenter', () => (button.style.opacity = '1'));
  button.addEventListener('mouseleave', () => (button.style.opacity = '0.75'));
  button.addEventListener('click', open);
  document.addEventListener('keydown', (event) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyN') open();
  });
  document.body.append(button);
})();
