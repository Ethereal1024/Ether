// preload.cjs — the entire IPC surface the renderer is allowed to see.
//
// Deliberately CommonJS and deliberately tiny: with `sandbox: true` and
// `contextIsolation: true` the renderer never sees `require`, `fs` or
// `child_process`; it can only call the verbs below (§6).  Every
// one of them is a user action or a read of the status — none of them can run a
// program or touch a file.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ether', {
  /** Current status + UI labels. */
  state: () => ipcRenderer.invoke('state'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  restartAdb: () => ipcRenderer.invoke('restart-adb'),
  measure: (o) => ipcRenderer.invoke('measure', o),
  /**
   * Push channel: the main process sends the same `{status, labels}` payload the
   * invoke verbs return, whenever the status changes.
   */
  onState: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('status', listener);
    return () => ipcRenderer.removeListener('status', listener);
  },
});
