// Data-only stock SDK adapter for relocate_state.py. Never creates an agent.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const input = JSON.parse(readFileSync(0, 'utf8'));
const require = createRequire(import.meta.url);
const {SessionManager, buildSessionContext, CURRENT_SESSION_VERSION} = await import(pathToFileURL(require.resolve(input.package)));
const version = JSON.parse(readFileSync(join(input.package, 'package.json'), 'utf8')).version;
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = (entries, context) => ({entries:hash(JSON.stringify(entries)),context:hash(JSON.stringify(context))});
const results = [];
for (const job of input.jobs) {
    if (input.mode === 'verify') {
        const current = SessionManager.continueRecent(job.cwd, job.directory);
        assert.equal(current.getSessionId(), job.id, 'Continuation selected a different Pi ID');
        assert.equal(current.getSessionFile(), job.file, 'Continuation selected a different journal');
        const result = fingerprint(current.getEntries(), current.buildSessionContext());
        assert.deepEqual(result, job.fingerprint, 'Continuation context changed');
        results.push(result);
        continue;
    }
    const bytes = readFileSync(job.source);
    // The SDK silently skips malformed lines and may append a missing newline.
    // Validate first so even dry-run cannot alter or omit source evidence.
    assert(bytes.length && bytes.at(-1) === 10, 'Journal needs a terminal newline; inspect it before relocation');
    const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    const rows = text.split('\n').filter(line => line.trim()).map((line, index) => {
        try { return JSON.parse(line); } catch { throw Error(`Malformed journal JSONL at line ${index + 1}`); }
    });
    const header = rows[0], entries = rows.slice(1);
    assert(header?.type === 'session' && header.version === CURRENT_SESSION_VERSION, 'Unsupported journal header/version');
    assert.equal(header.id, job.id);
    assert(typeof header.id === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(header.id), 'Invalid Pi session ID');
    assert(entries.every(row => row && !Array.isArray(row) && typeof row === 'object' && typeof row.type === 'string' && row.type !== 'session' && typeof row.id === 'string'), 'Invalid journal entries');
    assert.equal(new Set(entries.map(row => row.id)).size, entries.length, 'Duplicate journal entry IDs');
    const byId = new Map(entries.map(row => [row.id,row])), done = new Set();
    for (const entry of entries) {
        const chain = new Set(); let current = entry;
        while (current && !done.has(current.id)) {
            assert(!chain.has(current.id), 'Cyclic journal parent chain');
            chain.add(current.id);
            assert(current.parentId === null || (typeof current.parentId === 'string' && byId.has(current.parentId)), 'Missing journal parent');
            current = current.parentId === null ? null : byId.get(current.parentId);
        }
        for (const id of chain) done.add(id);
    }
    const result = {sha256:hash(bytes), ...fingerprint(entries, buildSessionContext(entries))};
    if (input.mode === 'fork') {
        assert.deepEqual(result, job.expected, 'Source journal changed after preflight');
        const forked = SessionManager.forkFrom(job.source, job.cwd, job.directory, {id:job.id});
        assert(JSON.stringify(forked.getEntries()) === JSON.stringify(entries), 'Fork changed entries');
        assert.deepEqual(fingerprint(forked.getEntries(), forked.buildSessionContext()), {entries:result.entries,context:result.context});
        assert.equal(hash(readFileSync(job.source)), result.sha256, 'SDK altered source journal');
        results.push({...result,file:forked.getSessionFile()});
    } else {
        assert.equal(input.mode, 'inspect');
        results.push(result);
    }
}
process.stdout.write(JSON.stringify({version,results}));
