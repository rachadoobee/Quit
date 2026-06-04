/**
 * db.js — IndexedDB data layer for QuitSnus
 *
 * This module wraps all IndexedDB access behind clean async (Promise-based)
 * functions. Everything else in the app depends on this layer, so it is built
 * first and exposes a stable API regardless of how storage works underneath.
 *
 * Database: quitsnus-db
 * Stores:
 *   - logs          (autoIncrement id)  { id, timestamp, note }
 *   - settings      (single record id:1)
 *   - achievements  (keyPath id)        { id, unlockedAt }
 */

const DB_NAME = 'quitsnus-db';
const DB_VERSION = 1;

// A single shared connection promise so we only open the DB once.
let _dbPromise = null;

/**
 * Open (and if needed, create/upgrade) the database.
 * Returns a Promise that resolves to the IDBDatabase instance.
 */
function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // Runs only when the DB is created or the version number increases.
    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // logs: auto-incrementing primary key, indexed by timestamp for queries.
      if (!db.objectStoreNames.contains('logs')) {
        const logsStore = db.createObjectStore('logs', {
          keyPath: 'id',
          autoIncrement: true,
        });
        logsStore.createIndex('timestamp', 'timestamp', { unique: false });
      }

      // settings: a single record keyed by id (always 1).
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }

      // achievements: keyed by the achievement's string id.
      if (!db.objectStoreNames.contains('achievements')) {
        db.createObjectStore('achievements', { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return _dbPromise;
}

/**
 * Small helper: run a transaction on a store and resolve when it completes.
 * @param {string} storeName
 * @param {'readonly'|'readwrite'} mode
 * @param {(store: IDBObjectStore) => IDBRequest|void} fn - work to perform.
 * @returns {Promise<any>} resolves with the request result (if fn returns one).
 */
async function withStore(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let request;
    try {
      request = fn(store);
    } catch (err) {
      reject(err);
      return;
    }

    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Convert a Date (or ISO string) into a local YYYY-MM-DD date key.
 * We use local time so "today" matches the user's wall clock.
 */
function toDateKey(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

/**
 * Return all log entries, sorted oldest → newest.
 * @returns {Promise<Array<{id:number, timestamp:string, note:string|null}>>}
 */
async function getLogs() {
  const logs = await withStore('logs', 'readonly', (store) => store.getAll());
  return (logs || []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Return all log entries whose local date matches the given YYYY-MM-DD string.
 * @param {string} dateStr
 */
async function getLogsForDate(dateStr) {
  const all = await getLogs();
  return all.filter((log) => toDateKey(log.timestamp) === dateStr);
}

/**
 * Add a new pouch log.
 * @param {string} [timestamp] - ISO string; defaults to now.
 * @param {string|null} [note]
 * @returns {Promise<number>} the new entry's id.
 */
async function addLog(timestamp = new Date().toISOString(), note = null) {
  return withStore('logs', 'readwrite', (store) =>
    store.add({ timestamp, note })
  );
}

/**
 * Delete a log entry by id.
 * @param {number} id
 */
async function deleteLog(id) {
  return withStore('logs', 'readwrite', (store) => store.delete(id));
}

/**
 * Update the timestamp (and optionally note) of an existing log entry.
 * @param {number} id
 * @param {string} newTimestamp - ISO string
 * @param {string|null} [newNote] - if undefined, keeps the existing note.
 */
async function updateLog(id, newTimestamp, newNote) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('logs', 'readwrite');
    const store = tx.objectStore('logs');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const entry = getReq.result;
      if (!entry) {
        reject(new Error(`Log ${id} not found`));
        return;
      }
      entry.timestamp = newTimestamp;
      if (newNote !== undefined) entry.note = newNote;
      store.put(entry);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * Get the single settings record, or null if setup hasn't run yet.
 * @returns {Promise<object|null>}
 */
async function getSettings() {
  const result = await withStore('settings', 'readonly', (store) =>
    store.get(1)
  );
  return result || null;
}

/**
 * Save the settings record. Always forces id:1 so there is only ever one.
 * @param {object} settings
 */
async function saveSettings(settings) {
  const toSave = { ...settings, id: 1 };
  return withStore('settings', 'readwrite', (store) => store.put(toSave));
}

/* ------------------------------------------------------------------ */
/* Achievements                                                        */
/* ------------------------------------------------------------------ */

/**
 * Return the set of unlocked achievements.
 * @returns {Promise<Array<{id:string, unlockedAt:string}>>}
 */
async function getUnlockedAchievements() {
  const result = await withStore('achievements', 'readonly', (store) =>
    store.getAll()
  );
  return result || [];
}

/**
 * Mark an achievement as unlocked (no-op if already unlocked).
 * @param {string} id
 * @returns {Promise<boolean>} true if newly unlocked, false if it already was.
 */
async function unlockAchievement(id) {
  const existing = await withStore('achievements', 'readonly', (store) =>
    store.get(id)
  );
  if (existing) return false;
  await withStore('achievements', 'readwrite', (store) =>
    store.put({ id, unlockedAt: new Date().toISOString() })
  );
  return true;
}

/* ------------------------------------------------------------------ */
/* Import / Export                                                     */
/* ------------------------------------------------------------------ */

/**
 * Export all logs, settings and achievements as a single JS object.
 * @returns {Promise<object>}
 */
async function exportAllData() {
  const [logs, settings, achievements] = await Promise.all([
    getLogs(),
    getSettings(),
    getUnlockedAchievements(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    version: DB_VERSION,
    logs,
    settings,
    achievements,
  };
}

/**
 * Restore from a previously exported object. This REPLACES existing data.
 * @param {object|string} json - the export object or its JSON string form.
 */
async function importAllData(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const db = await openDB();

  // Clear and repopulate each store within a single transaction per store.
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['logs', 'settings', 'achievements'], 'readwrite');
    const logsStore = tx.objectStore('logs');
    const settingsStore = tx.objectStore('settings');
    const achStore = tx.objectStore('achievements');

    logsStore.clear();
    settingsStore.clear();
    achStore.clear();

    if (Array.isArray(data.logs)) {
      data.logs.forEach((log) => {
        // Preserve original ids where present so references stay stable.
        logsStore.put(log);
      });
    }
    if (data.settings) {
      settingsStore.put({ ...data.settings, id: 1 });
    }
    if (Array.isArray(data.achievements)) {
      data.achievements.forEach((a) => achStore.put(a));
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Expose the API on a global object (no modules/bundler in this project).
window.DB = {
  openDB,
  toDateKey,
  getLogs,
  getLogsForDate,
  addLog,
  deleteLog,
  updateLog,
  getSettings,
  saveSettings,
  getUnlockedAchievements,
  unlockAchievement,
  exportAllData,
  importAllData,
};
