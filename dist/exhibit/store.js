/* 展示会備品 — where the data lives.
 * Firestore when signed in with Google on the portal; this browser's storage for the demo.
 * Both offer the same calls, so the page never needs to know which one it is using. */
(function (root) {
    'use strict';

    const COLLECTIONS = Object.freeze({
        items: 'exhibit_items',
        history: 'exhibit_history',
        photos: 'exhibit_photos',
        settings: 'exhibit_settings'
    });

    function staleError() {
        const error = new Error('stale');
        error.code = 'exhibit/stale';
        error.userMessage = 'ほかの人が先にこの備品を更新しました。最新の内容を確かめてから、もう一度操作してください。';
        return error;
    }
    // Firestore rejects undefined; the documents only hold plain values.
    function plain(value) { return JSON.parse(JSON.stringify(value)); }
    function byAtDesc(a, b) { return String(b.at || '').localeCompare(String(a.at || '')); }
    function nextDay(date) {
        const [y, m, d] = date.split('-').map(Number);
        const t = new Date(Date.UTC(y, m - 1, d + 1));
        return t.toISOString().slice(0, 10);
    }

    function createFirestoreStore(db) {
        const col = name => db.collection(COLLECTIONS[name]);
        const settingsDoc = id => col('settings').doc(id);
        return {
            mode: 'firestore',
            subscribe(handlers) {
                const stops = [];
                const list = (name) => stops.push(col(name).onSnapshot(
                    snap => handlers.onData(name, snap.docs.map(doc => Object.assign({}, doc.data(), { id: doc.id }))),
                    error => handlers.onError(name, error)
                ));
                const setting = (id) => stops.push(settingsDoc(id).onSnapshot(
                    doc => handlers.onData(id, doc.exists ? doc.data() : null),
                    error => handlers.onError(id, error)
                ));
                list('items');
                setting('master');
                return () => stops.forEach(stop => stop());
            },
            // Reads the listed items inside one transaction, refuses when someone else changed them since
            // the screen showed them (expectRevs), then writes everything plan() returns together.
            commit(options, plan) {
                const itemIds = [...new Set(options.itemIds || [])];
                const expectRevs = options.expectRevs || {};
                return db.runTransaction(async tx => {
                    const docs = await Promise.all(itemIds.map(id => tx.get(col('items').doc(id))));
                    const items = {};
                    docs.forEach(doc => { if (doc.exists) items[doc.id] = Object.assign({}, doc.data(), { id: doc.id }); });
                    itemIds.forEach(id => {
                        if (!(id in expectRevs)) return;
                        const rev = items[id] ? Number(items[id].rev) || 0 : -1;
                        if (rev !== expectRevs[id]) throw staleError();
                    });
                    const writes = plan({ items }) || {};
                    (writes.items || []).forEach(item => tx.set(col('items').doc(item.id), plain(item)));
                    (writes.history || []).forEach(entry => tx.set(col('history').doc(entry.id), plain(entry)));
                    return writes.result;
                });
            },
            saveSettings(id, value) { return settingsDoc(id).set(plain(value)); },
            async loadItemHistory(itemId) {
                const snap = await col('history').where('itemId', '==', itemId).get();
                return snap.docs.map(doc => Object.assign({}, doc.data(), { id: doc.id })).sort(byAtDesc);
            },
            async loadHistory({ from, to, limit }) {
                let query = col('history');
                if (from) query = query.where('at', '>=', from);
                if (to) query = query.where('at', '<', nextDay(to));
                query = query.orderBy('at', 'desc');
                if (limit) query = query.limit(limit);
                const snap = await query.get();
                return snap.docs.map(doc => Object.assign({}, doc.data(), { id: doc.id }));
            },
            async loadPhoto(itemId) {
                const doc = await col('photos').doc(itemId).get();
                return doc.exists ? doc.data().data || null : null;
            },
            savePhoto(itemId, dataUrl) {
                return dataUrl ? col('photos').doc(itemId).set({ data: dataUrl, itemId }) : col('photos').doc(itemId).delete();
            }
        };
    }

    function createLocalStore(storageKey, seed) {
        const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
        function load() {
            try {
                const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
                return saved && Array.isArray(saved.items) ? saved : null;
            } catch (error) { return null; }
        }
        let data = load() || seed();
        let handlers = null;
        function persist() {
            try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch (error) { console.warn('Demo data could not be saved:', error); }
        }
        function emit() {
            if (!handlers) return;
            handlers.onData('items', clone(data.items));
            handlers.onData('master', clone(data.settings.master || null));
        }
        function upsert(list, value) {
            const index = list.findIndex(x => x.id === value.id);
            if (index > -1) list[index] = clone(value); else list.push(clone(value));
        }
        persist();
        return {
            mode: 'local',
            subscribe(next) {
                handlers = next;
                setTimeout(emit, 0);
                const onStorage = event => { if (event.key === storageKey) { data = load() || seed(); emit(); } };
                window.addEventListener('storage', onStorage);
                return () => { handlers = null; window.removeEventListener('storage', onStorage); };
            },
            async commit(options, plan) {
                const itemIds = [...new Set(options.itemIds || [])];
                const expectRevs = options.expectRevs || {};
                const items = {};
                itemIds.forEach(id => { const item = data.items.find(x => x.id === id); if (item) items[id] = clone(item); });
                itemIds.forEach(id => {
                    if (!(id in expectRevs)) return;
                    const rev = items[id] ? Number(items[id].rev) || 0 : -1;
                    if (rev !== expectRevs[id]) throw staleError();
                });
                const writes = plan({ items }) || {};
                (writes.items || []).forEach(item => upsert(data.items, item));
                (writes.history || []).forEach(entry => data.history.push(clone(entry)));
                persist();
                emit();
                return writes.result;
            },
            async saveSettings(id, value) { data.settings[id] = clone(value); persist(); emit(); },
            async loadItemHistory(itemId) { return clone(data.history.filter(entry => entry.itemId === itemId).sort(byAtDesc)); },
            async loadHistory({ from, to, limit }) {
                const list = data.history
                    .filter(entry => (!from || entry.at >= from) && (!to || entry.at < nextDay(to)))
                    .sort(byAtDesc);
                return clone(limit ? list.slice(0, limit) : list);
            },
            async loadPhoto(itemId) { return (data.photos || {})[itemId] || null; },
            async savePhoto(itemId, dataUrl) {
                data.photos = data.photos || {};
                if (dataUrl) data.photos[itemId] = dataUrl; else delete data.photos[itemId];
                persist();
            },
            reset() { data = seed(); persist(); emit(); }
        };
    }

    root.ExhibitStore = { COLLECTIONS, createFirestoreStore, createLocalStore };
})(window);
