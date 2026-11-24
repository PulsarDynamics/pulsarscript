declare module "vscode" {
  export interface ExtensionContext {
    subscriptions: { dispose(): void }[];
    asAbsolutePath(relativePath: string): string;
  }
  export interface WorkspaceConfiguration {
    get<T>(section: string, defaultValue: T): T;
  }
  export interface WorkspaceFolder {
    uri: { fsPath: string };
  }
  export const workspace: {
    workspaceFolders?: readonly WorkspaceFolder[];
    getConfiguration(section: string): WorkspaceConfiguration;
    createFileSystemWatcher(globPattern: string): { dispose(): void };
  };
}

declare module "vscode-languageclient/node" {
  export interface ServerOptions {
    run: { command: string; args?: string[]; options?: { cwd?: string } };
    debug: { command: string; args?: string[]; options?: { cwd?: string } };
  }
  export interface LanguageClientOptions {
    documentSelector: { scheme: string; language: string }[];
    synchronize?: { fileEvents?: unknown };
  }
  export class LanguageClient {
    constructor(id: string, name: string, serverOptions: ServerOptions, clientOptions: LanguageClientOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
  }
}
