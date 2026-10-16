const baseUrl = document.getElementById('baseUrl');
const model = document.getElementById('model');
const apiKey = document.getElementById('apiKey');
const status = document.getElementById('status');

async function load() {
  const settings = await window.appApi.loadSettings();
  baseUrl.value = settings.baseUrl || '';
  model.value = settings.model || '';
  apiKey.value = settings.apiKey || '';
}

document.getElementById('save').addEventListener('click', async () => {
  await window.appApi.saveSettings({
    baseUrl: baseUrl.value.trim(),
    model: model.value.trim(),
    apiKey: apiKey.value.trim()
  });
  status.textContent = '已保存';
  setTimeout(() => { status.textContent = ''; }, 1800);
});

document.getElementById('debug').addEventListener('click', () => {
  window.appApi.openDebug();
});

load();
