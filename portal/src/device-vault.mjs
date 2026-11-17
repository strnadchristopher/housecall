/** Device-local non-extractable vault key. Not an XSS or copied-profile boundary. */
function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('housecall-account-device', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
export async function deviceVault(value, expectedBinding) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const t = database.transaction('keys', value === undefined ? 'readonly' : 'readwrite');
    const s = t.objectStore('keys');
    const r = value === undefined || value === null ? s.get('current') : s.put(value, 'current');
    if (value === null) r.onsuccess = () => { if (expectedBinding === undefined || r.result?.binding === expectedBinding) s.delete('current'); };
    t.oncomplete = () => { database.close(); resolve(r.result); };
    t.onabort = t.onerror = () => { database.close(); reject(t.error); };
  });
}
