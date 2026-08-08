export const MAX_PROJECT_CACHE_ENTRIES = 32;

interface CacheKeyStore<Key> {
	delete(key: Key): boolean;
}

/** Mark a cache hit as most recently used without changing its value. */
export function touchCacheEntry<Key, Value>(
	cache: Map<Key, Value>,
	key: Key
): Value | undefined {
	if (!cache.has(key)) {
		return undefined;
	}
	const value = cache.get(key) as Value;
	cache.delete(key);
	cache.set(key, value);
	return value;
}

/** Store a value as the most recently used entry. */
export function setCacheEntry<Key, Value>(
	cache: Map<Key, Value>,
	key: Key,
	value: Value
): void {
	cache.delete(key);
	cache.set(key, value);
}

/**
 * Bound a group of maps that share keys, using the primary map's insertion
 * order as the LRU order and evicting dependent metadata with the same key.
 */
export function enforceCacheLimit<Key>(
	primary: ReadonlyMap<Key, unknown>,
	cacheGroup: readonly CacheKeyStore<Key>[],
	maxEntries = MAX_PROJECT_CACHE_ENTRIES
): void {
	while (primary.size > maxEntries) {
		const oldest = primary.keys().next();
		if (oldest.done) {
			return;
		}
		for (const cache of cacheGroup) {
			cache.delete(oldest.value);
		}
	}
}
