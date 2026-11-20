// NomadQA: a small tab on Salesforce pages that opens NomadQA for this org (Alt+Shift+Q).
// It sits just under NomadSF's tab, so both show when both are installed. Plain script; it only sends a message.
(() => {
  if (window.top !== window || document.getElementById('nomadqa-button')) return;
  const button = document.createElement('button');
  button.id = 'nomadqa-button';
  button.title = 'NomadQA — test data and tests (Alt+Shift+Q) · Inspector: Alt+Shift+I';
  const logo = document.createElement('img');
  logo.src = chrome.runtime.getURL('icons/48.png');
  logo.alt = 'NomadQA';
  Object.assign(logo.style, { width: '22px', height: '22px', display: 'block', pointerEvents: 'none' });
  button.append(logo);
  Object.assign(button.style, {
    position: 'fixed',
    right: '0',
    // NomadSF's tab is at 42% and 40px tall: this one starts 8px below it
    top: 'calc(42% + 48px)',
    zIndex: '2147483646',
    width: '30px',
    height: '40px',
    padding: '0 0 0 4px',
    display: 'flex',
    alignItems: 'center',
    border: '1px solid #8f7bff',
    borderRight: '0',
    borderRadius: '10px 0 0 10px',
    background: '#4a2bc4',
    cursor: 'pointer',
    opacity: '0.8',
    boxShadow: '0 2px 6px rgba(0,0,0,.25)',
  });
  const open = () => chrome.runtime.sendMessage({ type: 'nomadqa:open' });
  button.addEventListener('mouseenter', () => (button.style.opacity = '1'));
  button.addEventListener('mouseleave', () => (button.style.opacity = '0.8'));
  button.addEventListener('click', open);
  document.addEventListener('keydown', (event) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyQ') open();
  });
  document.body.append(button);
})();
