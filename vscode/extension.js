// ARBOR VS Code Extension — LSP client
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client = null;

function activate(context) {
  const config = vscode.workspace.getConfiguration('arbor');
  let serverPath = config.get('serverPath');

  if (!serverPath) {
    // Try to find arbor in workspace or use node with the lsp.js from the arbor installation
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const candidate = workspaceFolders[0].uri.fsPath + '/bin/arbor.js';
      try {
        require('fs').accessSync(candidate);
        serverPath = candidate;
      } catch (_) {}
    }
  }

  if (!serverPath) {
    vscode.window.showInformationMessage(
      'ARBOR: Set arbor.serverPath in settings to enable diagnostics and completions.'
    );
    return;
  }

  const serverOptions = {
    run: { module: serverPath, transport: TransportKind.ipc, args: ['lsp'] },
    debug: { module: serverPath, transport: TransportKind.ipc, args: ['lsp', '--debug'] }
  };

  const clientOptions = {
    documentSelector: [{ scheme: 'file', language: 'arbor' }],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher('**/*.ab') }
  };

  client = new LanguageClient('arbor', 'ARBOR Language Server', serverOptions, clientOptions);
  client.start();
  vscode.window.showInformationMessage('ARBOR language support activated!');
}

function deactivate() {
  if (client) client.stop();
}

module.exports = { activate, deactivate };
