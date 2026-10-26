// Shared by the active and cached-page controllers; no network or read receipts.
(() => {
    'use strict';
    const PAGE = 50;
    const same = (a, b) => a.role === b.role && a.content === b.content;
    const isPrefix = (before, after) => before.length <= after.length
        && before.every((item, index) => same(item, after[index]));

    // Recognize two inline link forms, not HTML or a full Markdown grammar.
    function linkParts(text, base) {
        if (!/[\[<]/.test(text)) return [{ text }];
        const escaped = new Set(), runs = [];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\\') { if (i + 1 < text.length) escaped.add(++i); }
            else if (text[i] === '`') {
                let end = i + 1;
                while (text[end] === '`') end++;
                runs.push([i, end - i]); i = end - 1;
            }
        }
        const code = new Map(), nextRun = new Map();
        for (let i = runs.length - 1; i >= 0; i--) {
            const [start, count] = runs[i], end = nextRun.get(count);
            if (end !== undefined) code.set(start, end + count);
            else if (count >= 3) code.set(start, text.length); // Unfinished fence stays literal.
            nextRun.set(count, start);
        }
        const angles = new Map();
        for (const match of text.matchAll(/<[^<>\r\n]*>/g)) {
            if (!escaped.has(match.index)) angles.set(match.index, match.index + match[0].length);
        }
        const partners = new Map(), brackets = [], parentheses = [];
        for (let i = 0; i < text.length; i++) {
            if (escaped.has(i)) continue;
            const opaque = code.get(i) ?? angles.get(i);
            if (opaque !== undefined) { i = opaque - 1; continue; }
            if (text[i] === '[') brackets.push(i);
            else if (text[i] === ']' && brackets.length) partners.set(brackets.pop(), i);
            else if (text[i] === '(') parentheses.push(i);
            else if (text[i] === ')' && parentheses.length) partners.set(parentheses.pop(), i);
        }
        const href = raw => {
            if (!raw || /[\s\u0000-\u001f\u007f\\]/.test(raw)) return null;
            try {
                const url = new URL(raw, base);
                return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
            } catch { return null; }
        };
        const parts = [];
        let plain = 0;
        const add = (start, end, label, destination) => {
            const url = href(destination);
            if (!url) return;
            if (start > plain) parts.push({ text: text.slice(plain, start) });
            parts.push({ text: label, href: url }); plain = end;
        };
        for (let i = 0; i < text.length; i++) {
            if (escaped.has(i)) continue;
            const literal = code.get(i);
            if (literal !== undefined) { i = literal - 1; continue; }
            const angle = angles.get(i);
            if (angle !== undefined) {
                const raw = text.slice(i + 1, angle - 1);
                if (/^https?:\/\//i.test(raw)) add(i, angle, raw, raw);
                i = angle - 1; continue;
            }
            if (text[i] !== '[') continue;
            const labelEnd = partners.get(i), open = labelEnd === undefined ? -1 : labelEnd + 1;
            const end = text[open] === '(' ? partners.get(open) : undefined;
            if (end === undefined) continue;
            // Consume whole candidates, including images and rejected URLs: no nested retries.
            if (!(text[i - 1] === '!' && !escaped.has(i - 1))) {
                const label = text.slice(i + 1, labelEnd);
                let destination = text.slice(open + 1, end);
                if (destination.startsWith('<') && destination.endsWith('>')) destination = destination.slice(1, -1);
                if (label && !/[\r\n]/.test(label)) add(i, end + 1, label, destination);
            }
            i = end;
        }
        if (plain < text.length || !parts.length) parts.push({ text: text.slice(plain) });
        return parts;
    }

    function message(item) {
        const node = document.createElement('div');
        node.className = `message ${item.role === 'user' ? 'user' : 'bot'}`;
        if (item.role === 'user' && validSendId(item.request_id)) node.dataset.requestId = item.request_id;
        String(item.content).split(/```([\s\S]*?)```/g).forEach((part, index) => {
            if (index % 2) {
                const pre = document.createElement('pre');
                const code = document.createElement('code');
                code.textContent = part;
                pre.append(code);
                node.append(pre);
            } else for (const piece of linkParts(part, document.baseURI)) {
                if (!piece.href) node.append(document.createTextNode(piece.text));
                else {
                    const link = document.createElement('a');
                    link.textContent = piece.text;
                    link.href = piece.href;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    node.append(link);
                }
            }
        });
        return node;
    }

    const validSendId = id => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
    function canonicalSendIds(items) {
        const counts = new Map();
        for (const item of items) if (item.role === 'user' && validSendId(item.request_id)) {
            counts.set(item.request_id, (counts.get(item.request_id) || 0) + 1);
        }
        return new Set([...counts].filter(([, count]) => count === 1).map(([id]) => id));
    }

    function create(chat, { empty, onPrepend }) {
        let history = [], nodes = [], start = 0, initialized = false;
        const transients = new Map();
        let emptyNode = null;
        const older = document.createElement('button');
        older.type = 'button'; older.className = 'quiet-button load-older';
        older.textContent = 'Load older';
        older.setAttribute('aria-label', 'Load older messages');
        const clearTransients = () => {
            const changed = transients.size > 0;
            for (const node of transients.values()) node.remove();
            transients.clear();
            return changed;
        };
        const fragment = items => {
            const result = document.createDocumentFragment(), added = items.map(message);
            for (const node of added) result.append(node);
            return { result, added };
        };
        const syncOptimistic = (next, records) => {
            const recorded = canonicalSendIds(next), wanted = new Map();
            for (const item of records) if (validSendId(item.id) && typeof item.text === 'string' && !recorded.has(item.id)) {
                wanted.set(item.id, item);
            }
            let changed = false;
            for (const [id, node] of transients) if (!wanted.has(id)) {
                node.remove(); transients.delete(id); changed = true;
            }
            if (wanted.size) { emptyNode?.remove(); emptyNode = null; }
            let previous = nodes.at(-1) || older;
            for (const [id, item] of wanted) {
                let node = transients.get(id);
                if (!node) {
                    node = message({ role: 'user', content: item.text });
                    node.dataset.requestId = id;
                    transients.set(id, node); changed = true;
                }
                if (node.parentNode !== chat || previous.nextSibling !== node) {
                    previous.after(node); changed = true;
                }
                previous = node;
            }
            return changed;
        };
        older.addEventListener('click', () => {
            if (!start) return;
            const top = chat.getBoundingClientRect().top;
            const anchor = nodes.find(node => node.getBoundingClientRect().bottom > top) || nodes[0];
            const before = anchor.getBoundingClientRect().top, scroll = chat.scrollTop;
            const anchoring = chat.style.overflowAnchor;
            chat.style.overflowAnchor = 'none';
            const nextStart = Math.max(0, start - PAGE);
            const { result, added } = fragment(history.slice(nextStart, start));
            older.after(result); nodes.unshift(...added); start = nextStart;
            older.hidden = start === 0;
            chat.scrollTop = scroll + anchor.getBoundingClientRect().top - before;
            chat.style.overflowAnchor = anchoring;
            if (older.hidden && document.activeElement === older) {
                anchor.tabIndex = -1; anchor.focus({ preventScroll: true });
            }
            onPrepend();
        });
        return {
            reset() {
                history = []; nodes = []; transients.clear(); start = 0;
                emptyNode = null; initialized = false;
            },
            render(next, optimistic = false) {
                const exact = Array.isArray(optimistic);
                const reuse = initialized && older.parentNode === chat && isPrefix(history, next);
                let changed = false;
                if (reuse) {
                    // Boolean mode remains compatible with old cached controllers.
                    if (!exact && (next.length !== history.length || !optimistic)) changed = clearTransients();
                    if (next.length > history.length) {
                        emptyNode?.remove(); emptyNode = null;
                        const { result, added } = fragment(next.slice(history.length));
                        const first = [...transients.values()].find(node => node.parentNode === chat);
                        chat.insertBefore(result, first || null);
                        nodes = nodes.concat(added); changed = true;
                    }
                } else {
                    const count = initialized ? Math.max(PAGE, history.length - start) : PAGE;
                    start = Math.max(0, next.length - count);
                    if (!exact) transients.clear();
                    const { result, added } = fragment(next.slice(start));
                    nodes = added; chat.replaceChildren(older, result);
                    emptyNode = null; changed = true;
                }
                nodes.forEach((node, index) => {
                    const item = next[start + index];
                    if (item.role === 'user' && validSendId(item.request_id)) node.dataset.requestId = item.request_id;
                    else delete node.dataset.requestId;
                });
                if (exact) changed = syncOptimistic(next, optimistic) || changed;
                if (!next.length && !transients.size && !emptyNode) {
                    emptyNode = empty(); chat.prepend(older); changed = true;
                }
                history = next; initialized = true; older.hidden = start === 0;
                return changed;
            },
            append(content, role, requestId = null) {
                emptyNode?.remove(); emptyNode = null;
                const id = validSendId(requestId) ? requestId : Symbol('optimistic');
                if (transients.has(id)) return;
                const node = message({ role, content });
                if (validSendId(requestId)) node.dataset.requestId = requestId;
                transients.set(id, node); chat.append(node);
            },
            nodeAt(index) { return initialized ? nodes[index - start] || null : null; },
            start() { return start; },
        };
    }
    globalThis.LimilinkHistory = { version: 3, create, isPrefix, canonicalSendIds, linkParts, pageSize: PAGE };
})();
