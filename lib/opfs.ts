/**
 * OPFS (Origin Private File System) storage for raw uploaded documents (§6.2).
 * Gracefully no-ops if the browser does not support OPFS.
 */

async function getDocsDir(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle("documents", { create: true });
  } catch {
    return null;
  }
}

export async function saveOriginalFile(documentId: string, filename: string, buf: ArrayBuffer): Promise<void> {
  const dir = await getDocsDir();
  if (!dir) return;
  try {
    const safeName = `${documentId}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const handle = await dir.getFileHandle(safeName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(buf);
    await writable.close();
  } catch {
    // Ignore OPFS write failure on constrained environments
  }
}

export async function readOriginalFile(documentId: string, filename: string): Promise<ArrayBuffer | null> {
  const dir = await getDocsDir();
  if (!dir) return null;
  try {
    const safeName = `${documentId}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const handle = await dir.getFileHandle(safeName);
    const file = await handle.getFile();
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

export async function removeOriginalFile(documentId: string, filename: string): Promise<void> {
  const dir = await getDocsDir();
  if (!dir) return;
  try {
    const safeName = `${documentId}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await dir.removeEntry(safeName);
  } catch {
    // Ignore if entry does not exist
  }
}

export async function clearAllOpfsFiles(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("documents", { recursive: true });
  } catch {
    // Ignore if directory does not exist
  }
}
