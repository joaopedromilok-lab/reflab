const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('api', {
  appInfo: invoke('app:info'),
  tools: {
    status: invoke('tools:status'),
    install: invoke('tools:install'),
    updateYtDlp: invoke('tools:updateYtDlp'),
    versions: invoke('tools:versions'),
    onProgress: on('tools:progress'),
    onAutoUpdated: on('tools:autoUpdated'),
  },
  update: {
    check: invoke('update:check'),
    install: invoke('update:install'),
    onAvailable: on('update:available'),
    onProgress: on('update:progress'),
  },
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  dialog: { folder: invoke('dialog:folder'), video: invoke('dialog:video') },
  jobs: {
    list: invoke('jobs:list'),
    add: invoke('jobs:add'),
    cancel: invoke('jobs:cancel'),
    remove: invoke('jobs:remove'),
    retry: invoke('jobs:retry'),
    clearFinished: invoke('jobs:clearFinished'),
    onUpdate: on('jobs:update'),
    onRemoved: on('jobs:removed'),
  },
  study: { load: invoke('study:load') },
  history: { list: invoke('history:list'), remove: invoke('history:remove'), clear: invoke('history:clear') },
  fs: { exists: invoke('fs:exists') },
  shell: { open: invoke('shell:open'), reveal: invoke('shell:reveal'), external: invoke('shell:external') },
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
});
