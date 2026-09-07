export function normalizePath(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export function joinPath(...parts: (string | undefined)[]): string {
  return normalizePath(parts.filter((p): p is string => !!p).join("/"));
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.substring(0, i);
}

/** A flat map of every file in a dropped/selected folder, keyed by its
 * normalized path relative to the folder root. */
export class VirtualFileSystem {
  private files = new Map<string, File>();

  set(path: string, file: File): void {
    this.files.set(normalizePath(path), file);
  }

  get(path: string): File | undefined {
    return this.files.get(normalizePath(path));
  }

  has(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  keys(): IterableIterator<string> {
    return this.files.keys();
  }

  get size(): number {
    return this.files.size;
  }

  async readText(path: string): Promise<string | null> {
    const file = this.get(path);
    if (!file) return null;
    return file.text();
  }
}

async function readEntry(entry: FileSystemEntry, path: string): Promise<{ path: string; file: File }[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
    return [{ path: path + entry.name, file }];
  }
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    const allEntries: FileSystemEntry[] = [];
    await new Promise<void>((resolve, reject) => {
      const readBatch = (): void => {
        reader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve();
            return;
          }
          allEntries.push(...batch);
          readBatch();
        }, reject);
      };
      readBatch();
    });
    const nested = await Promise.all(allEntries.map((child) => readEntry(child, path + entry.name + "/")));
    return nested.flat();
  }
  return [];
}

export async function collectFromDrop(dataTransfer: DataTransfer): Promise<{ path: string; file: File }[]> {
  const items = dataTransfer.items;
  const jobs: Promise<{ path: string; file: File }[]>[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry();
    if (entry) jobs.push(readEntry(entry, ""));
  }
  const results = await Promise.all(jobs);
  return results.flat();
}

export function collectFromInput(fileList: FileList): { path: string; file: File }[] {
  const out: { path: string; file: File }[] = [];
  for (const file of Array.from(fileList)) {
    const withRelPath = file as File & { webkitRelativePath?: string };
    out.push({ path: withRelPath.webkitRelativePath || file.name, file });
  }
  return out;
}
