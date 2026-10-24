// Browser-local unread cursors. Tokens are opaque and have no chronological order.
(() => {
    'use strict';
    const PREFIX = 'limilink_reply_read_v1:';
    const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    const token = value => value === null || (typeof value === 'string' && /^r1:[0-9a-f]{64}$/.test(value));
    function evidence(value) {
        if (!value || value.state !== 'known' || !token(value.token)) return null;
        if (value.token === null ? value.index !== null : !Number.isSafeInteger(value.index) || value.index < 0) return null;
        return { state: 'known', token: value.token, index: value.index };
    }
    function decode(raw) {
        try {
            if (typeof raw !== 'string' || raw.length > 512) return null;
            const value = JSON.parse(raw);
            if (value?.version !== 1 || !token(value.baseline)) return null;
            if (owns(value, 'read') && !token(value.read)) return null;
            return { version: 1, baseline: value.baseline, ...(owns(value, 'read') ? { read: value.read } : {}) };
        } catch { return null; }
    }
    function create(getStorage = () => globalThis.localStorage) {
        const records = new Map(), observed = new Map();
        const load = id => {
            try { return decode(getStorage().getItem(PREFIX + id)); } catch { return null; }
        };
        const save = id => {
            try { getStorage().setItem(PREFIX + id, JSON.stringify(records.get(id))); } catch { /* Keep memory state. */ }
        };
        const unread = id => {
            const current = observed.get(id), record = records.get(id);
            if (!current || !record || current.token === null) return false;
            const read = owns(record, 'read') ? record.read : record.baseline;
            return current.token !== read;
        };
        return {
            isUnread: unread,
            observe(id, value) {
                const next = evidence(value);
                if (!next) return false; // Unknown/error must not clear known state.
                const before = unread(id);
                if (!records.has(id)) {
                    const stored = load(id);
                    records.set(id, stored || { version: 1, baseline: next.token });
                    if (!stored) save(id);
                } else {
                    // Another tab may have read this exact reply before we learned of it.
                    const stored = load(id);
                    if (stored && owns(stored, 'read') && stored.read === next.token) {
                        records.get(id).read = next.token;
                    }
                }
                observed.set(id, next);
                return before !== unread(id);
            },
            markRead(id, displayedToken) {
                if (observed.get(id)?.token !== displayedToken || !records.has(id)) return false;
                const before = unread(id), record = records.get(id);
                if (!owns(record, 'read') || record.read !== displayedToken) {
                    record.read = displayedToken;
                    save(id);
                }
                return before !== unread(id);
            },
            storageEvent(key, raw) {
                if (typeof key !== 'string' || !key.startsWith(PREFIX)) return false;
                const id = key.slice(PREFIX.length), incoming = decode(raw);
                const current = observed.get(id), record = records.get(id);
                // A baseline is not an acknowledgement; nor is a different token.
                if (!record || !current || !incoming || !owns(incoming, 'read')
                    || incoming.read !== current.token) return false;
                const before = unread(id);
                record.read = incoming.read;
                return before !== unread(id);
            },
        };
    }
    globalThis.LimilinkReplies = { create, evidence, storagePrefix: PREFIX };
})();
