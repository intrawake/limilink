'use strict';

// A read-only observer. This module never changes Send readiness or chat history.
(() => {
    const panel = document.getElementById('activity-panel');
    const toggle = document.getElementById('activity-toggle');
    const close = document.getElementById('activity-close');
    const backdrop = document.getElementById('activity-backdrop');
    const graph = document.getElementById('activity-graph');
    const status = document.getElementById('activity-status');
    const detail = document.getElementById('activity-detail');
    const eventList = document.querySelector('#activity-events ol');
    const overlay = matchMedia('(max-width: 1180px)');
    const cache = new Map();
    let open = false, selected = 'parent', session = null, request = null, timer = null, snapshot = null;
    let live = false, serverOffset = 0, selectedEdge = null;
    const el = (tag, text, cls) => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    };
    const number = value => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const age = value => Math.max(0, Math.floor((Date.now() + serverOffset - value) / 1000));
    const contextText = context => {
        if (!context) return 'Context not reported';
        const used = context.tokens === null ? 'unknown' : `~${number(context.tokens)}`;
        return `${context.basis === 'last-input' ? 'Last input' : 'Context'} ${used} / ${number(context.contextWindow)}${context.percent === null ? '' : ` · ${Math.round(context.percent)}%`}`;
    };
    const nodeContextText = node => node.context ? contextText(node.context)
        : typeof node.lastInputTokens === 'number' ? `Last input ~${number(node.lastInputTokens)} · capacity unknown` : 'Context not reported';
    function cancel() { request?.abort(); request = null; }
    function updateOverlay() {
        const modal = open && overlay.matches;
        backdrop.hidden = !modal;
        document.getElementById('conversation').inert = modal || app.classList.contains('sidebar-open');
        document.getElementById('session-sidebar').inert = modal || (mobile.matches && !app.classList.contains('sidebar-open'));
        panel.setAttribute('role', modal ? 'dialog' : 'complementary');
        if (modal) panel.setAttribute('aria-modal', 'true');
        else panel.removeAttribute('aria-modal');
    }
    function setOpen(value, restoreFocus = true) {
        open = value;
        panel.hidden = !value;
        toggle.setAttribute('aria-expanded', String(value));
        if (timer !== null) clearInterval(timer);
        timer = null;
        cancel();
        if (value) {
            if (overlay.matches && typeof setDrawer === 'function') setDrawer(false, false);
            updateOverlay();
            close.focus({ preventScroll: true });
            changedSession();
            timer = setInterval(poll, 2000);
        } else {
            updateOverlay();
            if (restoreFocus) toggle.focus({ preventScroll: true });
        }
    }
    function changedSession() {
        if (session === currentSession) { if (open) poll(); return; }
        cancel();
        session = currentSession;
        selected = 'parent'; selectedEdge = null;
        graph.replaceChildren(); eventList.replaceChildren(); detail.hidden = true;
        snapshot = cache.get(session)?.activity || null;
        live = false;
        if (snapshot) render();
        status.textContent = session ? 'Checking activity…' : 'Choose a conversation.';
        if (open) poll();
    }
    async function poll() {
        if (!open || !session || document.visibilityState !== 'visible' || request) return;
        const id = session, controller = new AbortController();
        request = controller;
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const previous = cache.get(id);
            const query = previous ? `?revision=${encodeURIComponent(previous.revision)}` : '';
            const response = await fetch(`/sessions/${encodeURIComponent(id)}/activity${query}`, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error(response.status === 404 ? 'Activity is not available on this server yet.' : 'Could not refresh activity.');
            const data = await response.json();
            if (session !== id || !open || request !== controller) return;
            serverOffset = typeof data.serverTime === 'number' ? data.serverTime - Date.now() : 0;
            live = data.live === true;
            if (!data.available) {
                snapshot = null; cache.delete(id);
                graph.replaceChildren(); eventList.replaceChildren(); detail.hidden = true;
                status.textContent = data.reason || 'No activity recorded yet.';
                status.classList.remove('activity-stale');
                return;
            }
            snapshot = data.activity || previous?.activity;
            if (!snapshot || !Array.isArray(snapshot.nodes)) throw new Error('Activity state is incomplete.');
            cache.set(id, { revision: data.revision, activity: snapshot });
            render();
        } catch (error) {
            if (session !== id || !open || request !== controller) return;
            status.textContent = `${error.name === 'AbortError' ? 'Activity refresh timed out.' : error.message}${snapshot ? ' Showing last observation.' : ''}`;
            status.classList.add('activity-stale');
        } finally {
            clearTimeout(timeout);
            if (request === controller) request = null;
        }
    }
    function drawEdges(positions, width, height) {
        graph.querySelector('svg')?.remove();
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('aria-hidden', 'true');
        const defs = document.createElementNS(ns, 'defs');
        const marker = document.createElementNS(ns, 'marker');
        for (const [name, value] of Object.entries({ id: 'activity-arrow', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' })) marker.setAttribute(name, value);
        const triangle = document.createElementNS(ns, 'path');
        triangle.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z'); triangle.setAttribute('fill', '#aaa0b2');
        marker.append(triangle); defs.append(marker); svg.append(defs);
        for (const edge of snapshot.edges || []) {
            const from = positions.get(edge.source), to = positions.get(edge.target);
            if (!from || !to || from === to) continue;
            const path = document.createElementNS(ns, 'path');
            const delegation = edge.kind === 'delegation';
            // Solid ancestry on the left, observed communication on the right.
            const d = delegation
                ? `M ${from.x + 8} ${from.y + 108} V ${to.y + 54} H ${to.x - 3}`
                : `M ${width - 17} ${from.y + 70} H ${width - 3} V ${to.y + 70} H ${width - 17}`;
            path.setAttribute('d', d);
            path.setAttribute('class', `activity-edge${delegation ? '' : ' communication'}`);
            path.setAttribute('marker-end', 'url(#activity-arrow)');
            svg.append(path);
        }
        graph.prepend(svg);
    }
    function render() {
        const stale = !live || age(snapshot.updatedAt) > 10;
        status.classList.toggle('activity-stale', live && stale);
        status.textContent = `${live ? stale ? 'Last observation' : 'Live' : 'Last run'} · ${time(snapshot.updatedAt)}${live && stale ? ` · ${age(snapshot.updatedAt)}s ago` : ''}`;
        const nodes = [...snapshot.nodes].sort((a, b) => (b.id === 'parent') - (a.id === 'parent'));
        const root = nodes.find(node => node.id === 'parent');
        if (root) {
            root.context = snapshot.context;
            root.model = snapshot.model;
            root.currentTool = snapshot.tools?.map(tool => tool.name).join(', ') || null;
        }
        const lookup = new Map(nodes.map(node => [node.id, node]));
        const depth = node => {
            const visited = new Set([node.id]); let count = 0;
            while (node.parentId && lookup.has(node.parentId) && count < 5) {
                if (visited.has(node.parentId)) return 0;
                visited.add(node.parentId); node = lookup.get(node.parentId); count++;
            }
            return count;
        };
        const positions = new Map();
        const width = Math.max(graph.clientWidth, 270), height = nodes.length * 138;
        graph.style.height = `${height}px`;
        const existing = new Map([...graph.querySelectorAll('.activity-node')].map(node => [node.dataset.id, node]));
        nodes.forEach((node, index) => {
            const position = { x: 12 + depth(node) * 18, y: index * 138 };
            positions.set(node.id, position);
            let card = existing.get(node.id);
            if (!card) {
                card = el('button', undefined, 'activity-node'); card.type = 'button'; card.dataset.id = node.id;
                card.addEventListener('click', () => { selected = node.id; selectedEdge = null; renderSelection(); });
                graph.append(card);
            }
            existing.delete(node.id);
            card.dataset.state = node.state;
            card.style.left = `${position.x}px`; card.style.right = '18px'; card.style.top = `${position.y}px`;
            card.setAttribute('aria-label', `${node.label}: ${node.state}. ${nodeContextText(node)}`);
            const title = el('strong'); title.append(el('span', node.label), el('span', node.state, 'activity-state'));
            const meter = el('div', undefined, 'activity-meter'); meter.setAttribute('aria-hidden', 'true');
            const fill = el('span', undefined, `activity-meter-fill${node.context?.percent >= 80 ? ' near-limit' : ''}`);
            fill.style.width = `${Math.min(100, Math.max(0, node.context?.percent || 0))}%`; meter.append(fill);
            card.replaceChildren(title, el('span', node.model || (node.kind === 'workflow' ? 'Workflow' : 'Model not reported'), 'activity-model'), meter,
                el('span', nodeContextText(node), 'activity-context'), el('span', node.currentTool ? `↳ ${node.currentTool}` : node.id === 'parent' && !snapshot.subagentsAvailable ? 'Subagent telemetry not connected' : node.kind, 'activity-tool'));
        });
        for (const card of existing.values()) card.remove();
        drawEdges(positions, width, height);
        eventList.replaceChildren();
        for (const event of [...(snapshot.events || [])].reverse()) {
            const item = el('li'); item.append(el('time', time(event.at)), el('span', event.label)); eventList.append(item);
        }
        renderSelection();
    }
    function renderSelection() {
        for (const card of graph.querySelectorAll('.activity-node')) {
            const active = card.dataset.id === selected;
            card.classList.toggle('selected', active); card.setAttribute('aria-pressed', String(active));
        }
        const node = snapshot?.nodes.find(node => node.id === selected);
        const focusedEdge = detail.contains(document.activeElement) ? document.activeElement.dataset.edge : null;
        detail.replaceChildren(); detail.hidden = !node;
        if (!node) return;
        detail.append(el('h3', node.label));
        const row = (label, value) => { const line = el('p'); line.append(el('span', `${label} `, 'activity-detail-label'), document.createTextNode(value)); detail.append(line); };
        row('Status', node.state);
        if (node.model) row('Model', node.model);
        row('Context', nodeContextText(node));
        if (node.id.startsWith('fleet:')) row('Model reading', 'Not linked to a graph node: the status API does not expose a shared identity. This may describe an agent already shown above.');
        if (node.context) row('Measured', `${time(node.context.observedAt)} · ${node.context.basis === 'last-input' ? 'last observed input, not current occupancy' : 'Pi estimate, not an exact token count'}`);
        if (node.currentTool) row('Tool', node.currentTool);
        const edges = (snapshot.edges || []).filter(edge => edge.source === node.id || edge.target === node.id);
        if (edges.length) {
            detail.append(el('p', 'Connections', 'activity-detail-label'));
            for (const edge of edges) {
                const from = snapshot.nodes.find(other => other.id === edge.source)?.label || edge.source;
                const to = snapshot.nodes.find(other => other.id === edge.target)?.label || edge.target;
                const button = el('button', `${from} → ${to} · ${edge.label}`, 'quiet-button');
                button.type = 'button'; button.dataset.edge = edge.id; button.style.margin = '3px 0'; button.style.fontSize = '11px';
                button.addEventListener('click', () => { selectedEdge = edge.id; showEdge(edge); });
                detail.append(button);
            }
        }
        const edge = edges.find(edge => edge.id === selectedEdge);
        if (edge) showEdge(edge);
        if (focusedEdge) [...detail.querySelectorAll('button')].find(button => button.dataset.edge === focusedEdge)?.focus({ preventScroll: true });
    }
    function showEdge(edge) {
        detail.querySelector('.activity-edge-detail')?.remove();
        const box = el('p', `${edge.kind}: ${edge.label}${edge.at ? ` · ${time(edge.at)}` : ''}`, 'activity-edge-detail'); detail.append(box);
    }
    toggle.addEventListener('click', () => setOpen(!open));
    close.addEventListener('click', () => setOpen(false));
    backdrop.addEventListener('click', () => setOpen(false));
    document.addEventListener('limilink:session', changedSession);
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); else poll(); });
    window.addEventListener('focus', poll);
    overlay.addEventListener('change', updateOverlay);
    mobile.addEventListener('change', updateOverlay);
    new ResizeObserver(() => { if (open && snapshot) drawEdges(new Map([...graph.querySelectorAll('.activity-node')].map(card => [card.dataset.id, { x: parseFloat(card.style.left), y: parseFloat(card.style.top) }])), Math.max(graph.clientWidth, 270), snapshot.nodes.length * 138); }).observe(graph);
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
        if (event.key === 'Tab' && overlay.matches) {
            const buttons = [...panel.querySelectorAll('button, summary')].filter(node => node.getClientRects().length);
            const first = buttons[0], last = buttons.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
})();
