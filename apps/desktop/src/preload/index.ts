import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, CommandName, Commands, DesktopBridge } from '../../../../packages/desktop-contract/src/index';
const listeners = new Set<(event: AppEvent) => void>();
let port: MessagePort | undefined;
ipcRenderer.on('desktop:port', event => {
  port?.close();
  port = event.ports[0];
  if (!port) return;
  port.onmessage = (message: MessageEvent<AppEvent>) => {
    for (const listener of listeners) listener(message.data);
  };
  port.start();
});
const bridge: DesktopBridge = {
  invoke: <K extends CommandName>(command: K, args: Commands[K]['args']): Promise<Commands[K]['result']> => ipcRenderer.invoke('desktop:invoke', command, args),
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  platform: process.platform
};
contextBridge.exposeInMainWorld('desktop', bridge);
ipcRenderer.send('desktop:subscribe');
