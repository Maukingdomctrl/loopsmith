const DB_NAME = "LoopEmojiStudio";
const STORE_NAME = "frames";
const PROJECT_STORE = "projects";
const DB_VERSION = 3;
const LAYER_STORE = "layers";
const ACTIVE_KEY = "loop-active-project";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
  const db = request.result;

  if (!db.objectStoreNames.contains(STORE_NAME)) {
    db.createObjectStore(STORE_NAME);
  }

  if (!db.objectStoreNames.contains(PROJECT_STORE)) {
    db.createObjectStore(PROJECT_STORE);
  }

  if (!db.objectStoreNames.contains(LAYER_STORE)) {
    db.createObjectStore(LAYER_STORE);
  }

};
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const makeKey = (projectId: string, frameId: string) =>
  `${projectId}-${frameId}`;

export async function saveFrameImage(
  projectId: string,
  frameId: string,
  image: string
): Promise<void> {
  const db = await openDB();
  const key = makeKey(projectId, frameId);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(image, key);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadFrameImage(
  projectId: string,
  frameId: string
): Promise<string | null> {
  const db = await openDB();
  const key = makeKey(projectId, frameId);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteFrameImage(
  projectId: string,
  frameId: string
): Promise<void> {
  const db = await openDB();
  const key = makeKey(projectId, frameId);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearDatabase(): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function deleteProjectImages(
  projectId: string
): Promise<void> {
  const db = await openDB();
  

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;

      if (String(cursor.key).startsWith(projectId + "-")) {
        cursor.delete();
      }

      cursor.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
const PROJECTS_KEY = "all-projects";

export async function saveProjects(projects: unknown): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, "readwrite");
    tx.objectStore(PROJECT_STORE).put(projects, PROJECTS_KEY);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadProjects<T>(): Promise<T | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, "readonly");
    const request = tx.objectStore(PROJECT_STORE).get(PROJECTS_KEY);

    request.onsuccess = () => resolve((request.result as T) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export function loadActiveProjectId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveProjectId(id: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(ACTIVE_KEY, id);
}

export async function saveLayerImage(
  key: string,
  image: string
): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LAYER_STORE, "readwrite");
    tx.objectStore(LAYER_STORE).put(image, key);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadLayerImage(
  key: string
): Promise<string | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LAYER_STORE, "readonly");
    const request = tx.objectStore(LAYER_STORE).get(key);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteLayerImage(key: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LAYER_STORE, "readwrite");
    tx.objectStore(LAYER_STORE).delete(key);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadProjectLayerImages(
  projectId: string
): Promise<Map<string, string>> {
  const db = await openDB();
  const prefix = `${projectId}-`;

  return new Promise((resolve, reject) => {
    const out = new Map<string, string>();
    const tx = db.transaction(LAYER_STORE, "readonly");
    const request = tx.objectStore(LAYER_STORE).openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;

      const key = String(cursor.key);
      if (key.startsWith(prefix)) {
        out.set(key, cursor.value as string);
      }

      cursor.continue();
    };

    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

export async function pruneLayerImages(
  projectId: string,
  liveKeys: ReadonlySet<string>
): Promise<void> {
  const db = await openDB();
  const prefix = `${projectId}-`;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(LAYER_STORE, "readwrite");
    const request = tx.objectStore(LAYER_STORE).openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;

      const key = String(cursor.key);
      if (key.startsWith(prefix) && !liveKeys.has(key)) {
        cursor.delete();
      }

      cursor.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProjectLayerImages(
  projectId: string
): Promise<void> {
  return pruneLayerImages(projectId, new Set());
}