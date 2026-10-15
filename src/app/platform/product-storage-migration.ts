/** Read legacy product keys once without overwriting newer preferences. */
export function migrateProductStorage(storage: Storage): void {
  try {
    const legacyPrefix = "unicorn.";
    const entries = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(legacyPrefix));
    for (const key of entries) {
      const destination = `trader.${key.slice(legacyPrefix.length)}`;
      if (storage.getItem(destination) !== null) continue;
      const value = storage.getItem(key);
      if (value !== null) storage.setItem(destination, value.replaceAll(legacyPrefix, "trader."));
    }
  } catch {
    // Storage can be disabled or full; existing keys remain intact for recovery.
  }
}
