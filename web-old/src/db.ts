const DB_NAME = 'droplink';

const DB_VERSION = 1;

const TRANSFERS = 'transfers';
const CHUNKS = 'chunks';

export type TransferHistory = {
  id: string;

  direction:
    | 'send'
    | 'receive';

  name: string;
  size: number;
  type: string;

  status:
    | 'complete'
    | 'cancelled'
    | 'failed';

  createdAt: number;
  finishedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise(
    (resolve, reject) => {
      const request =
        indexedDB.open(
          DB_NAME,
          DB_VERSION
        );

      request.onupgradeneeded = () => {
        const db = request.result;

        if (
          !db.objectStoreNames.contains(
            TRANSFERS
          )
        ) {
          db.createObjectStore(
            TRANSFERS,
            {
              keyPath: 'id',
            }
          );
        }

        if (
          !db.objectStoreNames.contains(
            CHUNKS
          )
        ) {
          const store =
            db.createObjectStore(
              CHUNKS,
              {
                keyPath: [
                  'fileId',
                  'index',
                ],
              }
            );

          store.createIndex(
            'fileId',
            'fileId',
            {
              unique: false,
            }
          );
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(
          request.error ??
            new Error(
              'IndexedDB failed to open.'
            )
        );
      };
    }
  );
}

export async function saveTransferHistory(
  item: TransferHistory
): Promise<void> {
  const db = await openDb();

  await new Promise<void>(
    (resolve, reject) => {
      const transaction =
        db.transaction(
          TRANSFERS,
          'readwrite'
        );

      transaction
        .objectStore(TRANSFERS)
        .put(item);

      transaction.oncomplete =
        () => resolve();

      transaction.onerror =
        () =>
          reject(
            transaction.error ??
              new Error(
                'Transfer history write failed.'
              )
          );
    }
  );

  db.close();
}

export async function listTransferHistory(
  limit = 12
): Promise<TransferHistory[]> {
  const db = await openDb();

  const result =
    await new Promise<TransferHistory[]>(
      (resolve, reject) => {
        const request =
          db
            .transaction(
              TRANSFERS,
              'readonly'
            )
            .objectStore(TRANSFERS)
            .getAll();

        request.onsuccess = () => {
          const items =
            (request.result as TransferHistory[]) ||
            [];

          items.sort(
            (a, b) =>
              b.finishedAt -
              a.finishedAt
          );

          resolve(
            items.slice(0, limit)
          );
        };

        request.onerror = () => {
          reject(
            request.error ??
              new Error(
                'Transfer history read failed.'
              )
          );
        };
      }
    );

  db.close();

  return result;
}

export async function saveReceivedChunk(
  fileId: string,
  index: number,
  blob: Blob
): Promise<void> {
  const db = await openDb();

  await new Promise<void>(
    (resolve, reject) => {
      const transaction =
        db.transaction(
          CHUNKS,
          'readwrite'
        );

      transaction
        .objectStore(CHUNKS)
        .put({
          fileId,
          index,
          blob,
        });

      transaction.oncomplete =
        () => resolve();

      transaction.onerror =
        () =>
          reject(
            transaction.error ??
              new Error(
                'Chunk write failed.'
              )
          );
    }
  );

  db.close();
}

export async function readReceivedFile(
  fileId: string
): Promise<Blob> {
  const db = await openDb();

  const chunks =
    await new Promise<
      {
        index: number;
        blob: Blob;
      }[]
    >((resolve, reject) => {
      const request =
        db
          .transaction(
            CHUNKS,
            'readonly'
          )
          .objectStore(CHUNKS)
          .index('fileId')
          .getAll(fileId);

      request.onsuccess = () => {
        resolve(
          (request.result as {
            index: number;
            blob: Blob;
          }[]) || []
        );
      };

      request.onerror = () => {
        reject(
          request.error ??
            new Error(
              'Chunk read failed.'
            )
        );
      };
    });

  db.close();

  chunks.sort(
    (a, b) => a.index - b.index
  );

  return new Blob(
    chunks.map(
      (chunk) => chunk.blob
    )
  );
}

export async function clearReceivedFile(
  fileId: string
): Promise<void> {
  const db = await openDb();

  await new Promise<void>(
    (resolve, reject) => {
      const transaction =
        db.transaction(
          CHUNKS,
          'readwrite'
        );

      const index =
        transaction
          .objectStore(CHUNKS)
          .index('fileId');

      const request =
        index.openCursor(
          IDBKeyRange.only(fileId)
        );

      request.onsuccess = () => {
        const cursor =
          request.result;

        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      transaction.oncomplete =
        () => resolve();

      transaction.onerror =
        () =>
          reject(
            transaction.error ??
              new Error(
                'Chunk cleanup failed.'
              )
          );
    }
  );

  db.close();
}