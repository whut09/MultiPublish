import {app, BrowserWindow} from 'electron';
import {promises as fs} from 'node:fs';
import path from 'node:path';

function writeRuntimeLog(label: string, detail: unknown) {
  const directory = app.isReady() ? app.getPath('logs') : path.join(process.cwd(), '.runtime-logs');
  const line = `[${new Date().toISOString()}] ${label}: ${detail instanceof Error ? detail.stack || detail.message : String(detail)}\n`;
  void fs.mkdir(directory, {recursive: true}).then(() => fs.appendFile(path.join(directory, 'multipublish-runtime.log'), line, 'utf8')).catch(() => undefined);
}

process.on('uncaughtException', error => writeRuntimeLog('uncaughtException', error));
process.on('unhandledRejection', reason => writeRuntimeLog('unhandledRejection', reason));

export function attachWindowDiagnostics(window: BrowserWindow) {
  window.on('unresponsive', () => writeRuntimeLog('window-unresponsive', window.getTitle()));
  window.on('responsive', () => writeRuntimeLog('window-responsive', window.getTitle()));
  window.webContents.on('render-process-gone', (_event, details) => writeRuntimeLog('render-process-gone', JSON.stringify(details)));
}
