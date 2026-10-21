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
    // Local display evidence, not native run ownership or a global turn ledger.
    const dismissals = new Map(), dismissalKey = 'limilink_activity_dismissals_v1';
    const dismissalLimits = { conversations: 8, records: 64, sends: 64, fingerprint: 4096 };
    try {
        const text = sessionStorage.getItem(dismissalKey);
        if (text && text.length <= 2300000) {
            const saved = JSON.parse(text);
            if (saved.version === 1 && Array.isArray(saved.sessions) && saved.sessions.length <= dismissalLimits.conversations) {
                for (const [id, value] of saved.sessions) {
                    if (typeof id !== 'string' || id.length > 240 || !Array.isArray(value.records) || !Array.isArray(value.sends)) continue;
                    const records = value.records.slice(-dismissalLimits.records).filter(row => Array.isArray(row) && row.length === 2
                        && typeof row[0] === 'string' && row[0].length <= 240 && typeof row[1] === 'string' && row[1].length <= dismissalLimits.fingerprint);
                    const sends = value.sends.slice(-dismissalLimits.sends).filter(id => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id));
                    dismissals.set(id, { records: new Map(records), sends: new Set(sends) });
                }
            }
        }
    } catch { dismissals.clear(); /* Unavailable/malformed storage fails open. */ }
    let open = false, selected = 'parent', session = null, request = null, timer = null, snapshot = null;
    let live = false, serverOffset = 0, selectedEdge = null;
    const el = (tag, text, cls) => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    };
    const number = value => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    const clock = new Intl.DateTimeFormat('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short'
    });
    const time = value => {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return 'Time unavailable';
        const parts = Object.fromEntries(clock.formatToParts(date).map(part => [part.type, part.value]));
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
    };
    const modelLabel = node => node.observation ? node.observation.modelBasis === 'response' ? 'Last response model' : 'Selected model'
        : node.id === 'parent' ? 'Model' : 'Reported model';
    const modelText = node => node.model ? `${node.id === 'parent' ? '' : `${modelLabel(node)}: `}${node.model}`
        : node.kind === 'workflow' ? 'Workflow' : node.kind === 'step' ? 'Execution step' : 'Model not reported';
    const nodeLabel = node => node.kind === 'step' ? `Execution step: ${node.label}` : node.label;
    // Legacy snapshots call all hierarchy edges delegation, including steps.
    const executionEdge = edge => edge.kind === 'delegation' && snapshot?.nodes.some(node => node.id === edge.target && node.kind === 'step');
    const edgeLabel = edge => executionEdge(edge) ? 'Execution step' : edge.label;
    const activeNode = node => (node.state === 'working' || node.state === 'running') && (!node.observation || observationStatus(node) === 'open');
    // Only explicit owning closure / native terminal reports enter history.
    // Idle, stale, conflict and unknown never establish that work has ended.
    const historyNode = node => node.id !== 'parent' && (node.observation
        ? node.observation.status === 'closed' : ['complete', 'failed', 'partial', 'stopped', 'rejected'].includes(node.state));
    const age = value => Math.max(0, Math.floor((Date.now() + serverOffset - value) / 1000));
    const observationStatus = node => node.observation?.status === 'open' && (!live || age(node.observation.observedAt) > 10) ? 'stale' : node.observation?.status;
    const contextText = context => {
        if (!context) return 'Context not reported';
        const used = context.tokens === null ? 'unknown' : `~${number(context.tokens)}`;
        return `${context.basis === 'last-input' ? 'Last input' : 'Context'} ${used} / ${number(context.contextWindow)}${context.percent === null ? '' : ` · ${Math.round(context.percent)}%`}`;
    };
    const nodeContextText = node => {
        if (observationStatus(node) === 'conflict') return 'Current context unavailable · conflicting observers';
        if (observationStatus(node) === 'stale') return 'Current context unavailable · observer stale';
        if (node.observation?.invalidated) return node.observation.invalidated === 'compaction'
            ? 'Compacted · awaiting fresh usage' : 'Model changed · awaiting fresh usage';
        if (node.id === 'parent' && (snapshot.context?.tokens ?? null) === null
            && snapshot.events?.some(event => event.kind === 'context' && event.label === 'Context compacted')) {
            return 'Compacted · awaiting fresh usage';
        }
        return node.context ? contextText(node.context)
            : typeof node.lastInputTokens === 'number' ? `Last input ~${number(node.lastInputTokens)} · capacity unknown` : 'Context not reported';
    };
    const closedRecord = node => {
        if (node.id === 'parent' || node.observation?.status !== 'closed') return null;
        const record = JSON.stringify(node);
        return record.length <= dismissalLimits.fingerprint ? record : null;
    };
    const dismissedNode = node => {
        const record = closedRecord(node);
        return record !== null && dismissals.get(session)?.records.get(node.id) === record;
    };
    // The observer's async: namespace contains native run/workflow/step reports,
    // not additional observed agents. Keep those reports out of this view even
    // when session tracking is unavailable; never infer or merge identities.
    const visibleNodes = () => (snapshot?.nodes || []).filter(node => !node.id.startsWith('async:') && !dismissedNode(node));
    function saveDismissals() {
        try {
            sessionStorage.setItem(dismissalKey, JSON.stringify({ version: 1, sessions: [...dismissals].map(([id, value]) =>
                [id, { records: [...value.records], sends: [...value.sends] }]) }));
        } catch { /* Storage must never gate Send; in-memory display state still works. */ }
    }
    function retireChangedDismissals() {
        const state = dismissals.get(session);
        let changed = false;
        for (const node of snapshot?.nodes || []) {
            if (state?.records.has(node.id) && state.records.get(node.id) !== closedRecord(node)) {
                state.records.delete(node.id); changed = true;
            }
        }
        if (changed) saveDismissals();
    }
    function humanSend(event) {
        const { sessionId: id, requestId } = event.detail || {};
        if (typeof id !== 'string' || id.length > 240 || typeof requestId !== 'string' || !/^[0-9a-f]{32}$/.test(requestId)) return;
        let state = dismissals.get(id);
        if (!state) {
            if (dismissals.size >= dismissalLimits.conversations) dismissals.delete(dismissals.keys().next().value);
            state = { records: new Map(), sends: new Set() }; dismissals.set(id, state);
        }
        if (state.sends.has(requestId)) return;
        state.sends.add(requestId);
        if (state.sends.size > dismissalLimits.sends) state.sends.delete(state.sends.values().next().value);
        // Never fetch/delay Send or infer what was closed before an unseen boundary.
        for (const node of cache.get(id)?.activity?.nodes || []) {
            const record = closedRecord(node);
            if (record !== null) {
                state.records.delete(node.id); state.records.set(node.id, record);
                if (state.records.size > dismissalLimits.records) state.records.delete(state.records.keys().next().value);
            }
        }
        saveDismissals();
        if (id === session && snapshot) {
            const focused = document.activeElement;
            const inspectorFocus = graph.contains(focused) || detail.contains(focused);
            render();
            if (inspectorFocus && (!document.activeElement || document.activeElement === document.body)) {
                graph.querySelector('[data-id="parent"]')?.focus({ preventScroll: true });
            }
        }
    }
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
            retireChangedDismissals();
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
            const delegation = edge.kind === 'delegation' || edge.kind === 'ancestry';
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
    function renderEvents() {
        // Keep legacy rows flat. Only explicit tool-event links create nesting.
        const lookup = new Map();
        for (const row of snapshot.events || []) if (!lookup.has(row.id)) lookup.set(row.id, row);
        const owner = snapshot.nodes.find(node => node.id === selected);
        document.querySelector('#activity-events summary').textContent = `Recent activity · ${owner ? nodeLabel(owner) : 'Main agent'}`;
        const rows = [...lookup.values()].filter(row => (row.nodeId ?? 'parent') === selected);
        const parents = new Map(), children = new Map();
        for (const row of rows) {
            const parent = lookup.get(row.parentEventId);
            if (row.kind !== 'tool' || parent?.kind !== 'tool' || row.nodeId !== parent.nodeId || row.id === parent.id) continue;
            let ancestor = parent.id;
            while (parents.has(ancestor) && ancestor !== row.id) ancestor = parents.get(ancestor);
            if (ancestor === row.id) continue; // Reject the edge that would close a cycle.
            parents.set(row.id, parent.id);
            if (!children.has(parent.id)) children.set(parent.id, []);
            children.get(parent.id).push(row);
        }
        const seen = new Set();
        const append = (row, list, depth) => {
            if (seen.has(row.id)) return;
            seen.add(row.id);
            const item = el('li'); item.dataset.eventId = row.id; item.dataset.depth = depth;
            if (row.state) item.dataset.state = row.state;
            const line = el('div', undefined, 'activity-event-row');
            line.append(el('time', time(row.at)));
            if (depth) {
                const branch = el('span', '↳', 'activity-event-branch');
                branch.setAttribute('aria-hidden', 'true'); line.append(branch);
            }
            const label = row.kind === 'tool' && (!row.state || row.state === 'finished')
                ? row.label.replace(/^Finished /, '') : row.label;
            line.append(el('span', label, 'activity-event-label')); item.append(line);
            if (row.parentEventId && !parents.has(row.id)) {
                line.append(el('small', lookup.has(row.parentEventId) ? 'Nesting unavailable' : 'Parent outside recent history', 'activity-event-note'));
            }
            const nested = children.get(row.id);
            if (nested?.length) {
                item.classList.add('activity-event-group');
                const nestedList = el('ol', undefined, `activity-event-children${depth >= 3 ? ' activity-indent-limit' : ''}`);
                for (const child of nested) append(child, nestedList, depth + 1);
                item.append(nestedList);
            }
            list.append(item);
        };
        eventList.replaceChildren();
        if (owner?.observation) {
            const observed = owner.observation, sourceState = observationStatus(owner);
            const notes = ['Bounded Pi-session observations, not native run/step/retry history.'];
            if (observed.omitted) notes.push(`${number(observed.omitted)} observations outside the retained history.`);
            if (sourceState === 'conflict') notes.push('Conflicting unclosed observers: current state and context are unavailable.');
            if (sourceState === 'stale') notes.push('Observer stale: rows are last observations, not proof of current execution.');
            if (sourceState === 'closed') notes.push('Observer shutdown was seen; this does not establish native task success.');
            eventList.append(el('li', notes.join(' '), 'activity-event-note'));
        } else if (selected !== 'parent' && rows.some(row => row.kind === 'usage')) {
            const missingTools = !rows.some(row => row.kind === 'tool');
            eventList.append(el('li', 'Package-reported run totals are cumulative, not context occupancy or usage attributed to one model.'
                + (missingTools ? ' Per-tool history is not reported.' : ''), 'activity-event-note'));
        } else if (!rows.length) eventList.append(el('li', selected === 'parent' ? 'No recent activity reported.'
            : 'Per-tool history is not reported for this selection. Select the main agent to view its activity.', 'activity-event-note'));
        for (const row of [...rows].reverse()) if (!parents.has(row.id)) append(row, eventList, 0);
        // Defensive fallback: malformed relationships must never hide a row.
        for (const row of [...rows].reverse()) append(row, eventList, 0);
    }
    function render() {
        const stale = !live || age(snapshot.updatedAt) > 10;
        status.classList.toggle('activity-stale', live && stale);
        const tracking = snapshot.sessionTracking;
        status.textContent = `${live ? stale ? 'Last observation' : 'Live' : 'Last run'} · ${time(snapshot.updatedAt)}${live && stale ? ` · ${age(snapshot.updatedAt)}s ago` : ''}`
            + (tracking ? tracking.available ? ' · Observed Pi sessions' : ' · Session observer unavailable' : '')
            + (tracking?.limited ? ' · Observation limit reached' : '');
        const nodes = visibleNodes().sort((a, b) => (b.id === 'parent') - (a.id === 'parent'));
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
                const parent = lookup.get(node.parentId);
                if (historyNode(parent) !== historyNode(node)) break;
                if (visited.has(node.parentId)) return 0;
                visited.add(node.parentId); node = parent; count++;
            }
            return count;
        };
        const focusedCard = document.activeElement?.closest?.('.activity-node');
        const focusedId = focusedCard && graph.contains(focusedCard) ? focusedCard.dataset.id : null;
        graph.querySelectorAll('.activity-section-heading').forEach(heading => heading.remove());
        const positions = new Map();
        const width = Math.max(graph.clientWidth, 270);
        let height = 0;
        const ordered = [], headings = new Map();
        for (const [group, title] of [['current', 'Current observations'], ['history', 'Recent history']]) {
            const members = nodes.filter(node => historyNode(node) === (group === 'history'));
            if (!members.length) continue;
            const heading = el('h3', title, 'activity-section-heading');
            heading.id = `activity-${group}-heading`; heading.dataset.group = group;
            heading.style.top = `${height}px`; headings.set(group, heading); height += 32;
            for (const node of members) {
                positions.set(node.id, { x: 12 + depth(node) * 18, y: height, group });
                ordered.push(node); height += 138;
            }
        }
        graph.style.height = `${height}px`;
        const existing = new Map([...graph.querySelectorAll('.activity-node')].map(node => [node.dataset.id, node]));
        let previousGroup = null;
        ordered.forEach(node => {
            const position = positions.get(node.id);
            if (position.group !== previousGroup) { graph.append(headings.get(position.group)); previousGroup = position.group; }
            let card = existing.get(node.id);
            if (!card) {
                card = el('button', undefined, 'activity-node'); card.type = 'button'; card.dataset.id = node.id;
                card.addEventListener('click', () => { selected = node.id; selectedEdge = null; renderSelection(); });
            }
            // Match keyboard order to the current/history visual order. Restore
            // focus below only if it was already on a surviving graph card.
            graph.append(card);
            existing.delete(node.id);
            card.dataset.group = position.group;
            card.setAttribute('aria-describedby', `activity-${position.group}-heading`);
            const sourceState = observationStatus(node);
            const stateText = sourceState === 'closed' ? 'closed' : sourceState === 'stale' ? `last observed ${node.state}` : node.state;
            card.dataset.state = sourceState === 'closed' ? 'closed' : sourceState === 'stale' ? 'unknown' : node.state;
            card.style.left = `${position.x}px`; card.style.right = '18px'; card.style.top = `${position.y}px`;
            card.setAttribute('aria-label', `${nodeLabel(node)}: ${stateText}. ${nodeContextText(node)}`);
            const title = el('strong'); title.append(el('span', nodeLabel(node)), el('span', stateText, 'activity-state'));
            const meter = el('div', undefined, 'activity-meter'); meter.setAttribute('aria-hidden', 'true');
            const fill = el('span', undefined, `activity-meter-fill${node.context?.percent >= 80 ? ' near-limit' : ''}`);
            fill.style.width = `${Math.min(100, Math.max(0, node.context?.percent || 0))}%`; meter.append(fill);
            card.replaceChildren(title, el('span', modelText(node), 'activity-model'), meter,
                el('span', nodeContextText(node), 'activity-context'), el('span', node.currentTool ? `${activeNode(node) ? '↳' : 'Last observed tool:'} ${node.currentTool}` : node.id === 'parent' && !snapshot.subagentsAvailable && !snapshot.sessionTracking?.available ? 'Subagent telemetry not connected' : node.kind, 'activity-tool'));
        });
        for (const card of existing.values()) card.remove();
        drawEdges(positions, width, height);
        renderSelection();
        if (focusedId) [...graph.querySelectorAll('.activity-node')].find(card => card.dataset.id === focusedId)?.focus({ preventScroll: true });
    }
    function renderSelection() {
        const visible = visibleNodes(), ids = new Set(visible.map(node => node.id));
        if (!ids.has(selected)) { selected = 'parent'; selectedEdge = null; }
        renderEvents();
        for (const card of graph.querySelectorAll('.activity-node')) {
            const active = card.dataset.id === selected;
            card.classList.toggle('selected', active); card.setAttribute('aria-pressed', String(active));
        }
        const node = visible.find(node => node.id === selected);
        const focusedEdge = detail.contains(document.activeElement) ? document.activeElement.dataset.edge : null;
        detail.replaceChildren(); detail.hidden = !node;
        if (!node) return;
        detail.append(el('h3', nodeLabel(node)));
        const row = (label, value) => { const line = el('p'); line.append(el('span', `${label} `, 'activity-detail-label'), document.createTextNode(value)); detail.append(line); };
        row('Status', observationStatus(node) === 'closed' ? 'closed' : node.state);
        if (historyNode(node)) row('View', node.observation
            ? 'Recent history · observer closed; not current activity. Closure does not establish native task success.'
            : 'Recent history · terminal native status, not current activity.');
        if (node.model) row(modelLabel(node), node.model);
        row('Context', nodeContextText(node));
        if (node.observation) {
            const observed = node.observation;
            row('Source', `Pi session events · ${observationStatus(node)} · ${time(observed.observedAt)}`);
            row('Identity', 'Observed SDK session, not an agent role or native run/attempt. Native run status is not shown or merged with these observations.');
            row('Ancestry', observed.ancestry === 'file-reference'
                ? 'Historical header parent-file reference; parent UUID and current delegation are not established.'
                : observed.ancestry === 'ambiguous' ? 'Conflicting parent/file identities; ancestry is unavailable.' : 'Parent session not observed in this view.');
            if (observed.selectedModel) row('Selected model', observed.selectedModel);
            if (observed.modelObservedAt) row('Response observed', time(observed.modelObservedAt));
            if (typeof node.lastInputTokens === 'number' && observed.lastInputObservedAt) row('Last successful input', `${number(node.lastInputTokens)} · ${time(observed.lastInputObservedAt)} · historical, not current occupancy`);
            row('Refresh', 'Child feeds refresh here while the parent observer is running.');
        }
        if (node.id.startsWith('fleet:')) row('Model reading', 'Not linked to a graph node: the status API does not expose a shared identity. This may describe an agent already shown above.');
        if (node.context) row('Measured', `${time(node.context.observedAt)} · ${node.context.basis === 'last-input' ? 'last observed input, not current occupancy' : 'Pi estimate, not an exact token count'}`);
        if (node.currentTool) row(activeNode(node) ? 'Tool' : 'Last observed tool', node.currentTool);
        const edges = (snapshot.edges || []).filter(edge => ids.has(edge.source) && ids.has(edge.target)
            && (edge.source === node.id || edge.target === node.id));
        if (edges.length) {
            detail.append(el('p', 'Connections', 'activity-detail-label'));
            for (const edge of edges) {
                const from = snapshot.nodes.find(other => other.id === edge.source);
                const to = snapshot.nodes.find(other => other.id === edge.target);
                const button = el('button', `${from ? nodeLabel(from) : edge.source} → ${to ? nodeLabel(to) : edge.target} · ${edgeLabel(edge)}`, 'quiet-button');
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
        const box = el('p', `${executionEdge(edge) ? 'execution' : edge.kind}: ${edgeLabel(edge)}${edge.at ? ` · ${time(edge.at)}` : ''}`, 'activity-edge-detail'); detail.append(box);
    }
    toggle.addEventListener('click', () => setOpen(!open));
    close.addEventListener('click', () => setOpen(false));
    backdrop.addEventListener('click', () => setOpen(false));
    document.addEventListener('limilink:session', changedSession);
    document.addEventListener('limilink:human-send', humanSend);
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); else poll(); });
    window.addEventListener('focus', poll);
    overlay.addEventListener('change', updateOverlay);
    mobile.addEventListener('change', updateOverlay);
    new ResizeObserver(() => { if (open && snapshot) drawEdges(new Map([...graph.querySelectorAll('.activity-node')].map(card => [card.dataset.id, { x: parseFloat(card.style.left), y: parseFloat(card.style.top), group: card.dataset.group }])), Math.max(graph.clientWidth, 270), parseFloat(graph.style.height) || 0); }).observe(graph);
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
