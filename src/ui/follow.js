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

function updateHeading() {
    byId('session-title').textContent = sessionTitle(currentSession);
    byId('session-title').classList.toggle('trashed', isTrashed(currentSession));
    byId('session-directory').textContent = currentSession || '';
    document.title = currentSession ? `${sessionTitle(currentSession)} · Limilink` : 'Limilink Proxy';
}

function updateInputState() {
    input.disabled = !currentSession || isTrashed(currentSession);
    const pending = pendingSends.get(currentSession);
    const busy = serverBusy.has(currentSession);
    sendButton.disabled = input.disabled || !historyReady || !connected || checkingSnapshot || busy || !!pending;
    byId('typing').hidden = !connected || (!busy && !pending);
    byId('typing').textContent = busy ? 'Thinking…' : pending?.observedBusy ? 'Waiting for confirmation…' : 'Sending…';
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
    const pending = pendingSends.get(id);
    const saved = unconfirmedSends.get(id) || [];
    if (saved.some(item => !item.failed)) return 'Unconfirmed';
    if (pending && !serverBusy.has(id)) return pending.observedBusy || pending.needsRecovery ? 'Confirming…' : 'Sending…';
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
        row.className = 'session-row';
        row.dataset.sessionId = session.id;
        row.classList.toggle('selected', session.id === currentSession);
        row.classList.toggle('busy', serverBusy.has(session.id));
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
        const delivery = deliveryStatus(session.id);
        if (delivery) {
            const status = document.createElement('span');
            status.className = 'session-delivery';
            status.textContent = delivery;
            link.append(status);
        }
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

function appendMessage(content, sender, scroll = true) {
    chat.querySelector('.empty-conversation')?.remove();
    const message = document.createElement('div');
    message.className = `message ${sender === 'user' ? 'user' : 'bot'}`;
    const parts = String(content).split(/```([\s\S]*?)```/g);
    parts.forEach((part, index) => {
        if (index % 2) {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = part;
            pre.append(code);
            message.append(pre);
        } else { message.append(document.createTextNode(part)); }
    });
    chat.append(message);
    if (scroll) pinChatToBottom();
}

function connectionStatus(message = '') {
    byId('connection-status').textContent = message;
    byId('connection-status').hidden = !message;
}

function showUnconfirmed() {
    const saved = unconfirmedSends.get(currentSession) || [];
    byId('unconfirmed-send').hidden = !saved.length;
    byId('saved-send-status').textContent = saved.some(item => !item.failed)
        ? 'Delivery couldn’t be confirmed. Check the conversation before resending.'
        : 'The send failed. Your message is saved below.';
    byId('unconfirmed-text').textContent = saved.map(item => item.text).join('\n\n---\n\n');
}

function preserveUnconfirmed(id, request) {
    const saved = unconfirmedSends.get(id) || [];
    if (!saved.includes(request)) saved.push(request);
    unconfirmedSends.set(id, saved);
    if (id === currentSession) showUnconfirmed();
}

function forgetSavedSend(id, request) {
    const saved = (unconfirmedSends.get(id) || []).filter(item => item !== request);
    if (saved.length) unconfirmedSends.set(id, saved);
    else unconfirmedSends.delete(id);
    if (id === currentSession) showUnconfirmed();
}

function receiptCandidate(id) {
    const pending = pendingSends.get(id);
    const saved = (unconfirmedSends.get(id) || []).filter(item => !item.failed);
    return { pending, saved, tracked: pending || saved[(savedReceiptCursor.get(id) || 0) % saved.length] };
}

function reconcileReceipt(id, { pending, saved, tracked }, data, recover = false) {
    if (!tracked || !(pendingSends.get(id) === tracked || (unconfirmedSends.get(id) || []).includes(tracked))) return false;
    const receipt = data.send?.id === tracked.id ? data.send : null;
    if (receipt?.state === 'complete' && (!Number.isInteger(receipt.outcome?.status)
        || !receipt.outcome?.body || (receipt.outcome.status === 200
            ? typeof receipt.outcome.body.reply !== 'string'
            : receipt.outcome.status < 400 || receipt.outcome.status > 599 || !('detail' in receipt.outcome.body)))) {
        throw new Error('The server returned an incomplete Send receipt.');
    }
    if (pendingSends.get(id) === pending && data.busy && pending) pending.observedBusy = true;
    let reconciled = false;
    if (receipt?.state === 'complete') {
        if (pendingSends.get(id) === tracked) pendingSends.delete(id);
        if (receipt.outcome.status === 200) forgetSavedSend(id, tracked);
        else if (!tracked.failed) saveFailedSend(id, tracked, receipt.outcome.body.detail);
        reconciled = true;
    } else if (receipt?.state === 'running') {
        // A live owner has this exact Send, even if its HTTP reply was lost.
        reconciled = !tracked.needsRecovery || !pendingSends.has(id) || (unconfirmedSends.get(id) || []).includes(tracked);
        tracked.needsRecovery = true;
        forgetSavedSend(id, tracked);
        if (!pendingSends.has(id)) pendingSends.set(id, tracked);
    } else if (pending && pendingSends.get(id) === pending
        && (recover || pending.needsRecovery || receipt?.state === 'indeterminate')) {
        // Idle is not an acknowledgement. Keep genuinely uncertain text.
        pendingSends.delete(id);
        preserveUnconfirmed(id, pending);
        reconciled = true;
    }
    if (!pending && saved.length) {
        // A permanently missing receipt must not starve later saved sends.
        savedReceiptCursor.set(id, ((savedReceiptCursor.get(id) || 0) + 1) % saved.length);
    }
    return reconciled;
}

function saveFailedSend(id, request, detail) {
    request.failed = true;
    preserveUnconfirmed(id, request);
    notice(`Message in “${sessionTitle(id)}” failed: ${typeof detail === 'string' ? detail : 'The request failed.'}`);
}

function renderHistory(history, followBottom = isScrolledToBottom) {
    const scrollTop = chat.scrollTop;
    chat.replaceChildren();
    if (history.length) {
        for (const item of history) appendMessage(item.content, item.role, false);
    } else {
        emptyConversation('New conversation', 'Start a conversation when you’re ready.');
    }
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
    const { pending, tracked } = candidate;
    if (recover && pending) pending.needsRecovery = true;
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
            historyCache.set(id, { revision: data.revision, history });
            const nextBusy = new Set(data.busy_sessions || []);
            if (data.busy) nextBusy.add(id);
            const busyChanged = nextBusy.size !== serverBusy.size || [...nextBusy].some(key => !serverBusy.has(key));
            serverBusy = nextBusy;
            const reconciled = reconcileReceipt(id, candidate, data, recover);
            if (changed || initial || reconciled || refreshView || reconcileViews.has(id)) renderHistory(history, initial || isScrolledToBottom);
            reconcileViews.delete(id);
            historyReady = true;
            connected = true;
            connectionStatus();
            if (busyChanged || reconciled) renderSessions();
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
    if (cached) renderHistory(cached.history, true);
    else emptyConversation('Loading conversation…');
    chat.setAttribute('aria-busy', 'true');
    updateInputState();
    return syncSnapshot({ initial: true, force: true });
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
    const ids = sessions.map(session => session.id).filter(id => id !== currentSession && receiptCandidate(id).tracked);
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
            const relevant = pendingSends.get(id) === candidate.tracked || (unconfirmedSends.get(id) || []).includes(candidate.tracked);
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
    for (const request of pendingSends.values()) request.needsRecovery = true;
}

function resumeUpdates() {
    if (document.visibilityState !== 'visible') return;
    startPolling();
    pollUpdates({ force: true, recover: true });
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
    if (!text || sendButton.disabled) return;
    const id = currentSession;
    let requestId;
    try { requestId = newSendId(); }
    catch { notice('This browser could not safely identify the send. Your draft has been kept.'); return; }
    const request = { token: Symbol('send'), id: requestId, text, needsRecovery: false, observedBusy: false };
    ++sendGeneration;
    invalidateSnapshot();
    pendingSends.set(id, request);
    input.value = '';
    drafts.delete(id);
    resizeInput();
    appendMessage(text, 'user');
    renderSessions();
    updateInputState();
    let failure = null;
    try {
        const response = api('/chat', jsonRequest('POST', { session_id: id, message: text, request_id: request.id }));
        syncSnapshot({ force: true });
        await response;
    } catch (error) { failure = error; }
    // A resumed page may have reconciled this request and sent another message.
    // Neither a delayed response nor its error may clear that newer request.
    if (pendingSends.get(id) !== request) {
        if (!failure && !request.failed) forgetSavedSend(id, request);
        else if (failure?.status && !failure.unconfirmed) {
            const saved = unconfirmedSends.get(id) || [];
            if (saved.includes(request)) {
                request.failed = true;
                if (id === currentSession) showUnconfirmed();
            }
        }
        renderSessions();
        return;
    }
    reconcileViews.add(id);
    if (failure && (!failure.status || failure.unconfirmed)) {
        // Check the receipt before warning: a broken transport is not a lost Send.
        request.needsRecovery = true;
    } else {
        pendingSends.delete(id);
        forgetSavedSend(id, request);
        if (failure) saveFailedSend(id, request, failure.message);
    }
    renderSessions();
    updateInputState();
    if (currentSession === id) await syncSnapshot({ force: true, refreshView: true });
}

function resizeInput() {
    input.style.height = 'auto';
    if (input.value) input.style.height = `${input.scrollHeight}px`;
}

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
    const saved = (unconfirmedSends.get(currentSession) || []).map(item => item.text).join('\n\n');
    if (!saved) return;
    input.value = input.value ? `${input.value}\n\n${saved}` : saved;
    drafts.set(currentSession, input.value);
    unconfirmedSends.delete(currentSession);
    showUnconfirmed();
    resizeInput();
    input.focus();
});
byId('dismiss-unconfirmed').addEventListener('click', () => {
    unconfirmedSends.delete(currentSession);
    showUnconfirmed();
});
sendButton.addEventListener('click', sendMessage);
input.addEventListener('input', () => { drafts.set(currentSession, input.value); resizeInput(); });
input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !window.matchMedia('(pointer: coarse)').matches && !event.isComposing) {
        event.preventDefault();
        sendMessage();
    }
});
chat.addEventListener('scroll', trackChatScroll);
new ResizeObserver(() => {
    if (isScrolledToBottom) pinChatToBottom();
    else chatGeometry = measureChatGeometry();
}).observe(chat);
window.visualViewport?.addEventListener('resize', () => {
    if (isScrolledToBottom) pinChatToBottom();
});
document.addEventListener('click', event => {
    if (!event.target.closest('.session-menu')) {
        for (const menu of sessionList.querySelectorAll('details')) menu.open = false;
    }
});
document.addEventListener('keydown', event => {
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
    setDrawer(false, false);
    setSidebarBusy(true);
    try {
        await readSessions();
        const last = savedSession();
        if (sessions.length) await selectSession(sessions.some(session => session.id === last) ? last : sessions[0].id, false);
    } catch (error) { notice(`Could not load sessions: ${error.message}`); }
    finally { setSidebarBusy(false); startPolling(); }
    if (!sessions.length && !byId('notice').textContent) await createSession();
}
initialize();
