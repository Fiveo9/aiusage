import { contextBridge, ipcRenderer } from 'electron'
import type { WidgetData } from './data'
import type { WidgetSettings } from './settings'
import type { ExchangeRateState } from './currency'

export interface InstallStatus {
  phase: 'installing' | 'launching' | 'done' | 'failed'
  error?: string
}

export interface WidgetAPI {
  getData: () => Promise<WidgetData | null>
  openDashboard: () => Promise<void>
  hideWindow: () => void
  resizeWindow: (height: number) => void
  onDataUpdate: (callback: (data: WidgetData) => void) => () => void
  onDataError: (callback: () => void) => () => void
  onInstallStatus: (callback: (status: InstallStatus) => void) => () => void
  onSetupStatus: (callback: (status: InstallStatus) => void) => () => void
  getSettings: () => Promise<WidgetSettings>
  saveSettings: (settings: WidgetSettings) => Promise<WidgetSettings>
  getExchangeRate: () => Promise<ExchangeRateState>
}

contextBridge.exposeInMainWorld('widget', {
  getData: () => ipcRenderer.invoke('widget:get-data'),
  openDashboard: () => ipcRenderer.invoke('widget:open-dashboard'),
  hideWindow: () => ipcRenderer.send('widget:hide-window'),
  resizeWindow: (height: number) => ipcRenderer.send('widget:resize-window', height),
  onDataUpdate: (callback: (data: WidgetData) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: WidgetData) => callback(data)
    ipcRenderer.on('widget:data-update', listener)
    return () => { ipcRenderer.removeListener('widget:data-update', listener) }
  },
  onDataError: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('widget:data-error', listener)
    return () => { ipcRenderer.removeListener('widget:data-error', listener) }
  },
  onInstallStatus: (callback: (status: InstallStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: InstallStatus) => callback(status)
    ipcRenderer.on('install:status', listener)
    return () => { ipcRenderer.removeListener('install:status', listener) }
  },
  onSetupStatus: (callback: (status: InstallStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: InstallStatus) => callback(status)
    ipcRenderer.on('setup:status', listener)
    return () => { ipcRenderer.removeListener('setup:status', listener) }
  },
  getSettings: () => ipcRenderer.invoke('widget:get-settings'),
  saveSettings: (settings: WidgetSettings) => ipcRenderer.invoke('widget:save-settings', settings),
  getExchangeRate: () => ipcRenderer.invoke('widget:get-exchange-rate'),
} satisfies WidgetAPI)
