'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('hub', {
  state: call('hub:state'),
  create: call('hub:create'),
  update: call('hub:update'),
  remove: call('hub:delete'),
  locate: call('hub:locate'),
  addFiles: call('hub:add-files'),
  setHotkey: call('hub:hotkey'),
  pauseHotkey: call('hub:hotkey-pause'),
  setHidden: call('hub:hidden'),
  front: call('hub:front'),
  openFolder: call('hub:open-folder'),
  cover: call('hub:cover'),
  photo: call('hub:photo'),
  themeAll: call('hub:theme-all'),
  lockAll: call('hub:lock-all'),
  setSnap: call('hub:snap'),
  setLowMemory: call('hub:low-memory'),
  restart: call('hub:restart'),
  setSendTo: call('hub:send-to'),
  pending: call('hub:pending'),
  onState: (fn) => {
    const h = (_e, s) => fn(s);
    ipcRenderer.on('hub:state', h);
    return () => ipcRenderer.removeListener('hub:state', h);
  },
});
