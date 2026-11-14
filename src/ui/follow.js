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
const operations = new Map();
const recoveryRequired = new Map();
const recoveredOperations = new Map();
let recoveryReview = null;
let recoveryPending = false;
const operationChecks = new Map();
const operationQueryCursor = new Map();
const historyCache = new Map();
const reconcileViews = new Set();
let serverBusy = new Set();
let sessions = [];
let currentSession = null;
let navigationVersion = 0;
let snapshotSequence = 0;
let sendGeneration = 0;
let activeSnapshot = null;
let activeReplyCheck = null;
let replyCursor = 0;
let replyReadFrame = null;
let replies = null;
let historyView = null;
let displayedReply = null;
let replyTrackingAvailable = false;
let backgroundOperationCursor = 0;
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
function isWorking(id) { return serverBusy.has(id) || trackedFor(id).some(item => !item.dismissed && item.state === 'running'); }

const MAX_SESSION_SENDS = 64, MAX_TOTAL_SENDS = 512;
const OPERATION_STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted_not_started', 'indeterminate']);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted_not_started']);
const SAVED_OPERATION_PREFIX = 'limilink_operation_v1:';
const DISMISSED_OPERATION_PREFIX = 'limilink_dismissed_operation_v1:';
function savedOperationKey(sessionId, id) { return `${SAVED_OPERATION_PREFIX}${encodeURIComponent(sessionId)}:${id}`; }
function dismissedOperationKey(sessionId, id) { return `${DISMISSED_OPERATION_PREFIX}${encodeURIComponent(sessionId)}:${id}`; }
let storageWarning = '';
let savedRecordsReadable = true;
function trackedFor(id) { return [...(operations.get(id)?.values() || [])]; }
function ownOperation(id, request) {
    let group = operations.get(id);
    if (!group) operations.set(id, group = new Map());
    group.set(request.id, request);
}
function isTracked(id, request) { return operations.get(id)?.get(request.id) === request; }
function pendingFor(id) { return trackedFor(id).filter(item => !item.dismissed && ['staged', 'sending', 'queued', 'running'].includes(item.state)); }
function recoverable(request) { return !request.dismissed && ['unknown', 'unsent', 'refused', 'failed', 'cancelled', 'interrupted_not_started', 'indeterminate'].includes(request.state); }
function hasUnresolvedOperations(id) { return trackedFor(id).some(item => !item.dismissed && ['sending', 'queued', 'running', 'unknown', 'indeterminate'].includes(item.state)); }
function hasSendCapacity(id, text) {
    const extra = text.trim() === '!stop' ? 1 : 0;
    const retained = key => trackedFor(key).filter(item => !item.dismissed && (recoverable(item) || !TERMINAL_STATES.has(item.state))).length;
    return retained(id) < MAX_SESSION_SENDS + extra
        && [...operations.keys()].reduce((count, key) => count + retained(key), 0) < MAX_TOTAL_SENDS + extra;
}

function markDismissed(request) {
    request.dismissed = true;
    request.display = false;
    delete request.text;
    delete request.outcome;
    delete request.detail;
    request.transport?.abort();
}

function savedDismissal(sessionId, id) {
    try { return localStorage.getItem(dismissedOperationKey(sessionId, id)) !== null; }
    catch { return false; } // Existing storage warnings describe unavailable recovery.
}

function persistOperations() {
    if (!savedRecordsReadable) return false;
    try {
        for (const [sessionId, group] of operations) for (const item of group.values()) {
            const key = savedOperationKey(sessionId, item.id);
            const dismissedKey = dismissedOperationKey(sessionId, item.id);
            // A separate, write-once identity marker cannot be overwritten by
            // another tab persisting an older full operation record.
            if (item.dismissed || localStorage.getItem(dismissedKey) !== null) {
                if (localStorage.getItem(dismissedKey) === null) {
                    localStorage.setItem(dismissedKey, JSON.stringify({ sessionId, id: item.id }));
                }
                markDismissed(item);
                localStorage.removeItem(key);
            } else if (recoverable(item) || !TERMINAL_STATES.has(item.state)) {
                const { transport, ...record } = item;
                localStorage.setItem(key, JSON.stringify({ ...record, sessionId }));
            } else localStorage.removeItem(key);
        }
        return true;
    } catch {
        storageWarning = 'Browser storage is unavailable. Save a copy of your message before leaving; reload recovery is unavailable.';
        notice(storageWarning);
        return false;
    }
}

function restoreOperations() {
    try {
        const records = [], dismissals = [];
        // Each identity owns its storage entry: another tab cannot replace a
        // whole-map journal and silently erase this tab's uncertain attempt.
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            const dismissed = key?.startsWith(DISMISSED_OPERATION_PREFIX);
            if (!dismissed && !key?.startsWith(SAVED_OPERATION_PREFIX)) continue;
            const item = JSON.parse(localStorage.getItem(key));
            const identityKey = dismissed ? dismissedOperationKey : savedOperationKey;
            if (!item || typeof item.sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(item.id)
                || identityKey(item.sessionId, item.id) !== key) throw Error('Invalid saved identity');
            (dismissed ? dismissals : records).push(item);
        }
        for (const item of records) {
            if (!item || typeof item.sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(item.id)
                || typeof item.text !== 'string' || ![...OPERATION_STATES, 'staged', 'sending', 'unknown', 'unsent', 'refused'].includes(item.state)
                || !Number.isInteger(item.revision) || item.revision < -1 || typeof item.attempted !== 'boolean') throw Error('Invalid saved operation');
        }
        for (const item of records) {
            if (item.state === 'staged') item.state = 'unsent';
            if (item.state === 'sending') item.state = 'unknown';
            item.transport = null;
            ownOperation(item.sessionId, item);
        }
        // Dismissal always wins, regardless of storage enumeration order or a
        // stale tab's full record. Only its identity belongs in the owner.
        for (const { sessionId, id } of dismissals) {
            ownOperation(sessionId, { id, dismissed: true, display: false });
            localStorage.removeItem(savedOperationKey(sessionId, id));
        }
    } catch {
        savedRecordsReadable = false;
        storageWarning = 'Browser storage is unavailable or saved delivery records could not be read. Check the conversation before resending; no messages were automatically sent.';
        notice(storageWarning);
    }
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

function updateHeading() {
    byId('session-title').textContent = sessionTitle(currentSession);
    byId('session-title').classList.toggle('trashed', isTrashed(currentSession));
    byId('session-directory').textContent = currentSession || '';
    document.title = currentSession ? `${sessionTitle(currentSession)} · Limilink` : 'Limilink Proxy';
}

function updateInputState() {
    showRecovery();
    input.disabled = !currentSession;
    const pending = pendingFor(currentSession);
    const busy = isWorking(currentSession);
    // Snapshot readiness and long-running executions never gate admission.
    sendButton.disabled = false;
    sendButton.title = '';
    const status = deliveryStatus(currentSession);
    byId('typing').hidden = !status && !busy;
    byId('typing').textContent = pending.some(item => ['staged', 'sending'].includes(item.state)) ? 'Sending…'
        : ['Acceptance unknown', 'Effects unknown', 'Running', 'Queued'].includes(status) ? status : busy ? 'Session busy…' : status;

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
    const records = trackedFor(id).filter(item => !item.dismissed);
    if (records.some(item => item.state === 'indeterminate')) return 'Effects unknown';
    if (records.some(item => item.state === 'unknown')) return 'Acceptance unknown';
    if (records.some(item => ['staged', 'sending'].includes(item.state))) return 'Sending…';
    if (records.some(item => item.state === 'running')) return 'Running';
    if (records.some(item => item.state === 'queued')) return 'Queued';
    if (records.some(item => item.state === 'unsent')) return 'Not sent';
    if (records.some(recoverable)) return 'Send failed';
    return '';
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
        row.classList.toggle('busy', isWorking(session.id));
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
        if (isWorking(session.id)) badge('⏳', 'session-working', 'Working');
        if (replies?.isUnread(session.id)) badge('New', 'session-unread', 'Unread reply');
        const delivery = deliveryStatus(session.id);
        if (delivery && delivery !== 'Running') badge(delivery, 'session-delivery', delivery);
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
    for (const [id] of operations) {
        if (id === currentSession || !sessions.some(item => item.id === id)) {
            for (const request of trackedFor(id).filter(recoverable)) records.push({ sessionId: id, request });
        }
    }
    return records;
}

function recoverMissingSessions() {
    const known = new Set(sessions.map(item => item.id));
    for (const [id] of operations) {
        if (known.has(id)) continue;
        for (const request of trackedFor(id)) {
            request.display = false;
            if (request.dismissed || request.state === 'succeeded') {
                if (!request.transport) operations.get(id).delete(request.id);
                continue;
            }
            if (TERMINAL_STATES.has(request.state)) continue;
            request.state = request.attempted ? 'unknown' : 'unsent';
            request.transport?.abort();
        }
    }
    persistOperations();
    showUnconfirmed();
}

function dismissRecoverable(records) {
    for (const { sessionId: id, request } of records) {
        if (!isTracked(id, request) || !recoverable(request)) continue;
        markDismissed(request);
    }
    if (!persistOperations()) {
        storageWarning = 'Browser storage is unavailable. Dismissal could not be saved; discarded messages may reappear after reload.';
        notice(storageWarning);
    }
}

function showUnconfirmed() {
    showRecovery();
    const records = recoverableForView();
    const removed = records.some(item => item.sessionId !== currentSession);
    byId('unconfirmed-send').hidden = !records.length;
    byId('saved-send-status').textContent = removed
        ? 'Messages from removed conversations are saved below. Restoring copies them into this conversation’s draft.'
        : records.some(item => ['unknown', 'indeterminate'].includes(item.request.state))
            ? 'Acceptance or effects are unknown. Check the conversation before resending; effects may already have happened. Later staged messages were not sent.'
            : records.some(item => item.request.state === 'unsent')
                ? 'Not sent. Your staged message is saved below; restore it as a draft to send explicitly.'
                : 'The send failed or was not accepted. Your message is saved below.';
    const details = records.map(({ request }) => request.detail || request.outcome?.body?.detail).filter(Boolean);
    if (details.length) byId('saved-send-status').textContent += ` ${details.join(' · ')}`;
    byId('unconfirmed-text').textContent = records.map(({ sessionId, request }) =>
        sessionId === currentSession ? request.text : `Removed conversation ${sessionId}:\n${request.text}`).join('\n\n---\n\n');
    byId('restore-unconfirmed').disabled = !currentSession;
    byId('restore-unconfirmed').textContent = removed ? 'Restore here as draft' : 'Restore as draft';
}

function showRecovery() {
    const required = recoveryRequired.get(currentSession);
    byId('session-recovery').hidden = !required;
    const review = recoveryReview?.id === currentSession && recoveryReview.navigation === navigationVersion ? recoveryReview : null;
    byId('recovery-status').textContent = review?.message || (required === 'unavailable'
        ? 'Operation status is unavailable. Review recovery to check this session; no work will be retried.'
        : 'This session is paused. Review uncertain work before allowing new messages.');
    byId('review-recovery').disabled = recoveryPending;
    byId('recovery-consent').hidden = !review?.token;
    byId('confirm-recovery').hidden = !review?.token;
    byId('confirm-recovery').disabled = recoveryPending || !byId('acknowledge-recovery').checked;
}

async function recoveryCall(id, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try { return await api(`/sessions/${encodeURIComponent(id)}/recovery`, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
}

async function reviewRecovery() {
    if (!currentSession || recoveryPending) return;
    const review = { id: currentSession, navigation: navigationVersion, message: 'Checking writer ownership and recovery evidence…' };
    recoveryReview = review; recoveryPending = true;
    byId('acknowledge-recovery').checked = false;
    showRecovery();
    try {
        const data = await recoveryCall(review.id);
        if (recoveryReview !== review || currentSession !== review.id || navigationVersion !== review.navigation) return;
        if (typeof data.recovery_required !== 'boolean') throw Error('Incomplete recovery state.');
        recoveryRequired.set(review.id, data.recovery_required);
        if (!data.recovery_required) { notice('Session accepts new messages. Past uncertain effects remain unknown; nothing was retried.'); return; }
        if (!/^[0-9a-f]{64}$/.test(data.token) || !Array.isArray(data.uncertain_ids) || !data.configuration) throw Error('Incomplete recovery review.');
        review.token = data.token;
        review.requestId = newSendId();
        review.message = `${data.warning} Agent: ${data.configuration.agent}; model: ${data.configuration.model}; reasoning: ${data.configuration.reasoning_effort || 'default'}. Uncertain operation IDs: ${data.uncertain_ids.join(', ') || 'none recorded'}. Check the conversation and any external effects before confirming.`;
    } catch (error) {
        if (recoveryReview === review) { review.token = null; review.message = `Recovery unavailable: ${error.message}`; }
    } finally { recoveryPending = false; showRecovery(); }
}

async function confirmRecovery() {
    const review = recoveryReview;
    if (recoveryPending || !review?.token || !byId('acknowledge-recovery').checked
        || review.id !== currentSession || review.navigation !== navigationVersion) return;
    recoveryPending = true;
    // Consume this local review BEFORE transport. Lost responses require a new
    // explicit review, never an automatic POST retry or staged-message release.
    const body = { request_id: review.requestId, token: review.token, acknowledge_possible_effects: true };
    review.token = null;
    showRecovery();
    try {
        const data = await recoveryCall(review.id, jsonRequest('POST', body));
        if (recoveryReview !== review || currentSession !== review.id || navigationVersion !== review.navigation) return;
        if (typeof data.recovery_required !== 'boolean' || data.confirmation?.acknowledged !== true) throw Error('Incomplete recovery confirmation.');
        recoveryRequired.set(review.id, data.recovery_required);
        notice(data.recovery_required ? 'Acknowledgement recorded, but this session is still paused. Review again.'
            : 'Session accepts new messages. Past effects remain unknown. Interrupted messages were not resent.');
        updateInputState();
        if (!data.recovery_required) await syncOperations(review.id); // Observe coverage, never pump/resend.
    } catch (error) {
        if (recoveryReview === review) review.message = `Recovery was not confirmed: ${error.message}. Review again before continuing. Nothing will be resent automatically.`;
    } finally { recoveryPending = false; byId('acknowledge-recovery').checked = false; showRecovery(); }
}

function readRecoveryAcknowledgements(id, data) {
    const acknowledged = Array.isArray(data.recovery_acknowledged) ? data.recovery_acknowledged : [];
    for (const op of data.operations) if (op.state === 'indeterminate') {
        const key = `${id}:${op.id}`;
        if (acknowledged.some(item => item.id === op.id && item.revision === op.revision)) recoveredOperations.set(key, op.revision);
        else recoveredOperations.delete(key);
    }
    // This metadata permits only a NEW explicit click; it never pumps staged work.
}

function blocksAdmission(id, item) {
    return item.state === 'unknown' || (item.state === 'indeterminate'
        && recoveredOperations.get(`${id}:${item.id}`) !== item.revision);
}

function holdSuccessors(id) {
    for (const item of trackedFor(id)) if (item.state === 'staged' && item.text.trim() !== '!stop') {
        item.state = 'unsent';
        item.display = false;
    }
}

function markUnknown(id, request) {
    if (!isTracked(id, request) || request.dismissed || request.revision >= 0) return;
    request.state = 'unknown';
    holdSuccessors(id);
    persistOperations();
    showUnconfirmed();
}

function validateOperation(id, op) {
    if (!op || op.session_id !== id || !/^[0-9a-f]{32}$/.test(op.id)
        || !Number.isInteger(op.sequence) || op.sequence < 0 || !Number.isInteger(op.revision) || op.revision < 0
        || !OPERATION_STATES.has(op.state) || typeof op.message !== 'string'
        || !(op.execution_id === null || typeof op.execution_id === 'string')) throw Error('Incomplete operation state.');
    const outcome = op.outcome;
    if (outcome !== null && (!Number.isInteger(outcome?.status) || outcome.status < 100 || outcome.status > 599
        || !outcome.body || !(typeof outcome.body.reply === 'string' || typeof outcome.body.detail === 'string'))) {
        throw Error('Incomplete operation outcome.');
    }
    if (op.state === 'succeeded' && (outcome?.status !== 200 || typeof outcome.body.reply !== 'string')
        || op.state === 'failed' && (!(outcome?.status >= 400) || typeof outcome.body.detail !== 'string')) {
        throw Error('Incomplete operation outcome.');
    }
}

function applyOperation(id, op) {
    validateOperation(id, op);
    let item = operations.get(id)?.get(op.id);
    if (savedDismissal(id, op.id)) {
        if (!item) ownOperation(id, item = { id: op.id });
        const changed = !item.dismissed;
        markDismissed(item);
        showUnconfirmed();
        return changed;
    }
    if (item?.dismissed || (item && (op.message !== item.text || op.revision <= item.revision))) return false;
    if (!item) {
        item = { id: op.id, text: op.message, display: false, revision: -1, attempted: true };
        ownOperation(id, item);
    }
    item.revision = op.revision;
    item.sequence = op.sequence;
    item.state = op.state;
    item.execution_id = op.execution_id;
    item.outcome = op.outcome;
    item.attempted = true;
    if (recoverable(item)) {
        item.display = false;
        if (op.state === 'indeterminate') holdSuccessors(id);
    }
    reconcileViews.add(id);
    // Exact GET acceptance can settle an otherwise lost admission response.
    // Aborting this browser exchange never cancels the server-owned operation.
    item.transport?.abort();
    persistOperations();
    showUnconfirmed();
    return true;
}

function renderHistory(history, followBottom = isScrolledToBottom, finishedBefore = new Set()) {
    const scrollTop = chat.scrollTop;
    const recorded = globalThis.LimilinkHistory.canonicalSendIds(history);
    for (const item of trackedFor(currentSession)) {
        // Completion alone is not canonical history coverage. A subsequent
        // snapshot or exact user ID retires only this optimistic identity.
        if (recorded.has(item.id) || (TERMINAL_STATES.has(item.state) && finishedBefore.has(item.id))) item.display = false;
    }
    const optimistic = trackedFor(currentSession).filter(item => item.display && !item.dismissed && !recoverable(item));
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
    const finishedBefore = new Set(trackedFor(id).filter(item => TERMINAL_STATES.has(item.state)).map(item => item.id));
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
            const data = await api(`/sessions/${encodeURIComponent(id)}/snapshot?${query}`, { signal: controller.signal });
            if (!stillCurrent()) return false;
            const history = data.history ?? cached?.history;
            if (typeof data.revision !== 'string' || typeof data.busy !== 'boolean' || !Array.isArray(history)) {
                throw new Error('The server returned an incomplete conversation state.');
            }
            const changed = !cached || cached.revision !== data.revision;
            const reply = canonicalReply(data.reply, history);
            replyTrackingAvailable = !!reply;
            const unreadChanged = replies?.observe(id, reply) || false;
            historyCache.set(id, { revision: data.revision, history, reply });
            const nextBusy = new Set(data.busy_sessions || []);
            if (data.busy) nextBusy.add(id);
            const busyChanged = nextBusy.size !== serverBusy.size || [...nextBusy].some(key => !serverBusy.has(key));
            serverBusy = nextBusy;
            if (changed || initial || refreshView || reconcileViews.has(id) || finishedBefore.size) renderHistory(history, initial || isScrolledToBottom, finishedBefore);
            reconcileViews.delete(id);
            historyReady = true;
            connected = true;
            connectionStatus();
            displayedReply = reply ? { ...reply, id } : null;
            scheduleReplyRead();
            if (busyChanged || unreadChanged) renderSessions();
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

function invalidateOperationChecks() {
    for (const check of operationChecks.values()) {
        clearTimeout(check.timeout);
        check.controller.abort();
    }
    operationChecks.clear();
}

async function syncOperations(id = currentSession) {
    if (!id || document.visibilityState !== 'visible') return false;
    if (operationChecks.has(id)) return operationChecks.get(id).promise;
    const controller = new AbortController(), navigation = navigationVersion;
    const request = { controller, timeout: setTimeout(() => controller.abort(), 8000), promise: null };
    operationChecks.set(id, request);
    const valid = () => operationChecks.get(id) === request && !controller.signal.aborted
        && navigation === navigationVersion && sessions.some(item => item.id === id);
    request.promise = (async () => {
        try {
            const base = `/sessions/${encodeURIComponent(id)}/operations`;
            const data = await api(base, { signal: controller.signal });
            if (!valid()) return false;
            if (!Array.isArray(data.operations)) throw Error('Incomplete operations response.');
            // Validate the entire response before touching the owner, including
            // session identity. A stale revision never rolls back a newer POST.
            data.operations.forEach(op => validateOperation(id, op));
            readRecoveryAcknowledgements(id, data);
            if (typeof data.recovery_required === 'boolean') recoveryRequired.set(id, data.recovery_required);
            showRecovery();
            let changed = false;
            for (const op of data.operations) changed = applyOperation(id, op) || changed;
            const returned = new Set(data.operations.map(op => op.id));
            const missing = trackedFor(id).filter(item => item.attempted && !item.dismissed
                && ['sending', 'unknown', 'queued', 'running', 'indeterminate'].includes(item.state) && !returned.has(item.id));
            if (missing.length) {
                const start = (operationQueryCursor.get(id) || 0) % missing.length;
                const batch = Array.from({ length: Math.min(64, missing.length) }, (_, index) => missing[(start + index) % missing.length]);
                operationQueryCursor.set(id, (start + batch.length) % missing.length);
                const query = new URLSearchParams();
                batch.forEach(item => query.append('request_id', item.id));
                const exact = await api(`${base}?${query}`, { signal: controller.signal });
                if (!valid()) return false;
                if (!Array.isArray(exact.operations)) throw Error('Incomplete operations response.');
                exact.operations.forEach(op => validateOperation(id, op));
                readRecoveryAcknowledgements(id, exact);
                const wanted = new Set(batch.map(item => item.id));
                for (const op of exact.operations) if (wanted.has(op.id)) changed = applyOperation(id, op) || changed;
                // Missing is not proof of refusal: a POST may still be in flight.
                // Never resend it, or automatically release held successors.
            }
            // Do not retain an unbounded success history. Recovery text and
            // durable dismissal tombstones remain owned so server rediscovery
            // cannot revive text the human explicitly restored or dismissed.
            for (const item of trackedFor(id)) {
                if (item.state === 'succeeded' && !item.display && !item.transport && !returned.has(item.id)) {
                    operations.get(id).delete(item.id);
                }
            }
            if (changed) {
                renderSessions(); updateInputState();
                if (id === currentSession) {
                    const cached = historyCache.get(id);
                    if (cached) renderHistory(cached.history);
                }
            }
            return true;
        } catch {
            recoveryRequired.set(id, recoveryRequired.get(id) || 'unavailable');
            showRecovery();
            return false; // No usable state or automatic recovery is inferred.
        }
        finally {
            clearTimeout(request.timeout);
            if (operationChecks.get(id) === request) operationChecks.delete(id);
        }
    })();
    return request.promise;
}

async function syncBackgroundOperations() {
    const ids = sessions.map(session => session.id).filter(id => id !== currentSession && hasUnresolvedOperations(id));
    if (!ids.length) return false;
    return syncOperations(ids[backgroundOperationCursor++ % ids.length]);
}

function pollUpdates(options = {}) {
    syncSnapshot(options);
    syncOperations();
    syncBackgroundOperations();
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
    invalidateOperationChecks();
    invalidateReplyCheck();
    cancelReplyRead();
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
    invalidateOperationChecks();
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
    await Promise.all([loadHistory(id), syncOperations(id)]);
}

function newSendId() {
    const bytes = new Uint8Array(16);
    // Supported on plain HTTP too; crypto.randomUUID is secure-context-only.
    crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

async function admitOperation(id, request) {
    request.state = 'sending';
    request.attempted = true;
    request.transport = new AbortController();
    // Persist identity and exact text BEFORE fetch. Saved staging is never an outbox.
    persistOperations();
    const timeout = setTimeout(() => request.transport?.abort(), 8000);
    try {
        if (request.dismissed) return;
        const data = await api(`/sessions/${encodeURIComponent(id)}/operations`, {
            ...jsonRequest('POST', { message: request.text, request_id: request.id }), signal: request.transport.signal,
        });
        if (!isTracked(id, request) || request.dismissed) return;
        if (data.operation?.id !== request.id) throw Error('Mismatched operation admission.');
        validateOperation(id, data.operation);
        if (data.operation.message !== request.text) throw Error('Mismatched operation message.');
        applyOperation(id, data.operation);
    } catch (error) {
        if (isTracked(id, request) && !request.dismissed && request.revision < 0) {
            if (error.status >= 400 && error.status < 500 && !error.unconfirmed) {
                request.state = 'refused';
                request.display = false;
                request.detail = error.message;
                notice(`Not accepted in “${sessionTitle(id)}”: ${error.message}. Your message is saved below.`);
            } else markUnknown(id, request);
        }
    } finally {
        clearTimeout(timeout);
        request.transport = null;
        persistOperations();
        showUnconfirmed(); renderSessions(); updateInputState();
        pumpAdmissions(id);
        if (currentSession === id) syncSnapshot({ force: true, refreshView: true });
    }
}

function pumpAdmissions(id) {
    const records = trackedFor(id).filter(item => !item.dismissed);
    if (records.some(item => item.transport)) return;
    const blocked = records.some(item => blocksAdmission(id, item));
    const next = records.find(item => item.state === 'staged' && (!blocked || item.text.trim() === '!stop'));
    if (next) void admitOperation(id, next);
}

async function sendMessage() {
    const text = input.value;
    if (!currentSession) { notice('Choose a conversation first. Your draft is unchanged.'); return; }
    if (!text.trim()) { notice('Write a message first.'); return; }
    if (!hasSendCapacity(currentSession, text)) {
        notice('Not sent: local saved-message limit reached. Restore or dismiss saved messages. Your draft is unchanged.');
        return;
    }
    const id = currentSession;
    const stop = text.trim() === '!stop';
    if (!stop && trackedFor(id).some(item => !item.dismissed && blocksAdmission(id, item))) {
        notice('Not sent: an earlier acceptance is unknown. Check it and explicitly restore or dismiss saved messages first. Your draft is unchanged.');
        return;
    }
    let requestId;
    try {
        requestId = newSendId();
        if (operations.get(id)?.has(requestId) || savedDismissal(id, requestId)) throw Error('Duplicate operation identity');
    } catch { notice('This browser could not safely identify the send. Your draft has been kept.'); return; }
    notice(storageWarning);
    const request = { id: requestId, text, state: 'staged', revision: -1, attempted: false, display: true, transport: null };
    ++sendGeneration;
    invalidateSnapshot();
    ownOperation(id, request);
    persistOperations();
    input.value = '';
    drafts.delete(id);
    resizeInput();
    appendMessage(text, 'user', true, request.id);
    renderSessions(); updateInputState();
    document.dispatchEvent(new CustomEvent('limilink:human-send', { detail: { sessionId: id, requestId: request.id } }));
    pumpAdmissions(id);
    return request;
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
byId('review-recovery').addEventListener('click', reviewRecovery);
byId('acknowledge-recovery').addEventListener('change', showRecovery);
byId('confirm-recovery').addEventListener('click', confirmRecovery);

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
            globalThis.LimilinkHistory?.version === 4 ? null : import('/history-view.js?v=4'),
            globalThis.LimilinkReplies ? null : import('/reply-state.js?v=1'),
        ]);
        replies = globalThis.LimilinkReplies.create();
        historyView = globalThis.LimilinkHistory.create(chat, {
            empty: () => emptyConversation('New conversation', 'Start a conversation when you’re ready.'),
            onPrepend: () => { isScrolledToBottom = false; chatGeometry = measureChatGeometry(); scheduleReplyRead(); },
        });
        restoreOperations();
        await readSessions();
        readSucceeded = true;
        const last = savedSession();
        if (sessions.length) await selectSession(sessions.some(session => session.id === last) ? last : sessions[0].id, false);
    } catch (error) { notice(`Could not load sessions: ${error.message}`); }
    finally { setSidebarBusy(false); startPolling(); syncReplyBatch(); }
    if (readSucceeded && !sessions.length) await createSession();
}
initialize();
