'use strict';

const byId = id => document.getElementById(id);
const app = byId('app');
const sidebar = byId('session-sidebar');
const conversation = byId('conversation');
const sessionList = byId('session-list');
const chat = byId('chat-container');
const input = byId('message-input');
const sendButton = byId('send-btn');
const renameDialog = byId('rename-dialog');
const mobile = window.matchMedia('(max-width: 720px)');
const drafts = new Map();
const pendingSends = new Map();
const displaySends = new Map();
const activePosts = new Map();
const historyCache = new Map();
const unconfirmedSends = new Map();
const savedReceiptCursor = new Map();
const reconcileViews = new Set();
let serverBusy = new Set();
let sessions = [];
let currentSession = null;
let navigationVersion = 0;
let snapshotSequence = 0;
let sendGeneration = 0;
let activeSnapshot = null;
let activeReceiptCheck = null;
let activeReplyCheck = null;
let replyCursor = 0;
let replyReadFrame = null;
let replies = null;
let historyView = null;
let displayedReply = null;
let replyTrackingAvailable = false;
let sendIdentityAvailable = false;
let backgroundReceiptCursor = 0;
let pollTimer = null;
let connected = false;
let checkingSnapshot = false;
let historyReady = false;
let sidebarBusy = false;
let renameTarget = null;
let dragSource = null;
let namePress = null;
let releaseClick = false;
let isScrolledToBottom = true;
let chatGeometry = null;
let serverClockOffset = 0;
let trashTimer = null;
let nextTrashRefresh = 0;

function isTrashed(id) { return sessions.some(session => session.id === id && session.delete_at !== undefined); }

const MAX_SESSION_SENDS = 16, MAX_TOTAL_SENDS = 128;
function pendingFor(id) { return [...(pendingSends.get(id)?.values() || [])]; }
function isPending(id, request) { return pendingSends.get(id)?.get(request.id) === request; }
function addPending(id, request) {
    let group = pendingSends.get(id);
    if (!group) pendingSends.set(id, group = new Map());
    group.set(request.id, request);
}
function removePending(id, request) {
    const group = pendingSends.get(id);
    if (group?.get(request.id) !== request) return;
    group.delete(request.id);
    if (!group.size) pendingSends.delete(id);
}
function trackedFor(id) {
    const records = new Map([...(displaySends.get(id)?.values() || [])].map(item => [item.id, item]));
    for (const item of pendingFor(id)) records.set(item.id, item);
    for (const item of unconfirmedSends.get(id) || []) records.set(item.id, item);
    for (const post of activePosts.values()) if (post.sessionId === id) records.set(post.request.id, post.request);
    return [...records.values()];
}
function isTracked(id, request) {
    return isPending(id, request) || (unconfirmedSends.get(id) || []).includes(request);
}
function hasReceipts(id) {
    return pendingSends.has(id) || (unconfirmedSends.get(id) || []).some(item => !item.failed);
}
function hasSendCapacity(id, text) {
    // One extra control slot keeps !stop available when ordinary slots are full.
    const extra = text.trim() === '!stop' ? 1 : 0;
    let total = 0;
    const keys = new Set([...pendingSends.keys(), ...unconfirmedSends.keys(), ...displaySends.keys(), ...[...activePosts.values()].map(item => item.sessionId)]);
    for (const key of keys) total += trackedFor(key).length;
    return trackedFor(id).length < MAX_SESSION_SENDS + extra && total < MAX_TOTAL_SENDS + extra;
}


async function api(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('The server returned an unreadable response.'); }
    if (!response.ok) {
        const detail = typeof data.detail === 'string' ? data.detail : 'The request could not be saved.';
        const error = new Error(detail);
        error.status = response.status;
        error.unconfirmed = data.code === 'send_indeterminate';
        throw error;
    }
    return data;
}

function jsonRequest(method, body) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function notice(message = '') {
    byId('notice').textContent = message;
    byId('notice').hidden = !message;
}

function rememberSession(id) {
    try { localStorage.setItem('limilink_last_session', id); } catch { /* Storage may be unavailable. */ }
}

function savedSession() {
    try { return localStorage.getItem('limilink_last_session'); } catch { return null; }
}

function sessionTitle(id) {
    return sessions.find(session => session.id === id)?.title || id || 'Limilink';
}

function addDisplay(id, request) {
    let group = displaySends.get(id);
    if (!group) displaySends.set(id, group = new Map());
    group.set(request.id, request);
}
function removeDisplay(id, request) {
    const group = displaySends.get(id);
    if (group?.get(request.id) !== request) return;
    group.delete(request.id);
    if (!group.size) displaySends.delete(id);
}
function hasTransportCapacity(text) {
    const stop = text.trim() === '!stop';
    return [...activePosts.values()].filter(item => (item.request.text.trim() === '!stop') === stop).length < (stop ? 1 : 2);
}

function updateHeading() {
    byId('session-title').textContent = sessionTitle(currentSession);
    byId('session-title').classList.toggle('trashed', isTrashed(currentSession));
    byId('session-directory').textContent = currentSession || '';
    document.title = currentSession ? `${sessionTitle(currentSession)} · Limilink` : 'Limilink Proxy';
}

function updateInputState() {
    input.disabled = !currentSession;
    const pending = pendingFor(currentSession);
    const busy = serverBusy.has(currentSession);
    // Cached reads are not admission authority. Keep the action available and
    // report any genuine local resource limit when the human actually sends.
    sendButton.disabled = false;
    sendButton.title = '';
    byId('typing').hidden = !connected || (!busy && !pending.length);
    byId('typing').textContent = busy ? 'Thinking…' : pending.some(item => item.accepted) ? 'Waiting for reply…' : 'Sending…';
}

function setSidebarBusy(value) {
    sidebarBusy = value;
    byId('new-session-btn').disabled = value;
    byId('refresh-sessions').disabled = value;
    byId('rename-save').disabled = value;
    // A pending rename must not be closed and reused for another target.
    byId('rename-cancel').disabled = value;
    updateHeading();
    renderSessions();
}

function setDrawer(open, returnFocus = true) {
    cancelNamePress();
    open = mobile.matches && open;
    app.classList.toggle('sidebar-open', open);
    byId('sidebar-backdrop').hidden = !open;
    byId('sidebar-toggle').setAttribute('aria-expanded', String(open));
    sidebar.inert = mobile.matches && !open;
    conversation.inert = open;
    if (!open) scheduleReplyRead();
    if (open) {
        sidebar.setAttribute('role', 'dialog');
        sidebar.setAttribute('aria-modal', 'true');
        byId('sidebar-close').focus();
    } else {
        sidebar.removeAttribute('role');
        sidebar.removeAttribute('aria-modal');
        if (returnFocus && mobile.matches) byId('sidebar-toggle').focus();
    }
}

function actionButton(text, action, session, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.dataset.action = action;
    button.dataset.sessionId = session.id;
    button.disabled = disabled || sidebarBusy;
    button.addEventListener('click', () => {
        button.closest('details').open = false;
        if (action === 'rename') openRename(session.id);
        if (action === 'up') moveSession(session.id, -1);
        if (action === 'down') moveSession(session.id, 1);
    });
    return button;
}

function deliveryStatus(id) {
    const pending = pendingFor(id);
    const saved = unconfirmedSends.get(id) || [];
    if (saved.some(item => !item.failed)) return 'Unconfirmed';
    if (pending.length > 1) return `Pending ${pending.length}`;
    if (pending.length && !serverBusy.has(id)) return pending[0].accepted ? 'Pending' : pending[0].needsRecovery ? 'Confirming…' : 'Sending…';
    return saved.length ? 'Send failed' : '';
}

function renderSessions() {
    cancelNamePress();
    const scrollTop = sessionList.scrollTop;
    const active = document.activeElement;
    const focusedId = sessionList.contains(active) ? active.closest('.session-row')?.dataset.sessionId : null;
    const focusSelector = active.classList.contains('session-link') ? '.session-link' : active.classList.contains('trash-button') ? '.trash-button' : 'summary';
    sessionList.replaceChildren();
    byId('session-count').textContent = String(sessions.length);
    for (const session of sessions) {
        const index = sessions.findIndex(item => item.id === session.id);
        const row = document.createElement('li');
        row.className = 'session-row status-slotted';
        row.dataset.sessionId = session.id;
        row.classList.toggle('selected', session.id === currentSession);
        row.classList.toggle('busy', serverBusy.has(session.id));
        row.classList.toggle('unread', !!replies?.isUnread(session.id));
        row.classList.toggle('trashed', isTrashed(session.id));
        const handle = document.createElement('button');
        handle.className = 'drag-handle';
        handle.textContent = '⠿';
        handle.type = 'button';
        handle.setAttribute('aria-label', `Drag ${session.title} to reorder; move buttons are in its options`);
        handle.title = 'Drag to reorder';
        handle.draggable = !isTrashed(session.id) && !sidebarBusy;
        handle.disabled = isTrashed(session.id) || sidebarBusy;
        handle.addEventListener('dragstart', event => {
            if (sidebarBusy || isTrashed(session.id)) { event.preventDefault(); return; }
            cancelNamePress();
            dragSource = session.id;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', session.id);
        });
        handle.addEventListener('dragend', clearDrag);
        const link = document.createElement('button');
        link.className = 'session-link';
        link.type = 'button';
        link.dataset.sessionId = session.id;
        if (session.id === currentSession) link.setAttribute('aria-current', 'true');
        const name = document.createElement('span');
        name.className = 'session-name';
        name.textContent = session.title;
        name.title = session.title;
        const directory = document.createElement('span');
        directory.className = 'session-id';
        directory.textContent = session.id;
        if (isTrashed(session.id)) {
            directory.classList.add('trash-countdown');
            directory.dataset.deleteAt = session.delete_at;
        }
        link.append(name, directory);
        const status = document.createElement('span');
        status.className = 'session-status';
        const badge = (text, className, label) => {
            const node = document.createElement('span');
            node.className = className;
            node.textContent = text;
            node.title = label;
            node.setAttribute('role', 'status');
            node.setAttribute('aria-label', label);
            status.append(node);
        };
        if (serverBusy.has(session.id)) badge('⏳', 'session-working', 'Working');
        if (replies?.isUnread(session.id)) badge('New', 'session-unread', 'Unread reply');
        const delivery = deliveryStatus(session.id);
        if (delivery) badge(delivery, 'session-delivery', delivery);
        if (status.childNodes.length) link.append(status);
        link.addEventListener('click', event => {
            if (namePress?.active || (releaseClick && event.detail)) { event.preventDefault(); return; }
            selectSession(session.id, true, true);
        });
        link.addEventListener('keydown', event => {
            if (event.key === 'F2' && !sidebarBusy) { event.preventDefault(); openRename(session.id); }
        });
        const menu = document.createElement('details');
        menu.className = 'session-menu';
        const summary = document.createElement('summary');
        summary.textContent = '⋯';
        summary.setAttribute('aria-label', `Options for ${session.title}`);
        menu.addEventListener('toggle', () => {
            if (menu.open) {
                for (const other of sessionList.querySelectorAll('details')) {
                    if (other !== menu) other.open = false;
                }
                actions.scrollIntoView({ block: 'nearest' });
            }
        });
        const actions = document.createElement('div');
        actions.className = 'menu-items';
        actions.append(
            actionButton('Rename', 'rename', session),
            actionButton('Move up', 'up', session, isTrashed(session.id) || index === 0),
            actionButton('Move down', 'down', session, isTrashed(session.id) || index >= sessions.filter(item => item.delete_at === undefined).length - 1),
        );
        menu.append(summary, actions);
        const trash = document.createElement('button');
        trash.type = 'button';
        trash.className = 'trash-button';
        trash.textContent = isTrashed(session.id) ? '↶' : '🗑';
        trash.setAttribute('aria-label', isTrashed(session.id) ? `Undo trash for ${session.title}` : `Trash ${session.title}`);
        trash.title = isTrashed(session.id) ? 'Undo trash' : 'Trash for 60 seconds, then delete';
        trash.disabled = sidebarBusy;
        trash.addEventListener('click', () => setTrashed(session.id, !isTrashed(session.id)));
        row.append(handle, link, menu, trash);
        row.addEventListener('dragover', event => {
            if (dragSource && dragSource !== session.id && !sidebarBusy && !isTrashed(session.id)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const after = event.clientY > row.getBoundingClientRect().top + row.clientHeight / 2;
                row.classList.toggle('drop-before', !after);
                row.classList.toggle('drop-after', after);
            }
        });
        row.addEventListener('dragleave', event => {
            if (!row.contains(event.relatedTarget)) row.classList.remove('drop-before', 'drop-after');
        });
        row.addEventListener('drop', event => {
            event.preventDefault();
            const source = dragSource;
            const after = event.clientY > row.getBoundingClientRect().top + row.clientHeight / 2;
            clearDrag();
            const moved = sessions.find(item => item.id === source);
            if (!moved || source === session.id || sidebarBusy || isTrashed(source) || isTrashed(session.id)) return;
            const ordered = sessions.filter(item => item.id !== source);
            ordered.splice(ordered.findIndex(item => item.id === session.id) + Number(after), 0, moved);
            saveOrder(ordered, source);
        });
        sessionList.append(row);
    }
    if (!sessions.length) {
        const empty = document.createElement('li');
        empty.className = 'empty-list';
        empty.textContent = 'No sessions yet.';
        sessionList.append(empty);
    }
    paintTrashCountdowns();
    sessionList.scrollTop = scrollTop;
    if (focusedId) {
        const row = [...sessionList.children].find(item => item.dataset.sessionId === focusedId);
        row?.querySelector(focusSelector)?.focus({ preventScroll: true });
    }
}

function clearDrag() {
    dragSource = null;
    for (const row of sessionList.children) row.classList.remove('drop-before', 'drop-after');
}

// A name hold is separate from the existing native drag handle. Before the
// hold activates, touch movement is left to the browser for normal scrolling.
function cancelNamePress(suppressClick = false) {
    const press = namePress;
    namePress = null;
    if (!press) return;
    clearTimeout(press.timer);
    clearInterval(press.scroll);
    if (press.active || suppressClick) releaseClick = true;
    for (const row of sessionList.children) row.classList.remove('name-reordering', 'drop-before', 'drop-after');
}

function paintNameDrop(press) {
    for (const row of sessionList.children) row.classList.remove('drop-before', 'drop-after');
    press.target = null;
    const bounds = sessionList.getBoundingClientRect();
    if (press.x < bounds.left || press.x > bounds.right || press.y < bounds.top || press.y > bounds.bottom) return;
    const row = document.elementFromPoint(press.x, press.y)?.closest('.session-row');
    const id = row?.dataset.sessionId;
    if (!id || !sessionList.contains(row) || id === press.id || isTrashed(id)) return;
    press.target = id;
    press.after = press.y > row.getBoundingClientRect().top + row.clientHeight / 2;
    row.classList.add(press.after ? 'drop-after' : 'drop-before');
}

function startNamePress(target, x, y, kind, identifier) {
    cancelNamePress();
    const link = target.closest?.('.session-link');
    const id = link?.dataset.sessionId;
    if (!link || !sessionList.contains(link) || sidebarBusy || renameDialog.open || dragSource
        || !sessions.some(item => item.id === id) || isTrashed(id)) return;
    const press = { id, link, kind, identifier, startX: x, startY: y, x, y, active: false, timer: null, scroll: null, target: null };
    namePress = press;
    press.timer = setTimeout(() => {
        if (namePress !== press || !link.isConnected || sidebarBusy || renameDialog.open
            || isTrashed(id) || document.visibilityState !== 'visible') { cancelNamePress(); return; }
        press.active = true;
        window.getSelection()?.removeAllRanges();
        link.closest('.session-row').classList.add('name-reordering');
        press.scroll = setInterval(() => {
            if (namePress !== press) return;
            const bounds = sessionList.getBoundingClientRect();
            if (press.x >= bounds.left && press.x <= bounds.right && press.y >= bounds.top && press.y <= bounds.bottom) {
                const amount = press.y < bounds.top + 32 ? -10 : press.y > bounds.bottom - 32 ? 10 : 0;
                if (amount) sessionList.scrollTop += amount;
            }
            paintNameDrop(press);
        }, 50);
    }, 450);
}

function moveNamePress(x, y) {
    const press = namePress;
    if (!press) return;
    press.x = x; press.y = y;
    if (!press.active) {
        if (Math.hypot(x - press.startX, y - press.startY) > 8) cancelNamePress(true);
    } else paintNameDrop(press);
}

function finishNamePress(x, y) {
    const press = namePress;
    if (!press) return;
    if (!press.active) { cancelNamePress(); return; }
    moveNamePress(x, y);
    const target = press.target, after = press.after;
    cancelNamePress(true);
    if (!target || sidebarBusy || isTrashed(press.id) || isTrashed(target)
        || !sessions.some(item => item.id === press.id) || !sessions.some(item => item.id === target)) return;
    const ordered = sessions.filter(item => item.id !== press.id);
    ordered.splice(ordered.findIndex(item => item.id === target) + Number(after), 0, sessions.find(item => item.id === press.id));
    if (ordered.some((item, index) => item.id !== sessions[index].id)) saveOrder(ordered, press.id);
}

// Clear only on a new physical input, not touch-generated compatibility mouse
// events. The one release click may target a replacement row after saveOrder.
document.addEventListener('pointerdown', event => {
    if (event.isPrimary === false) { cancelNamePress(true); return; }
    cancelNamePress();
    releaseClick = false;
}, true);
document.addEventListener('keydown', () => { releaseClick = false; cancelNamePress(); }, true);
document.addEventListener('click', event => {
    if (releaseClick && event.detail) {
        releaseClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    }
}, true);
sessionList.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.sourceCapabilities?.firesTouchEvents || releaseClick) return;
    startNamePress(event.target, event.clientX, event.clientY, 'mouse', null);
});
document.addEventListener('mousemove', event => {
    if (namePress?.kind !== 'mouse') return;
    if (!(event.buttons & 1)) { cancelNamePress(); return; }
    moveNamePress(event.clientX, event.clientY);
});
document.addEventListener('mouseup', event => {
    if (event.button !== 0 || namePress?.kind !== 'mouse') return;
    if (namePress.active) event.preventDefault();
    finishNamePress(event.clientX, event.clientY);
});
sessionList.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) { cancelNamePress(); return; }
    const touch = event.touches[0];
    startNamePress(event.target, touch.clientX, touch.clientY, 'touch', touch.identifier);
}, { passive: true });
sessionList.addEventListener('touchmove', event => {
    if (namePress?.kind !== 'touch') return;
    const touch = event.touches.length === 1 && event.touches[0];
    if (!touch || touch.identifier !== namePress.identifier) { cancelNamePress(); return; }
    if (namePress.active) {
        if (!event.cancelable) { cancelNamePress(); return; }
        event.preventDefault();
    }
    moveNamePress(touch.clientX, touch.clientY);
}, { passive: false });
document.addEventListener('touchend', event => {
    if (namePress?.kind !== 'touch') return;
    const touch = [...event.changedTouches].find(item => item.identifier === namePress.identifier);
    if (!touch || event.touches.length) { cancelNamePress(); return; }
    if (namePress.active) {
        if (!event.cancelable) { cancelNamePress(); return; }
        event.preventDefault();
    }
    finishNamePress(touch.clientX, touch.clientY);
}, { passive: false });
document.addEventListener('touchcancel', () => cancelNamePress(), { passive: true });
sessionList.addEventListener('scroll', () => { if (namePress && !namePress.active) cancelNamePress(); });
sessionList.addEventListener('contextmenu', event => {
    if (namePress && event.target.closest?.('.session-link')) event.preventDefault();
});
document.addEventListener('mouseleave', () => { if (namePress?.kind === 'mouse') cancelNamePress(); });
window.addEventListener('blur', () => cancelNamePress());
window.addEventListener('pagehide', () => cancelNamePress());
window.addEventListener('resize', () => cancelNamePress());

function focusSession(id) {
    for (const button of sessionList.querySelectorAll('.session-link')) {
        if (button.dataset.sessionId === id) { button.focus(); break; }
    }
}

function applySessions(data) {
    sessions = data.sessions;
    recoverMissingSessions();
    if (typeof data.server_time === 'number') serverClockOffset = data.server_time * 1000 - Date.now();
    const hasTrash = sessions.some(session => session.delete_at !== undefined);
    if (hasTrash && trashTimer === null) trashTimer = setInterval(tickTrash, 1000);
    if (!hasTrash && trashTimer !== null) { clearInterval(trashTimer); trashTimer = null; }
    renderSessions();
    updateHeading();
    updateInputState();
}

async function readSessions() {
    applySessions(await api('/session-sidebar'));
}

function paintTrashCountdowns() {
    const now = (Date.now() + serverClockOffset) / 1000;
    for (const countdown of sessionList.querySelectorAll('.trash-countdown')) {
        const seconds = Math.max(0, Math.ceil(Number(countdown.dataset.deleteAt) - now));
        countdown.textContent = seconds ? `Deleting in ${seconds}s · Undo ↶` : 'Deletion pending';
        const undo = countdown.closest('.session-row').querySelector('.trash-button');
        undo.disabled = sidebarBusy || seconds === 0;
        undo.title = seconds ? 'Undo trash' : 'Undo window ended; waiting for deletion';
    }
}

function tickTrash() {
    if (document.visibilityState !== 'visible') return;
    paintTrashCountdowns();
    const now = Date.now();
    if (sessions.some(session => session.delete_at * 1000 <= now + serverClockOffset)
        && now >= nextTrashRefresh && !sidebarBusy && !renameDialog.open) {
        nextTrashRefresh = now + 5000;
        refreshSessions(true);
    }
}

async function refreshSessions(automatic = false) {
    if (sidebarBusy) return;
    setSidebarBusy(true);
    if (!automatic) notice();
    try {
        await readSessions();
        if (currentSession && !sessions.some(session => session.id === currentSession)) {
            await selectSession(sessions[0]?.id || null, false);
        }
    } catch (error) { notice(`Could not refresh sessions: ${error.message}`); }
    finally { setSidebarBusy(false); }
}

async function createSession() {
    if (sidebarBusy) return;
    const navigationAtStart = navigationVersion;
    setSidebarBusy(true);
    notice();
    try {
        const created = await api('/sessions', { method: 'POST' });
        await readSessions();
        if (navigationAtStart === navigationVersion) {
            await selectSession(created.session_id, false);
            setDrawer(false);
        }
    } catch (error) { notice(`Could not create session: ${error.message}`); }
    finally { setSidebarBusy(false); }
}

async function setTrashed(id, trashed) {
    if (sidebarBusy) return;
    setSidebarBusy(true);
    notice();
    try {
        const data = await api(`/sessions/${encodeURIComponent(id)}/trash`, { method: trashed ? 'POST' : 'DELETE' });
        applySessions(data);
    } catch (error) { notice(`Could not ${trashed ? 'trash' : 'restore'} session: ${error.message}`); }
    finally {
        setSidebarBusy(false);
        const row = [...sessionList.children].find(item => item.dataset.sessionId === id);
        row?.querySelector('.trash-button')?.focus({ preventScroll: true });
    }
}

function openRename(id) {
    cancelNamePress();
    if (sidebarBusy) return;
    renameTarget = id;
    byId('session-title-input').value = sessionTitle(id);
    byId('rename-error').textContent = '';
    renameDialog.showModal();
    byId('session-title-input').select();
}

byId('rename-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (sidebarBusy || !renameTarget) return;
    const id = renameTarget;
    const title = byId('session-title-input').value.trim();
    if (!title) { byId('rename-error').textContent = 'Enter a title.'; return; }
    setSidebarBusy(true);
    byId('rename-error').textContent = '';
    try {
        const saved = await api(`/sessions/${encodeURIComponent(id)}/title`, jsonRequest('PATCH', { title }));
        sessions = sessions.map(session => session.id === id ? { ...session, title: saved.title } : session);
        renameDialog.close();
    } catch (error) { byId('rename-error').textContent = error.message; }
    finally {
        setSidebarBusy(false);
        if (!renameDialog.open) focusSession(id);
    }
});
renameDialog.addEventListener('cancel', event => { if (sidebarBusy) event.preventDefault(); });
byId('rename-cancel').addEventListener('click', () => renameDialog.close());

async function saveOrder(ordered, focusId) {
    if (sidebarBusy) return;
    setSidebarBusy(true);
    notice();
    try {
        await api('/session-sidebar/order', jsonRequest('PUT', { session_ids: ordered.filter(session => session.delete_at === undefined).map(session => session.id) }));
        sessions = ordered;
    } catch (error) { notice(`Could not save session order: ${error.message}`); }
    finally { setSidebarBusy(false); focusSession(focusId); }
}

function moveSession(id, offset) {
    if (sidebarBusy || isTrashed(id)) return;
    const ordered = [...sessions];
    const index = ordered.findIndex(session => session.id === id);
    const destination = index + offset;
    if (index < 0 || destination < 0 || destination >= ordered.length || isTrashed(ordered[destination].id)) return;
    [ordered[index], ordered[destination]] = [ordered[destination], ordered[index]];
    saveOrder(ordered, id);
}

function emptyConversation(heading, detail = '') {
    chat.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty-conversation';
    const strong = document.createElement('strong');
    strong.textContent = heading;
    empty.append(strong, document.createTextNode(detail));
    chat.append(empty);
    return empty;
}

function measureChatGeometry() {
    return { width: chat.clientWidth, height: chat.clientHeight, contentHeight: chat.scrollHeight };
}

function chatBottomGap() {
    return Math.max(0, chat.scrollHeight - chat.clientHeight - chat.scrollTop);
}

function pinChatToBottom() {
    chat.scrollTop = chat.scrollHeight;
    isScrolledToBottom = true;
    chatGeometry = measureChatGeometry();
}

function trackChatScroll() {
    const geometry = measureChatGeometry();
    const resized = chatGeometry && (geometry.width !== chatGeometry.width
        || geometry.height !== chatGeometry.height || geometry.contentHeight !== chatGeometry.contentHeight);
    // Layout-driven scroll/anchoring is not an instruction to stop following.
    // History mutations record their own geometry before their scroll event.
    if (isScrolledToBottom && resized) pinChatToBottom();
    else {
        isScrolledToBottom = chatBottomGap() < 10;
        chatGeometry = geometry;
    }
}

function appendMessage(content, sender, scroll = true, requestId = null) {
    historyView.append(content, sender, requestId);
    if (scroll) pinChatToBottom();
}

function connectionStatus(message = '') {
    byId('connection-status').textContent = message;
    byId('connection-status').hidden = !message;
}

function recoverableForView() {
    const records = [];
    for (const [id, saved] of unconfirmedSends) {
        if (id === currentSession || !sessions.some(item => item.id === id)) {
            for (const request of saved) records.push({ sessionId: id, request });
        }
    }
    return records;
}

function recoverMissingSessions() {
    const known = new Set(sessions.map(item => item.id));
    const keys = new Set([...pendingSends.keys(), ...displaySends.keys(), ...[...activePosts.values()].map(item => item.sessionId)]);
    for (const id of keys) {
        if (known.has(id)) continue;
        for (const request of trackedFor(id)) {
            removePending(id, request);
            removeDisplay(id, request);
            if (request.dismissed) request.transport?.abort();
            else if (!request.settled) preserveUnconfirmed(id, request);
        }
    }
    showUnconfirmed();
}

function dismissRecoverable(records) {
    for (const { sessionId: id, request } of records) {
        if (!(unconfirmedSends.get(id) || []).includes(request)) continue;
        request.dismissed = true;
        removeDisplay(id, request);
        forgetSavedSend(id, request);
        // Explicit human recovery/dismissal may release an inaccessible old
        // transport. It neither replays a POST nor signals a backend process.
        if (!sessions.some(item => item.id === id)) request.transport?.abort();
    }
}

function showUnconfirmed() {
    const records = recoverableForView();
    const removed = records.some(item => item.sessionId !== currentSession);
    byId('unconfirmed-send').hidden = !records.length;
    byId('saved-send-status').textContent = removed
        ? 'Messages from removed conversations are saved below. Restoring copies them into this conversation’s draft.'
        : records.some(item => !item.request.failed)
            ? 'Delivery couldn’t be confirmed. Check the conversation before resending.'
            : 'The send failed. Your message is saved below.';
    byId('unconfirmed-text').textContent = records.map(({ sessionId, request }) =>
        sessionId === currentSession ? request.text : `Removed conversation ${sessionId}:\n${request.text}`).join('\n\n---\n\n');
    byId('restore-unconfirmed').disabled = !currentSession;
    byId('restore-unconfirmed').textContent = removed ? 'Restore here as draft' : 'Restore as draft';
}

function preserveUnconfirmed(id, request) {
    const saved = unconfirmedSends.get(id) || [];
    if (!saved.includes(request)) saved.push(request);
    unconfirmedSends.set(id, saved);
    showUnconfirmed();
}

function forgetSavedSend(id, request) {
    const saved = (unconfirmedSends.get(id) || []).filter(item => item !== request);
    if (saved.length) unconfirmedSends.set(id, saved);
    else unconfirmedSends.delete(id);
    showUnconfirmed();
}

function receiptCandidate(id) {
    const records = [...pendingFor(id), ...(unconfirmedSends.get(id) || []).filter(item => !item.failed)];
    const unique = [...new Map(records.map(item => [item.id, item])).values()];
    const cursor = savedReceiptCursor.get(id) || 0;
    savedReceiptCursor.set(id, (cursor + 1) % Math.max(1, unique.length));
    return { tracked: unique[cursor % unique.length] };
}

function settleSend(id, request, outcome) {
    if (!isTracked(id, request) || request.settled) return false;
    request.settled = true;
    removePending(id, request);
    if (outcome.status === 200) forgetSavedSend(id, request);
    else { removeDisplay(id, request); saveFailedSend(id, request, outcome.body.detail); }
    reconcileViews.add(id);
    // Exact terminal evidence releases a held transport; never retry its POST.
    request.transport?.abort();
    return true;
}

function reconcileReceipt(id, { tracked }, data, recover = false) {
    if (!tracked || !isTracked(id, tracked) || tracked.settled) return false;
    const receipt = data.send?.id === tracked.id ? data.send : null;
    if (receipt?.state === 'complete' && (!Number.isInteger(receipt.outcome?.status)
        || !receipt.outcome?.body || (receipt.outcome.status === 200
            ? typeof receipt.outcome.body.reply !== 'string'
            : receipt.outcome.status < 400 || receipt.outcome.status > 599 || !('detail' in receipt.outcome.body)))) {
        throw new Error('The server returned an incomplete Send receipt.');
    }
    if (receipt?.state === 'complete') return settleSend(id, tracked, receipt.outcome);
    if (receipt?.state === 'running') {
        const changed = !tracked.accepted || !isPending(id, tracked);
        tracked.accepted = true;
        tracked.needsRecovery = true;
        forgetSavedSend(id, tracked);
        addPending(id, tracked);
        return changed;
    }
    if (isPending(id, tracked) && (recover || tracked.needsRecovery || receipt?.state === 'indeterminate')) {
        removePending(id, tracked);
        preserveUnconfirmed(id, tracked);
        return true;
    }
    return false;
}

function saveFailedSend(id, request, detail) {
    request.failed = true;
    preserveUnconfirmed(id, request);
    notice(`Message in “${sessionTitle(id)}” failed: ${typeof detail === 'string' ? detail : 'The request failed.'}`);
}

function renderHistory(history, followBottom = isScrolledToBottom, finishedBefore = new Set()) {
    const scrollTop = chat.scrollTop;
    const recorded = globalThis.LimilinkHistory.canonicalSendIds(history);
    for (const item of [...(displaySends.get(currentSession)?.values() || [])]) {
        // A fresh snapshot after completion is authoritative even after a history rewrite.
        if (recorded.has(item.id) || (item.settled && finishedBefore.has(item.id))) removeDisplay(currentSession, item);
    }
    const optimistic = [...(displaySends.get(currentSession)?.values() || [])].filter(item => !item.failed);
    // Before capability discovery (or on an older server), absent canonical
    // IDs cannot prove coverage. Keep each local identity until exact evidence
    // or a fresh post-completion snapshot retires it.
    historyView.render(history, optimistic);
    if (followBottom) pinChatToBottom();
    else {
        chat.scrollTop = scrollTop;
        isScrolledToBottom = chatBottomGap() < 10;
        chatGeometry = measureChatGeometry();
    }
}

function invalidateSnapshot() {
    ++snapshotSequence;
    checkingSnapshot = false;
    if (activeSnapshot) {
        clearTimeout(activeSnapshot.timeout);
        activeSnapshot.controller.abort();
        activeSnapshot = null;
    }
}

async function syncSnapshot({ initial = false, recover = false, force = false, refreshView = false } = {}) {
    if (!currentSession || document.visibilityState !== 'visible') return false;
    if (activeSnapshot && !force) return activeSnapshot.promise;
    if (activeSnapshot?.recover && recover && activeSnapshot.id === currentSession) return activeSnapshot.promise;
    invalidateSnapshot();
    const id = currentSession;
    const navigation = navigationVersion;
    const generation = sendGeneration;
    const sequence = snapshotSequence;
    const candidate = receiptCandidate(id);
    const finishedBefore = new Set([...(displaySends.get(id)?.values() || [])].filter(item => item.settled).map(item => item.id));
    const { tracked } = candidate;
    if (recover) for (const request of pendingFor(id)) request.needsRecovery = true;
    const cached = historyCache.get(id);
    const controller = new AbortController();
    const request = { id, recover, controller, timeout: null, promise: null };
    let timedOut = false;
    const stillCurrent = () => id === currentSession && navigation === navigationVersion
        && sequence === snapshotSequence && generation === sendGeneration;
    checkingSnapshot = initial || recover || refreshView;
    if (checkingSnapshot) {
        // Revalidate readiness, not connectivity: a healthy foreground check
        // must not insert/remove banners or hide the existing typing indicator.
        if (!connected || !historyReady) connectionStatus('Checking conversation…');
        updateInputState();
    }
    request.timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
    activeSnapshot = request;
    request.promise = (async () => {
        try {
            const query = new URLSearchParams();
            if (cached) query.set('revision', cached.revision);
            if (tracked) query.set('request_id', tracked.id);
            const data = await api(`/sessions/${encodeURIComponent(id)}/snapshot?${query}`, { signal: controller.signal });
            if (!stillCurrent()) return false;
            const history = data.history ?? cached?.history;
            if (typeof data.revision !== 'string' || typeof data.busy !== 'boolean' || !Array.isArray(history)) {
                throw new Error('The server returned an incomplete conversation state.');
            }
            const changed = !cached || cached.revision !== data.revision;
            sendIdentityAvailable = data.send_identities === true;
            const reply = canonicalReply(data.reply, history);
            replyTrackingAvailable = !!reply;
            const unreadChanged = replies?.observe(id, reply) || false;
            historyCache.set(id, { revision: data.revision, history, reply });
            const nextBusy = new Set(data.busy_sessions || []);
            if (data.busy) nextBusy.add(id);
            const busyChanged = nextBusy.size !== serverBusy.size || [...nextBusy].some(key => !serverBusy.has(key));
            serverBusy = nextBusy;
            const reconciled = reconcileReceipt(id, candidate, data, recover);
            if (changed || initial || reconciled || refreshView || reconcileViews.has(id) || finishedBefore.size) renderHistory(history, initial || isScrolledToBottom, finishedBefore);
            reconcileViews.delete(id);
            historyReady = true;
            connected = true;
            connectionStatus();
            displayedReply = reply ? { ...reply, id } : null;
            scheduleReplyRead();
            if (busyChanged || reconciled || unreadChanged) renderSessions();
            updateInputState();
            return true;
        } catch (error) {
            if (!stillCurrent()) return false;
            if (controller.signal.aborted && !timedOut) return false;
            connected = false;
            if (error.status === 404) {
                await refreshSessions(true);
                return false;
            }
            connectionStatus('Connection lost. Reconnecting…');
            if (!historyReady && !cached) {
                const empty = emptyConversation('Could not load this conversation.', error.message);
                const retry = document.createElement('button');
                retry.className = 'quiet-button retry-history';
                retry.textContent = 'Try again';
                retry.addEventListener('click', () => loadHistory(id));
                empty.append(document.createElement('br'), retry);
            }
            updateInputState();
            return false;
        } finally {
            clearTimeout(request.timeout);
            if (activeSnapshot === request) activeSnapshot = null;
            if (stillCurrent()) {
                checkingSnapshot = false;
                updateInputState();
                chat.setAttribute('aria-busy', 'false');
            }
        }
    })();
    return request.promise;
}

async function loadHistory(id) {
    if (id !== currentSession) return false;
    invalidateSnapshot();
    historyReady = false;
    connected = false;
    const cached = historyCache.get(id);
    if (cached) {
        renderHistory(cached.history, true);
        displayedReply = cached.reply ? { ...cached.reply, id } : null;
        scheduleReplyRead();
    }
    else emptyConversation('Loading conversation…');
    chat.setAttribute('aria-busy', 'true');
    updateInputState();
    return syncSnapshot({ initial: true, force: true });
}


function canonicalReply(value, history) {
    const reply = globalThis.LimilinkReplies?.evidence(value);
    if (!reply) return null;
    let index = null;
    for (let i = history.length - 1; i >= 0; --i) {
        if (history[i].role === 'bot') { index = i; break; }
    }
    return reply.index === index ? reply : null;
}

function cancelReplyRead() {
    if (replyReadFrame !== null) cancelAnimationFrame(replyReadFrame);
    replyReadFrame = null;
}

function scheduleReplyRead() {
    if (!replies || !displayedReply || displayedReply.token === null) return;
    cancelReplyRead();
    const shown = displayedReply, navigation = navigationVersion;
    replyReadFrame = requestAnimationFrame(() => {
        replyReadFrame = null;
        if (shown !== displayedReply || navigation !== navigationVersion || shown.id !== currentSession
            || document.visibilityState !== 'visible' || !document.hasFocus()
            || conversation.inert || conversation.closest('[inert]') || document.querySelector('dialog[open]')
            || Math.max(0, chat.scrollHeight - chat.clientHeight - chat.scrollTop) >= 10) return;
        const node = historyView?.nodeAt(shown.index);
        if (!node || shown.token === null) return;
        const box = node.getBoundingClientRect(), viewport = chat.getBoundingClientRect();
        const top = Math.max(box.top, viewport.top, 0), bottom = Math.min(box.bottom, viewport.bottom, window.innerHeight);
        const left = Math.max(box.left, viewport.left, 0), right = Math.min(box.right, viewport.right, window.innerWidth);
        if (bottom <= top || right <= left) return;
        const exposed = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        if (!exposed || !node.contains(exposed)) return;
        if (replies.markRead(shown.id, shown.token)) renderSessions();
    });
}

function invalidateReplyCheck() {
    if (!activeReplyCheck) return;
    clearTimeout(activeReplyCheck.timeout);
    activeReplyCheck.controller.abort();
    activeReplyCheck = null;
}

async function syncReplyBatch() {
    if (!replies || !replyTrackingAvailable || document.visibilityState !== 'visible') return false;
    if (activeReplyCheck) return activeReplyCheck.promise;
    const ids = sessions.filter(session => session.id !== currentSession && session.delete_at === undefined).map(session => session.id);
    if (!ids.length) return false;
    const count = Math.min(8, ids.length), start = replyCursor % ids.length;
    const batch = Array.from({ length: count }, (_, i) => ids[(start + i) % ids.length]);
    replyCursor = (start + count) % ids.length;
    const navigation = navigationVersion, controller = new AbortController();
    const request = { controller, timeout: setTimeout(() => controller.abort(), 8000), promise: null };
    activeReplyCheck = request;
    request.promise = (async () => {
        try {
            const query = new URLSearchParams();
            batch.forEach(id => query.append('session_id', id));
            const data = await api('/session-replies?' + query, { signal: controller.signal });
            if (activeReplyCheck !== request || controller.signal.aborted || navigation !== navigationVersion
                || document.visibilityState !== 'visible' || !data.replies || typeof data.replies !== 'object') return false;
            let changed = false;
            for (const id of batch) {
                if (id !== currentSession && sessions.some(session => session.id === id && session.delete_at === undefined)) {
                    changed = replies.observe(id, data.replies[id]) || changed;
                }
            }
            if (changed) renderSessions();
            return true;
        } catch { return false; } // Old servers/unknown evidence never clear unread or disconnect chat.
        finally {
            clearTimeout(request.timeout);
            if (activeReplyCheck === request) activeReplyCheck = null;
        }
    })();
    return request.promise;
}

function invalidateReceiptCheck() {
    if (!activeReceiptCheck) return;
    clearTimeout(activeReceiptCheck.timeout);
    activeReceiptCheck.controller.abort();
    activeReceiptCheck = null;
}

async function syncBackgroundReceipt() {
    if (document.visibilityState !== 'visible') return false;
    if (activeReceiptCheck) return activeReceiptCheck.promise;
    // One extra GET per poll, round-robin over unresolved local Sends only.
    // No all-history polling, new timer or automatic POST retry.
    const ids = sessions.map(session => session.id).filter(id => id !== currentSession && hasReceipts(id));
    if (!ids.length) return false;
    const id = ids[backgroundReceiptCursor++ % ids.length];
    const candidate = receiptCandidate(id);
    const controller = new AbortController();
    const request = { controller, timeout: setTimeout(() => controller.abort(), 8000), promise: null };
    activeReceiptCheck = request;
    request.promise = (async () => {
        try {
            const query = new URLSearchParams({ request_id: candidate.tracked.id });
            const cached = historyCache.get(id);
            if (cached) query.set('revision', cached.revision);
            const data = await api(`/sessions/${encodeURIComponent(id)}/snapshot?${query}`, { signal: controller.signal });
            if (activeReceiptCheck !== request || controller.signal.aborted || id === currentSession
                || document.visibilityState !== 'visible') return false;
            if (typeof data.revision !== 'string' || typeof data.busy !== 'boolean') throw new Error('Incomplete conversation state.');
            const relevant = isTracked(id, candidate.tracked);
            if (!relevant) return false;
            const wasBusy = serverBusy.has(id);
            const delivery = deliveryStatus(id);
            const reconciled = reconcileReceipt(id, candidate, data);
            // This response owns only its requested session's activity evidence.
            // Never replace the selected view/cache or its global busy snapshot.
            if (data.busy) serverBusy.add(id);
            else serverBusy.delete(id);
            if (wasBusy !== data.busy || delivery !== deliveryStatus(id) || reconciled) renderSessions();
            if (reconciled) reconcileViews.add(id);
            return true;
        } catch { return false; } // Offscreen failures must not disconnect the selected conversation.
        finally {
            clearTimeout(request.timeout);
            if (activeReceiptCheck === request) activeReceiptCheck = null;
        }
    })();
    return request.promise;
}

function pollUpdates(options = {}) {
    syncSnapshot(options);
    syncBackgroundReceipt();
    syncReplyBatch();
}

function startPolling() {
    if (pollTimer === null && document.visibilityState === 'visible') {
        pollTimer = setInterval(pollUpdates, 2000);
    }
}

function pauseUpdates() {
    cancelNamePress();
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    invalidateSnapshot();
    invalidateReceiptCheck();
    invalidateReplyCheck();
    cancelReplyRead();
    for (const group of pendingSends.values()) for (const request of group.values()) request.needsRecovery = true;
}

function resumeUpdates() {
    if (document.visibilityState !== 'visible') return;
    startPolling();
    pollUpdates({ force: true, recover: true });
    scheduleReplyRead();
}

function usesMobileKeyboard() {
    // Pointer type alone cannot distinguish a touch laptop from a phone.
    // Keep the phone guard across landscape/desktop-width layouts; UA fallback
    // covers browsers without userAgentData, including iPad desktop-mode UA.
    return mobile.matches || navigator.userAgentData?.mobile === true
        || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function focusDesktopComposer() {
    if (!usesMobileKeyboard() && !input.disabled && document.visibilityState === 'visible') input.focus({ preventScroll: true });
}

async function selectSession(id, closeDrawer = true, focusComposer = false) {
    if (closeDrawer) setDrawer(false);
    if (id === currentSession) { if (focusComposer) focusDesktopComposer(); return; }
    if (currentSession) drafts.set(currentSession, input.value);
    invalidateSnapshot();
    invalidateReceiptCheck();
    invalidateReplyCheck();
    cancelReplyRead();
    displayedReply = null;
    historyView?.reset();
    currentSession = id;
    document.dispatchEvent(new Event('limilink:session'));
    navigationVersion++;
    connected = false;
    showUnconfirmed();
    input.value = drafts.get(id) || '';
    resizeInput();
    updateHeading();
    renderSessions();
    sessionList.querySelector('.session-link[aria-current]')?.scrollIntoView({ block: 'nearest' });
    if (!id) {
        invalidateSnapshot();
        connectionStatus();
        historyReady = false;
        chat.setAttribute('aria-busy', 'false');
        emptyConversation('Choose or create a session.');
        updateInputState();
        return;
    }
    rememberSession(id);
    updateInputState();
    if (focusComposer) focusDesktopComposer();
    await loadHistory(id);
}

function newSendId() {
    const bytes = new Uint8Array(16);
    // Supported on plain HTTP too; crypto.randomUUID is secure-context-only.
    crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

async function sendMessage() {
    const text = input.value.trim();
    if (!currentSession) { notice('Choose a conversation first. Your draft is unchanged.'); return; }
    if (!text) { notice('Write a message first.'); return; }
    if (!hasSendCapacity(currentSession, text)) {
        notice('Not sent: local message limit reached. Restore or dismiss saved messages. Your draft is unchanged.');
        return;
    }
    if (!hasTransportCapacity(text)) {
        notice(text === '!stop'
            ? 'Not sent: a stop request is still pending. Your draft is unchanged.'
            : 'Not sent: two requests are still pending. Your draft is unchanged.');
        return;
    }
    const id = currentSession;
    let requestId;
    try {
        requestId = newSendId();
        if (trackedFor(id).some(item => item.id === requestId)) throw new Error('Duplicate Send identity');
    }
    catch { notice('This browser could not safely identify the send. Your draft has been kept.'); return; }
    notice();
    const request = { id: requestId, text, needsRecovery: false, accepted: false, settled: false, transport: new AbortController() };
    ++sendGeneration;
    invalidateSnapshot();
    if (text === '!stop') { invalidateReceiptCheck(); invalidateReplyCheck(); }
    addPending(id, request);
    addDisplay(id, request);
    activePosts.set(request, { sessionId: id, request });
    input.value = '';
    drafts.delete(id);
    resizeInput();
    appendMessage(text, 'user', true, request.id);
    renderSessions();
    updateInputState();
    document.dispatchEvent(new CustomEvent('limilink:human-send', { detail: { sessionId: id, requestId: request.id } }));
    try {
        const response = api('/chat', { ...jsonRequest('POST', { session_id: id, message: text, request_id: request.id }), signal: request.transport.signal });
        if (text !== '!stop') syncSnapshot({ force: true });
        const body = await response;
        if (typeof body.reply !== 'string') throw new Error('The server returned an incomplete Send response.');
        settleSend(id, request, { status: 200, body });
    } catch (error) {
        if (isTracked(id, request) && !request.settled) {
            if (error.status && !error.unconfirmed) settleSend(id, request, { status: error.status, body: { detail: error.message } });
            else {
                request.needsRecovery = true;
                if (!request.accepted) {
                    removePending(id, request);
                    preserveUnconfirmed(id, request);
                }
            }
        }
    } finally {
        if (activePosts.get(request)?.request === request) activePosts.delete(request);
        request.transport = null;
        renderSessions();
        updateInputState();
        if (currentSession === id) await syncSnapshot({ force: true, refreshView: true });
    }
}

function resizeInput() {
    input.style.height = 'auto';
    if (input.value) input.style.height = `${input.scrollHeight}px`;
}

window.addEventListener('storage', event => {
    if (replies?.storageEvent(event.key, event.newValue)) renderSessions();
});
byId('new-session-btn').addEventListener('click', createSession);
byId('refresh-sessions').addEventListener('click', () => refreshSessions());
byId('sidebar-toggle').addEventListener('click', () => setDrawer(true));
byId('sidebar-close').addEventListener('click', () => setDrawer(false));
byId('sidebar-backdrop').addEventListener('click', () => setDrawer(false));
mobile.addEventListener('change', () => setDrawer(false, false));
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pauseUpdates();
    else resumeUpdates();
});
window.addEventListener('pageshow', resumeUpdates);
window.addEventListener('focus', resumeUpdates);
window.addEventListener('online', () => { invalidateSnapshot(); resumeUpdates(); });
byId('restore-unconfirmed').addEventListener('click', () => {
    if (!currentSession) return;
    const records = recoverableForView();
    const saved = records.map(item => item.request.text).join('\n\n');
    if (!saved) return;
    input.value = input.value ? `${input.value}\n\n${saved}` : saved;
    drafts.set(currentSession, input.value);
    dismissRecoverable(records);
    showUnconfirmed();
    const cached = historyCache.get(currentSession);
    if (cached) renderHistory(cached.history);
    renderSessions(); updateInputState(); resizeInput(); input.focus();
});
byId('dismiss-unconfirmed').addEventListener('click', () => {
    dismissRecoverable(recoverableForView());
    showUnconfirmed();
    const cached = historyCache.get(currentSession);
    if (cached) renderHistory(cached.history);
    renderSessions(); updateInputState();
});
sendButton.addEventListener('click', sendMessage);
input.addEventListener('input', () => { drafts.set(currentSession, input.value); resizeInput(); updateInputState(); });
input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !window.matchMedia('(pointer: coarse)').matches && !event.isComposing) {
        event.preventDefault();
        sendMessage();
    }
});
chat.addEventListener('scroll', () => { trackChatScroll(); scheduleReplyRead(); });
new ResizeObserver(() => {
    if (isScrolledToBottom) pinChatToBottom();
    else chatGeometry = measureChatGeometry();
    scheduleReplyRead();
}).observe(chat);
window.visualViewport?.addEventListener('resize', () => {
    if (isScrolledToBottom) pinChatToBottom();
});
document.addEventListener('click', event => {
    scheduleReplyRead();
    if (!event.target.closest('.session-menu')) {
        for (const menu of sessionList.querySelectorAll('details')) menu.open = false;
    }
});
document.addEventListener('keydown', event => {
    scheduleReplyRead();
    if (renameDialog.open || !app.classList.contains('sidebar-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); setDrawer(false); }
    if (event.key === 'Tab') {
        const focusable = [...sidebar.querySelectorAll('button:not(:disabled), summary')].filter(element => element.getClientRects().length);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
});

async function initialize() {
    let readSucceeded = false;
    setDrawer(false, false);
    setSidebarBusy(true);
    try {
        await Promise.all([
            globalThis.LimilinkHistory?.version === 3 ? null : import('/history-view.js?v=3'),
            globalThis.LimilinkReplies ? null : import('/reply-state.js?v=1'),
        ]);
        replies = globalThis.LimilinkReplies.create();
        historyView = globalThis.LimilinkHistory.create(chat, {
            empty: () => emptyConversation('New conversation', 'Start a conversation when you’re ready.'),
            onPrepend: () => { isScrolledToBottom = false; chatGeometry = measureChatGeometry(); scheduleReplyRead(); },
        });
        await readSessions();
        readSucceeded = true;
        const last = savedSession();
        if (sessions.length) await selectSession(sessions.some(session => session.id === last) ? last : sessions[0].id, false);
    } catch (error) { notice(`Could not load sessions: ${error.message}`); }
    finally { setSidebarBusy(false); startPolling(); syncReplyBatch(); }
    if (readSucceeded && !sessions.length) await createSession();
}
initialize();
