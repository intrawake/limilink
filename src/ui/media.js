'use strict';

// Session pins never send chat, change drafts or call a model.
class SessionMediaShelf {
    constructor() {
        this.panel = document.getElementById('session-media');
        this.summary = document.getElementById('media-summary');
        this.status = document.getElementById('media-status');
        this.list = document.getElementById('media-items');
        this.session = null; this.generation = 0; this.revision = null;
        this.request = null; this.cards = new Map(); this.open = false;
        this.toggle = document.getElementById('media-toggle');
        this.close = document.getElementById('media-close');
        this.backdrop = document.getElementById('media-backdrop');
        this.overlay = matchMedia('(max-width: 1180px)');
    }
    updateOverlay() {
        const modal = this.open && this.overlay.matches;
        const activityModal = !document.getElementById('activity-panel').hidden && this.overlay.matches;
        this.backdrop.hidden = !modal;
        document.getElementById('conversation').inert = modal || activityModal || app.classList.contains('sidebar-open');
        document.getElementById('session-sidebar').inert = modal || activityModal || (mobile.matches && !app.classList.contains('sidebar-open'));
        this.panel.setAttribute('role', modal ? 'dialog' : 'complementary');
        if (modal) this.panel.setAttribute('aria-modal', 'true'); else this.panel.removeAttribute('aria-modal');
    }
    setOpen(value, restoreFocus = true) {
        if (value) {
            document.dispatchEvent(new CustomEvent('limilink:panel', {detail: 'pins'}));
            if (this.overlay.matches && typeof setDrawer === 'function') setDrawer(false, false);
        }
        this.open = value; this.panel.hidden = !value;
        this.toggle.setAttribute('aria-expanded', String(value));
        this.updateOverlay();
        if (value) { this.close.focus({preventScroll:true}); void this.refresh(); }
        else if (restoreFocus) this.toggle.focus({preventScroll:true});
    }
    cancel() {
        if (!this.request) return;
        clearTimeout(this.request.timeout); this.request.controller.abort(); this.request = null;
    }
    stop(card) {
        if (card.player) { card.player.pause(); card.player.removeAttribute('src'); card.player.load(); }
        card.node.remove();
    }
    changed() {
        if (this.session === currentSession) { void this.refresh(); return; }
        this.cancel(); ++this.generation;
        for (const card of this.cards.values()) this.stop(card);
        this.cards.clear(); this.list.replaceChildren();
        this.session = currentSession; this.revision = null;
        this.summary.textContent = 'Pins'; this.toggle.textContent = 'Pins';
        this.status.textContent = this.session ? 'Loading pins…' : 'Choose a conversation.';
        void this.refresh();
    }
    valid(item, id) {
        const types = ['image/png','image/jpeg','image/gif','image/webp','audio/mpeg','audio/wav','audio/ogg','audio/mp4','audio/flac'];
        return item && item.version === 1 && item.session_id === id && /^[0-9a-f]{32}$/.test(item.id)
            && types.includes(item.mime) && typeof item.name === 'string' && item.name.length > 0 && [...item.name].length <= 160
            && Number.isInteger(item.size) && item.size > 0 && item.size <= 64 * 1024**2
            && /^[0-9a-f]{64}$/.test(item.sha256) && Number.isFinite(item.created_at) && item.created_at > 0
            && item.url === `/sessions/${encodeURIComponent(id)}/media/${item.id}/content`
            && item.download_url === item.url + '?download=1';
    }
    card(item) {
        const node = document.createElement('figure');
        const title = document.createElement('figcaption');
        title.textContent = `${item.name} · ${(item.size / 1024).toFixed(1)} KiB`;
        let player = null;
        if (item.mime.startsWith('image/')) {
            const link = document.createElement('a');
            link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            const image = document.createElement('img');
            image.src = item.url; image.alt = item.name; image.loading = 'lazy'; image.decoding = 'async';
            image.onerror = () => {
                image.onerror = null; image.alt = `Preview unavailable: ${item.name}`;
                const fallback = document.createElement('small');
                fallback.textContent = 'Image preview unavailable; download the original.'; node.append(fallback);
            };
            link.append(image); node.append(link);
        } else {
            player = document.createElement('audio');
            player.controls = true; player.preload = 'none'; player.src = item.url;
            node.append(player);
            const fallback = document.createElement('small');
            fallback.textContent = 'If playback is unavailable, download the original.';
            node.append(fallback);
        }
        const download = document.createElement('a');
        download.href = item.download_url; download.download = item.name; download.textContent = 'Download';
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'quiet-button'; remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove pin ${item.name}`);
        const card = {node, player, item, remove};
        remove.addEventListener('click', () => { void this.remove(card); });
        const actions = document.createElement('div'); actions.className = 'media-actions';
        actions.append(download, remove);
        node.append(title, actions);
        return card;
    }
    render(items) {
        const sorted = [...items].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
        const ids = new Set(sorted.map(item => item.id));
        // Insert new cards in chronological position; never move/restart an existing audio node.
        for (const [id, card] of this.cards) if (!ids.has(id)) { this.stop(card); this.cards.delete(id); }
        let next = null;
        for (const item of sorted.reverse()) {
            if (!this.cards.has(item.id)) {
                const card = this.card(item); this.cards.set(item.id, card); this.list.insertBefore(card.node, next);
            }
            next = this.cards.get(item.id).node;
        }
        this.summary.textContent = `Pins (${items.length})`;
        this.toggle.textContent = `Pins (${items.length})`;
        this.status.textContent = items.length ? '' : 'No pins yet.';
    }
    async remove(card) {
        const id = this.session, generation = this.generation;
        if (card.remove.disabled || !confirm(`Remove pin “${card.item.name}”? The original source file is not deleted.`)) return;
        const focused = document.activeElement === card.remove;
        card.remove.disabled = true;
        // Invalidate any older listing so it cannot restore the removed card.
        this.cancel();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const owned = () => this.session === id && this.generation === generation;
        try {
            const response = await fetch(`/sessions/${encodeURIComponent(id)}/media/${card.item.id}`, {method:'DELETE',signal:controller.signal});
            if (!response.ok) {
                const data = await response.json();
                throw Error(typeof data.detail === 'string' ? data.detail : 'Remove request failed.');
            }
            if (!owned()) return;
            this.cancel();
            const restoreFocus = document.activeElement === card.remove || (focused && document.activeElement === document.body);
            this.render([...this.cards.values()].filter(other => other !== card).map(other => other.item));
            this.revision = null;
            if (restoreFocus) this.close.focus({preventScroll:true});
            void this.refresh();
        } catch (error) {
            if (owned()) this.status.textContent = `Removal not confirmed: ${controller.signal.aborted ? 'check timed out' : error.message}`;
        } finally {
            clearTimeout(timeout);
            if (owned()) card.remove.disabled = false;
        }
    }
    async refresh() {
        if (!this.session || this.request || document.visibilityState !== 'visible') return;
        const id = this.session, generation = this.generation;
        const controller = new AbortController();
        const request = {controller, timeout:setTimeout(() => controller.abort(), 8000)};
        this.request = request;
        const owned = () => this.request === request && this.session === id && this.generation === generation;
        const valid = () => owned() && !controller.signal.aborted;
        try {
            const query = this.revision ? '?revision=' + encodeURIComponent(this.revision) : '';
            const response = await fetch(`/sessions/${encodeURIComponent(id)}/media${query}`, {cache:'no-store',signal:controller.signal});
            const data = await response.json();
            if (!valid()) return;
            if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : 'Media request failed.');
            if (!/^[0-9a-f]{64}$/.test(data.revision)) throw Error('Incomplete media snapshot.');
            if (data.unchanged === true) {
                if (data.revision !== this.revision) throw Error('Unknown media snapshot.');
                this.status.textContent = this.cards.size ? '' : 'No pins yet.';
                return;
            }
            if (!Array.isArray(data.media) || data.media.length > 128 || new Set(data.media.map(item => item?.id)).size !== data.media.length
                || !data.media.every(item => this.valid(item,id))) throw Error('Incomplete media snapshot.');
            for (const item of data.media) {
                const old = this.cards.get(item.id)?.item;
                if (old && ['name','mime','size','sha256','created_at'].some(key => old[key] !== item[key])) throw Error('Published media changed unexpectedly.');
            }
            this.render(data.media); this.revision = data.revision;
        } catch (error) {
            if (owned()) { this.status.textContent = `Media unavailable: ${controller.signal.aborted ? 'check timed out' : error.message} Existing pins were not cleared.`; }
        } finally {
            clearTimeout(request.timeout);
            if (this.request === request) this.request = null;
        }
    }
}

const sessionMediaShelf = new SessionMediaShelf();
document.addEventListener('limilink:session', () => sessionMediaShelf.changed());
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') sessionMediaShelf.cancel(); else void sessionMediaShelf.refresh();
});
window.addEventListener('focus', () => { void sessionMediaShelf.refresh(); });
sessionMediaShelf.toggle.addEventListener('click', () => sessionMediaShelf.setOpen(!sessionMediaShelf.open));
sessionMediaShelf.close.addEventListener('click', () => sessionMediaShelf.setOpen(false));
sessionMediaShelf.backdrop.addEventListener('click', () => sessionMediaShelf.setOpen(false));
sessionMediaShelf.overlay.addEventListener('change', () => sessionMediaShelf.updateOverlay());
mobile.addEventListener('change', () => sessionMediaShelf.updateOverlay());
document.addEventListener('limilink:panel', event => {
    if (event.detail !== 'pins' && sessionMediaShelf.open) sessionMediaShelf.setOpen(false, false);
});
sessionMediaShelf.panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); sessionMediaShelf.setOpen(false); }
    if (event.key === 'Tab' && sessionMediaShelf.overlay.matches) {
        const controls = [...sessionMediaShelf.panel.querySelectorAll('button, a, audio')].filter(node => node.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
});
setInterval(() => { void sessionMediaShelf.refresh(); }, 3000);
sessionMediaShelf.changed();
