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
    globalThis.LimilinkHistory = { version: 2, create, isPrefix, linkParts, pageSize: PAGE };
})();
