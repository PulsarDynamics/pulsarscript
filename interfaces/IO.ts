export interface FileEntry {
  name: string;
  isDir: boolean;
  size?: number;
}

export interface IOBridge {
  readFile(path: string): string | null | Promise<string | null>;
  writeFile(path: string, data: string): boolean | Promise<boolean>;
  listDir(path: string): FileEntry[] | Promise<FileEntry[]>;
  kvGet?(key: string): unknown | Promise<unknown>;
  kvSet?(key: string, value: unknown): boolean | Promise<boolean>;
  kvDelete?(key: string): boolean | Promise<boolean>;
  stat?(path: string): unknown | Promise<unknown>;
  exists?(path: string): boolean | Promise<boolean>;
  deleteFile?(path: string): boolean | Promise<boolean>;
}
