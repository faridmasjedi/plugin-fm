// NomadSF: a small button on Salesforce pages that opens the Studio for this org.
// Plain script (content scripts cannot be ES modules); it only sends a message.
(() => {
  if (window.top !== window || document.getElementById('nomadsf-button')) return;
  const button = document.createElement('button');
  button.id = 'nomadsf-button';
  button.title = 'NomadSF Studio (Alt+Shift+N)';
  button.textContent = 'N';
  Object.assign(button.style, {
    position: 'fixed',
    right: '0',
    top: '42%',
    zIndex: '2147483646',
    width: '22px',
    height: '44px',
    border: '0',
    borderRadius: '8px 0 0 8px',
    background: 'linear-gradient(135deg, #0b5cff, #8b5cf6)',
    color: '#fff',
    font: '600 13px system-ui, sans-serif',
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
