'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('pods', {
  init: () => ipcRenderer.invoke('pod:init'),
  icons: () => ipcRenderer.invoke('pod:icons'),
  expand: (apply) => ipcRenderer.invoke('pod:expand', apply !== false),
  addDialog: (kind) => ipcRenderer.invoke('pod:add-dialog', kind),
  collapse: () => ipcRenderer.invoke('pod:collapse'),
  launch: (itemId) => ipcRenderer.invoke('pod:launch', itemId),
  addPaths: (paths) => ipcRenderer.invoke('pod:add-paths', paths),
  reorder: (itemId, beforeId) => ipcRenderer.invoke('pod:reorder', itemId, beforeId),
  rename: (name) => ipcRenderer.invoke('pod:rename', name),
  renameItem: (itemId, name) => ipcRenderer.invoke('pod:rename-item', itemId, name),
  contextMenu: (itemId, selected) => ipcRenderer.invoke('pod:context-menu', itemId || null, selected || []),
  resize: (w, h) => ipcRenderer.send('pod:resize', w, h),
  resizeEnd: () => ipcRenderer.send('pod:resize-end'),
  dragStart: () => ipcRenderer.send('pod:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('pod:drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('pod:drag-end'),
  escape: () => ipcRenderer.send('pod:escape'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },
  onUpdate: on('pod:update'),
  onPos: on('pod:pos'),
  onWallpaper: on('pod:wallpaper'),
  onCommand: on('pod:command'),
  onToast: on('pod:toast'),
  onBusy: on('pod:busy'),
});
