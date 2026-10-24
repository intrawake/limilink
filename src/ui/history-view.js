// Shared by the active and cached-page controllers; no network or read receipts.
(() => {
    'use strict';
    const PAGE = 50;
    const same = (a, b) => a.role === b.role && a.content === b.content;
    const isPrefix = (before, after) => before.length <= after.length
        && before.every((item, index) => same(item, after[index]));

    function message(item) {
        const node = document.createElement('div');
        node.className = `message ${item.role === 'user' ? 'user' : 'bot'}`;
        String(item.content).split(/```([\s\S]*?)```/g).forEach((part, index) => {
            if (index % 2) {
                const pre = document.createElement('pre');
                const code = document.createElement('code');
                code.textContent = part;
                pre.append(code);
                node.append(pre);
            } else node.append(document.createTextNode(part));
        });
        return node;
    }

    function create(chat, { empty, onPrepend }) {
        let history = [], nodes = [], transients = [], start = 0, initialized = false;
        let emptyNode = null;
        const older = document.createElement('button');
        older.type = 'button';
        older.className = 'quiet-button load-older';
        older.textContent = 'Load older';
        older.setAttribute('aria-label', 'Load older messages');
        const clearTransients = () => {
            const changed = transients.length > 0;
            transients.forEach(node => node.remove());
            transients = [];
            return changed;
        };
        const fragment = items => {
            const result = document.createDocumentFragment();
            const added = items.map(message);
            for (const node of added) result.append(node);
            return { result, added };
        };
        older.addEventListener('click', () => {
            if (!start) return;
            const top = chat.getBoundingClientRect().top;
            const anchor = nodes.find(node => node.getBoundingClientRect().bottom > top) || nodes[0];
            const before = anchor.getBoundingClientRect().top;
            const scroll = chat.scrollTop;
            const anchoring = chat.style.overflowAnchor;
            chat.style.overflowAnchor = 'none';
            const nextStart = Math.max(0, start - PAGE);
            const { result, added } = fragment(history.slice(nextStart, start));
            older.after(result);
            nodes.unshift(...added);
            start = nextStart;
            older.hidden = start === 0;
            chat.scrollTop = scroll + anchor.getBoundingClientRect().top - before;
            chat.style.overflowAnchor = anchoring;
            if (older.hidden && document.activeElement === older) {
                anchor.tabIndex = -1;
                anchor.focus({ preventScroll: true });
            }
            onPrepend();
        });
        return {
            reset() {
                history = []; nodes = []; transients = []; start = 0;
                emptyNode = null; initialized = false;
            },
            render(next, preserveOptimistic = false) {
                const prefix = isPrefix(history, next);
                const reuse = initialized && older.parentNode === chat && prefix;
                let changed = false;
                if (reuse) {
                    if (next.length !== history.length || !preserveOptimistic) changed = clearTransients();
                    if (next.length > history.length) {
                        emptyNode?.remove(); emptyNode = null;
                        const { result, added } = fragment(next.slice(history.length));
                        nodes = nodes.concat(added);
                        chat.append(result);
                        changed = true;
                    }
                } else {
                    const count = initialized ? Math.max(PAGE, history.length - start) : PAGE;
                    start = Math.max(0, next.length - count);
                    transients = [];
                    const { result, added } = fragment(next.slice(start));
                    nodes = added;
                    chat.replaceChildren(older, result);
                    emptyNode = null;
                    if (!next.length) {
                        emptyNode = empty();
                        chat.prepend(older);
                    }
                    changed = true;
                }
                if (!next.length && !transients.length && !emptyNode) {
                    emptyNode = empty();
                    chat.prepend(older);
                    changed = true;
                }
                history = next;
                initialized = true;
                older.hidden = start === 0;
                return changed;
            },
            append(content, role) {
                emptyNode?.remove(); emptyNode = null;
                const node = message({ role, content });
                transients.push(node);
                chat.append(node);
            },
            nodeAt(index) { return initialized ? nodes[index - start] || null : null; },
            start() { return start; },
        };
    }
    globalThis.LimilinkHistory = { create, isPrefix, pageSize: PAGE };
})();
