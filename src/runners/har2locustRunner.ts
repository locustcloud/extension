import * as vscode from 'vscode';
import { EnvService } from '../services/envService';
import { Har2LocustService } from '../services/har2locustService';

/**
 * HAR → Locustfile runner (thin controller)
 * Delegates all logic to Har2LocustService.
 */
export class Har2LocustRunner {
  constructor(
    private env: EnvService,
    private service: Har2LocustService
  ) {}

  async convertHar() {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace to run commands.');
      return;
    }
    await this.service.convertHarInteractive();
  }
}
