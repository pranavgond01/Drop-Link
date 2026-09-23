const DB_NAME = 'droplink-db';
const DB_VERSION = 1;
const META_STORE = 'transfers';
const CHUNK_STORE = 'chunks';
function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: 'transferId' });
            }
            if (!db.objectStoreNames.contains(CHUNK_STORE)) {
                const store = db.createObjectStore(CHUNK_STORE, { keyPath: ['transferId', 'index'] });
                store.createIndex('byTransfer', 'transferId', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
}
export async function saveTransfer(record) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readwrite');
        tx.objectStore(META_STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Failed to save transfer'));
    });
    db.close();
}
export async function getTransfer(transferId) {
    const db = await openDb();
    const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, 'readonly');
        const req = tx.objectStore(META_STORE).get(transferId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Failed to read transfer'));
    });
    db.close();
    return record;
}
export async function putChunk(transferId, index, data) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(CHUNK_STORE, 'readwrite');
        tx.objectStore(CHUNK_STORE).put({ transferId, index, data });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Failed to save chunk'));
    });
    db.close();
}
export async function getChunk(transferId, index) {
    const db = await openDb();
    const data = await new Promise((resolve, reject) => {
        const tx = db.transaction(CHUNK_STORE, 'readonly');
        const req = tx.objectStore(CHUNK_STORE).get([transferId, index]);
        req.onsuccess = () => resolve(req.result?.data);
        req.onerror = () => reject(req.error ?? new Error('Failed to read chunk'));
    });
    db.close();
    return data;
}
export async function getNextMissingChunk(transferId, totalChunks) {
    for (let i = 0; i < totalChunks; i += 1) {
        const chunk = await getChunk(transferId, i);
        if (!chunk)
            return i;
    }
    return totalChunks;
}
export async function assembleTransfer(transferId, totalChunks) {
    const chunks = [];
    for (let i = 0; i < totalChunks; i += 1) {
        const data = await getChunk(transferId, i);
        if (!data)
            throw new Error(`Missing chunk ${i}`);
        chunks.push(new Uint8Array(data));
    }
    return new Blob(chunks);
}
export async function deleteTransfer(transferId) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction([META_STORE, CHUNK_STORE], 'readwrite');
        tx.objectStore(META_STORE).delete(transferId);
        const index = tx.objectStore(CHUNK_STORE).index('byTransfer');
        const request = index.openCursor(IDBKeyRange.only(transferId));
        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Failed to delete transfer'));
    });
    db.close();
}
