/**
 * PromptLens System Tray & Menu Bar Controller
 * Provides real-time status indicators, one-click proxy export, CA trust install, and window toggling.
 */

import { Tray, Menu, nativeImage, app, clipboard, dialog, BrowserWindow, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { CertManager } from './cert';
import { buildProxyEnv } from './proxy-env';

export class TrayController {
  private tray: Tray | null = null;

  constructor(
    private getMainWindow: () => BrowserWindow | null,
    private coreManager: any,
    private certManager: CertManager,
    private browserUrl?: string
  ) {}

  public init(): void {
    const icon = this.createTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip('PromptLens · Prompt Inspector');

    this.updateMenu();
    this.tray.on('click', () => {
      this.toggleMainWindow();
    });

    // Refresh tray status every 1.5s
    setInterval(() => {
      this.updateMenu();
    }, 1500);
  }

  public toggleMainWindow(): void {
    const win = this.getMainWindow();
    if (!win) return;
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  }

  public updateMenu(): void {
    if (!this.tray) return;

    const status = this.coreManager.getStatus();
    const isAuditing = status.isCoreRunning;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: isAuditing
          ? `🟢 状态: ${status.listenPort} 代理就绪`
          : `🔴 状态: ${status.listenPort} 核心离线`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: '📋 复制终端代理变量 (export HTTP_PROXY...)',
        click: () => {
          const cmd = buildProxyEnv(status.listenPort, this.certManager.getCertPaths().caCertPath, this.certManager.prepareAgentCaBundle());
          clipboard.writeText(cmd);
          dialog.showMessageBox({
            type: 'info',
            title: '已复制环境变量',
            message: '代理、证书及本地绕过变量已复制。请先信任根证书，并在终端执行命令启动目标 Agent（详见设置中心的 Agent 接入指南）。已运行的进程不会自动继承新环境变量。'
          });
        }
      },
      {
        label: '🔐 安装并信任 HTTPS 根证书…',
        click: async () => {
          const choice = await dialog.showMessageBox({ type: 'warning', buttons: ['取消', '安装并信任'], defaultId: 0, cancelId: 0, message: '信任此 CA 将允许解密配置域名的 HTTPS 流量。卸载应用不会自动撤销信任。是否继续？' });
          if (choice.response !== 1) return;
          const res = await this.certManager.installToSystemStore();
          dialog.showMessageBox({
            type: res.success ? 'info' : 'warning',
            title: '证书安装结果',
            message: res.message
          });
        }
      },
      { type: 'separator' },
      {
        label: '🖥️ 显示 / 隐藏控制台窗口',
        click: () => {
          this.toggleMainWindow();
        }
      },
      {
        label: '在默认浏览器打开仪表盘',
        enabled: !!this.browserUrl,
        click: () => { if (this.browserUrl) void shell.openExternal(this.browserUrl); }
      },
      {
        label: '🛠️ 开启 / 关闭开发者工具 (DevTools)',
        click: () => {
          const wins = BrowserWindow.getAllWindows();
          if (wins.length > 0) {
            wins[0].show();
            wins[0].webContents.toggleDevTools();
          }
        }
      },
      { type: 'separator' },
      {
        label: '❌ 退出 PromptLens',
        click: () => {
          app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  private createTrayIcon(): Electron.NativeImage {
    const packagedPath = path.join(process.resourcesPath, 'promptlens-mark.png');
    const devPath = path.join(__dirname, '../../resources/promptlens-mark.png');
    const iconPath = app.isPackaged ? packagedPath : devPath;
    if (fs.existsSync(iconPath)) {
      const icon = nativeImage.createFromPath(iconPath);
      icon.setTemplateImage(true);
      return icon;
    }

    // Fallback for an incomplete development checkout.
    const base64Png =
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAADhJREFUOE9jZKAQMFKon2H4f5oB45uBwX8sGsihA6gGgGg0DEaDQQwYpBkM4mFIMBgNQ6IBY8EAAK74DAH8OqYnAAAAAElFTkSuQmCC';
    const img = nativeImage.createFromBuffer(Buffer.from(base64Png, 'base64'));
    img.setTemplateImage(true);
    return img;
  }
}
