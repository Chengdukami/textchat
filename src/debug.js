const log = document.getElementById('log');

window.appApi.onDebugUpdate((value) => {
  log.textContent = value || '等待请求…';
  log.scrollTop = log.scrollHeight;
});

document.getElementById('clear').addEventListener('click', () => {
  window.appApi.clearDebug();
});
