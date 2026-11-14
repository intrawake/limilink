import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function controller(saved = new Map()) {
    const source = await readFile(new URL('../src/ui/follow.js', import.meta.url), 'utf8');
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) {
            const listeners = new Map();
            nodes.set(id, { value: '', textContent: '', hidden: true, disabled: false, style: {},
                addEventListener: (type, callback) => listeners.set(type, callback),
                click: () => listeners.get('click')?.(), focus() {}, setAttribute() {} });
        }
        return nodes.get(id);
    };
    const calls = [], events = [], timers = new Map();
    let timer = 0;
    const context = vm.createContext({
        document: { getElementById: node, addEventListener() {}, dispatchEvent: event => events.push(event.detail), visibilityState: 'visible' },
        window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
        localStorage: { get length() { return saved.size; }, key: index => [...saved.keys()][index],
            getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
        AbortController, URLSearchParams, CustomEvent: class { constructor(type, options) { this.detail = options.detail; } },
        setTimeout: callback => { timers.set(++timer, callback); return timer; }, clearTimeout: id => timers.delete(id),
        clearInterval() {}, cancelAnimationFrame() {},
        fetch: (path, options = {}) => new Promise((resolve, reject) => {
            const call = { path, options, body: options.body ? JSON.parse(options.body) : null,
                respond: (data, status = 200) => resolve({ ok: status < 400, status, json: async () => data }), reject };
            calls.push(call);
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    vm.runInContext(source.slice(0, source.indexOf("\nbyId('new-session-btn').addEventListener")), context);
    const run = code => vm.runInContext(code, context);
    run(`
        sessions=[{id:'x'},{id:'y'},{id:'z'}]; currentSession='x'; connected=true; historyReady=true;
        renderSessions=()=>{}; resizeInput=()=>{}; appendMessage=()=>{}; syncSnapshot=async()=>true;
        let nonce=0; newSendId=()=> (++nonce).toString(16).padStart(32,'0');
    `);
    // Exercise the actual recovery actions without starting the DOM controller.
    vm.runInContext(source.slice(source.indexOf("byId('restore-unconfirmed').addEventListener"),
        source.indexOf("sendButton.addEventListener('click', sendMessage)")), context);
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    return { run, node, calls, events, saved, timers, flush,
        send: async (session, text) => { run(`currentSession=${JSON.stringify(session)}; input.value=${JSON.stringify(text)}; void sendMessage();`); await flush(); },
    };
}

export function operation(call, state = 'queued', revision = 0, extra = {}) {
    return { id: call.body.request_id, session_id: call.path.split('/')[2], sequence: 0, revision, state,
        message: call.body.message, execution_id: null, outcome: null, ...extra };
}
