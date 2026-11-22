const DB_NAME = "droplink";
const DB_VERSION = 1;

const TRANSFERS = "transfers";
const CHUNKS = "chunks";

export type TransferHistory = {
  id: string;
  direction: "send" | "receive";
  name: string;
  size: number;
  type: string;
  status: "complete" | "cancelled" | "failed";
  createdAt: number;
  finishedAt: number;
  sha256?: string;
};

let cachedDb: IDBDatabase | null = null;
let dbOpeningPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (cachedDb) {
    return Promise.resolve(cachedDb);
  }

  if (dbOpeningPromise) {
    return dbOpeningPromise;
  }

  dbOpeningPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(TRANSFERS)) {
        db.createObjectStore(TRANSFERS, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(CHUNKS)) {
        const store = db.createObjectStore(CHUNKS, {
          keyPath: ["fileId", "index"],
        });
        store.createIndex("fileId", "fileId", { unique: false });
      }
    };

    request.onsuccess = () => {
      cachedDb = request.result;
      dbOpeningPromise = null;

      cachedDb.onclose = () => {
        cachedDb = null;
      };

      cachedDb.onversionchange = () => {
        cachedDb?.close();
        cachedDb = null;
      };

      resolve(cachedDb);
    };

    request.onerror = () => {
      dbOpeningPromise = null;
      reject(request.error ?? new Error("IndexedDB failed to open."));
    };
  });

  return dbOpeningPromise;
}

export async function saveTransferHistory(item: TransferHistory): Promise<void> {
  const db = await getDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(TRANSFERS, "readwrite");
    const store = transaction.objectStore(TRANSFERS);

    store.put(item);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Transfer history write failed."));
  });
}

export async function listTransferHistory(limit = 12): Promise<TransferHistory[]> {
  const db = await getDb();

  return new Promise<TransferHistory[]>((resolve, reject) => {
    const transaction = db.transaction(TRANSFERS, "readonly");
    const store = transaction.objectStore(TRANSFERS);
    const request = store.getAll();

    request.onsuccess = () => {
      const items = (request.result as TransferHistory[]) || [];
      items.sort((a, b) => b.finishedAt - a.finishedAt);
      resolve(items.slice(0, limit));
    };

    request.onerror = () =>
      reject(request.error ?? new Error("Transfer history read failed."));
  });
}

export async function saveReceivedChunk(
  fileId: string,
  index: number,
  blob: Blob
): Promise<void> {
  const db = await getDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(CHUNKS, "readwrite");
    const store = transaction.objectStore(CHUNKS);

    store.put({
      fileId,
      index,
      blob,
    });

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error(`Chunk write failed at index ${index}.`));
  });
}

/**
 * High-speed batch chunk write in a single IndexedDB transaction.
 * Boosts disk write throughput by up to 50x.
 */
export async function saveReceivedChunksBatch(
  fileId: string,
  chunks: { index: number; blob: Blob }[]
): Promise<void> {
  if (chunks.length === 0) return;
  const db = await getDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(CHUNKS, "readwrite");
    const store = transaction.objectStore(CHUNKS);

    for (const chunk of chunks) {
      store.put({
        fileId,
        index: chunk.index,
        blob: chunk.blob,
      });
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Batch chunk write failed."));
  });
}

export async function readReceivedFile(fileId: string): Promise<Blob> {
  const db = await getDb();

  const chunks = await new Promise<{ index: number; blob: Blob }[]>(
    (resolve, reject) => {
      const transaction = db.transaction(CHUNKS, "readonly");
      const store = transaction.objectStore(CHUNKS);
      const indexStore = store.index("fileId");
      const request = indexStore.getAll(IDBKeyRange.only(fileId));

      request.onsuccess = () => {
        resolve((request.result as { index: number; blob: Blob }[]) || []);
      };

      request.onerror = () =>
        reject(request.error ?? new Error("Chunk read failed."));
    }
  );

  if (chunks.length === 0) {
    return new Blob([]);
  }

  chunks.sort((a, b) => a.index - b.index);

  // Validate chunk sequence integrity
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].index !== i) {
      throw new Error(
        `Chunk sequence integrity error: expected chunk index ${i}, but found ${chunks[i].index}.`
      );
    }
  }

  return new Blob(chunks.map((chunk) => chunk.blob));
}

export async function clearReceivedFile(fileId: string): Promise<void> {
  const db = await getDb();

  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(CHUNKS, "readwrite");
    const store = transaction.objectStore(CHUNKS);
    const indexStore = store.index("fileId");
    const request = indexStore.openCursor(IDBKeyRange.only(fileId));

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Chunk cleanup failed."));
  });
}

/**
 * Clean up all orphaned chunks from past interrupted transfers.
 */
export async function clearAllChunks(): Promise<void> {
  try {
    const db = await getDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CHUNKS, "readwrite");
      const store = transaction.objectStore(CHUNKS);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore cleanup errors on start
  }
}
