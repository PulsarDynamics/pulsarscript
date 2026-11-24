import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("pulsarscript");
  const configured = config.get<string[]>("serverCommand", ["bun", "run", "lsp/server.ts"]);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const fallbackServer = context.asAbsolutePath(resolve("..", "..", "lsp", "server.ts"));

  const [cmd, ...args] = configured.length > 0 ? configured : ["bun", "run", fallbackServer];
  if (args.length === 2 && args[0] === "run" && args[1] === "lsp/server.ts" && workspaceRoot) {
    const localServer = resolve(workspaceRoot, "lsp", "server.ts");
    if (!existsSync(localServer) && existsSync(fallbackServer)) {
      args[1] = fallbackServer;
    }
  }

  const serverOptions: ServerOptions = {
    run: { command: cmd, args, options: workspaceRoot ? { cwd: workspaceRoot } : undefined },
    debug: { command: cmd, args, options: workspaceRoot ? { cwd: workspaceRoot } : undefined },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "pulsarscript" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{puls,json}"),
    },
  };

  client = new LanguageClient("pulsarscript", "PulsarScript Language Server", serverOptions, clientOptions);
  void client.start();
  context.subscriptions.push({
    dispose: () => {
      void client?.stop();
    },
  });
}

export function deactivate(): Promise<void> | undefined {
  return client?.stop();
}
