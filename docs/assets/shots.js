// Every video on the page gets "⤢ Enlarge": the same video, nearly full screen, over the page (Esc or a click closes)
(() => {
  const dialog = document.createElement('dialog');
  dialog.className = 'shot-big';
  dialog.innerHTML =
    '<button type="button" class="shot-close" aria-label="Close">✕</button><video muted loop playsinline controls></video>';
  document.body.appendChild(dialog);
  const big = dialog.querySelector('video');
  const close = () => {
    big.pause();
    dialog.close();
  };
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.classList.contains('shot-close')) close();
  });
  dialog.addEventListener('close', () => big.pause());
  for (const shot of document.querySelectorAll('.shot')) {
    const video = shot.querySelector('video');
    if (!video) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shot-zoom';
    button.textContent = '⤢ Enlarge';
    button.addEventListener('click', () => {
      big.src = video.currentSrc || video.src;
      big.poster = video.poster;
      dialog.showModal();
      big.currentTime = 0;
      void big.play().catch(() => {});
    });
    shot.appendChild(button);
  }
})();
