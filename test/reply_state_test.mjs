import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../src/ui/reply-state.js', import.meta.url), 'utf8'), context);
vm.runInContext(await readFile(new URL('../src/ui/history-view.js', import.meta.url), 'utf8'), context);
const api = context.LimilinkReplies;
const token = letter => 'r1:' + letter.repeat(64);
const known = (letter, index = 0) => ({ state: 'known', token: letter === null ? null : token(letter), index: letter === null ? null : index });
function store() {
    const map = new Map();
    return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}

test('first evidence is a baseline, including an explicit no-reply baseline', () => {
    const storage = store(), state = api.create(() => storage);
    assert.equal(state.observe('a', known('a')), false);
    assert.equal(state.isUnread('a'), false);
    assert.equal(Object.hasOwn(JSON.parse(storage.getItem(api.storagePrefix + 'a')), 'read'), false);
    state.observe('b', known(null));
    assert.equal(state.observe('b', known('a')), true);
    assert.equal(state.isUnread('b'), true);
    assert.equal(state.isUnread('a'), false);
    assert.equal(storage.map.size, 2);
});

test('unknown/malformed evidence cannot clear unread or reset a baseline', () => {
    const state = api.create(() => store());
    state.observe('a', known(null)); state.observe('a', known('a'));
    for (const value of [undefined, null, {}, { state: 'unknown' }, { ...known('b'), index: true }, { ...known(null), index: 0 }, { ...known('a'), token: 'wrong' }]) {
        assert.equal(state.observe('a', value), false);
        assert.equal(state.isUnread('a'), true);
    }
});

test('acknowledgement must match the exact current observed token', () => {
    const storage = store(), state = api.create(() => storage);
    state.observe('a', known(null)); state.observe('a', known('a'));
    assert.equal(state.markRead('a', token('b')), false);
    assert.equal(state.isUnread('a'), true);
    assert.equal(state.markRead('a', token('a')), true);
    state.observe('a', known('b', 2));
    assert.equal(state.isUnread('a'), true);
    assert.equal(state.markRead('a', token('a')), false);
    assert.equal(state.isUnread('a'), true);
    assert.equal(state.markRead('a', token('b')), true);
    assert.equal(JSON.parse(storage.getItem(api.storagePrefix + 'a')).read, token('b'));
});

test('reload preserves unread and never treats an unknown response as an empty history', () => {
    const storage = store(), first = api.create(() => storage);
    first.observe('a', known(null)); first.observe('a', known('a'));
    const fresh = api.create(() => storage);
    fresh.observe('a', { state: 'unknown' });
    fresh.observe('a', known('a'));
    assert.equal(fresh.isUnread('a'), true);
    fresh.markRead('a', token('a'));
    const again = api.create(() => storage);
    again.observe('a', known('a'));
    assert.equal(again.isUnread('a'), false);
});

test('storage failure retains memory state and does not block reads', () => {
    const broken = { getItem() { throw Error('disabled'); }, setItem() { throw Error('full'); } };
    const state = api.create(() => broken);
    state.observe('a', known(null)); state.observe('a', known('a'));
    state.observe('a', { state: 'unknown' });
    assert.equal(state.isUnread('a'), true);
    assert.equal(state.markRead('a', token('a')), true);
    assert.equal(state.isUnread('a'), false);
    state.observe('a', known('b'));
    assert.equal(state.isUnread('a'), true);
});

test('cross-tab baseline is not read; only an exact matching read event acknowledges', () => {
    const state = api.create(() => store());
    state.observe('a', known(null)); state.observe('a', known('b'));
    const key = api.storagePrefix + 'a';
    for (const value of [null, '{}', JSON.stringify({ version: 1, baseline: token('b') }), JSON.stringify({ version: 1, baseline: null, read: token('a') })]) {
        assert.equal(state.storageEvent(key, value), false);
        assert.equal(state.isUnread('a'), true);
    }
    assert.equal(state.storageEvent(key, JSON.stringify({ version: 1, baseline: null, read: token('b') })), true);
    assert.equal(state.isUnread('a'), false);
});

test('a matching acknowledgement made before this tab observes the reply is adopted', () => {
    const storage = store(), state = api.create(() => storage);
    state.observe('a', known(null));
    storage.setItem(api.storagePrefix + 'a', JSON.stringify({ version: 1, baseline: null, read: token('a') }));
    assert.equal(state.observe('a', known('a')), false);
    assert.equal(state.isUnread('a'), false);
});

test('session records are independent and known removal is distinct from unknown', () => {
    const storage = store(), state = api.create(() => storage);
    state.observe('a', known(null)); state.observe('b', known(null));
    state.observe('a', known('a')); state.observe('b', known('b'));
    state.markRead('b', token('b'));
    assert.equal(state.isUnread('a'), true);
    assert.equal(state.observe('a', known(null)), true);
    assert.equal(state.isUnread('a'), false);
    state.observe('a', known('a'));
    assert.equal(state.isUnread('a'), true); // No re-baseline on a temporary empty view.
});

test('incremental rendering requires an exact complete semantic prefix', () => {
    const prefix = context.LimilinkHistory.isPrefix;
    const a = { role: 'bot', content: 'same' }, b = { role: 'user', content: 'same' };
    assert.equal(prefix([], [a]), true);
    assert.equal(prefix([a], [a, a]), true); // Repeated canonical replies are not deduplicated.
    assert.equal(prefix([a, b], [a]), false);
    assert.equal(prefix([a], [b]), false);
    assert.equal(prefix([a], [{ ...a, content: 'changed' }]), false);
    assert.equal(prefix([a], [{ ...a, metadata: 'not displayed' }]), true);
});
