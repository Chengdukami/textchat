const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appApi', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  openDebug: () => ipcRenderer.invoke('debug:open'),
  clearDebug: () => ipcRenderer.send('debug:clear'),
  onAnswerUpdate: (callback) => ipcRenderer.on('answer:update', (_event, value) => callback(value)),
  onDebugUpdate: (callback) => ipcRenderer.on('debug:update', (_event, value) => callback(value))
});
