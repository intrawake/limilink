// Opt-in installed-Pi reproduction. No models, extensions, credentials or network.
// PI_PROOF_NPM_ROOT=/absolute/node_modules node test/state_relocation_native_smoke.mjs
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const npm = process.env.PI_PROOF_NPM_ROOT;
assert(npm, 'Set PI_PROOF_NPM_ROOT to the installed Pi node_modules');
const {SessionManager} = await import(pathToFileURL(join(npm, '@earendil-works/pi-coding-agent/dist/core/session-manager.js')));
const {getMissingSessionCwdIssue} = await import(pathToFileURL(join(npm, '@earendil-works/pi-coding-agent/dist/core/session-cwd.js')));
const version = JSON.parse(readFileSync(join(npm, '@earendil-works/pi-coding-agent/package.json'), 'utf8')).version;
const root = mkdtempSync(join(tmpdir(), 'limilink-relocation-proof-'));
try {
    const oldCwd = join(root, 'old-root/session_example');
    const newCwd = join(root, 'state/limilink/sessions/session_example');
    const journalDir = cwd => join(cwd, '.pi/agent/session');
    mkdirSync(journalDir(oldCwd), {recursive:true});
    const original = SessionManager.create(oldCwd, journalDir(oldCwd));
    original.appendMessage({role:'user',content:'Remember the fixture token: tangerine.',timestamp:1});
    original.appendMessage({role:'assistant',api:'fixture',provider:'fixture',model:'fixture',content:[{type:'text',text:'Remembered.'}],stopReason:'stop',timestamp:2,
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    const id = original.getSessionId();
    assert.equal(SessionManager.continueRecent(oldCwd, journalDir(oldCwd)).getSessionId(), id);
    const originalBytes = readFileSync(original.getSessionFile());
    mkdirSync(join(root, 'state/limilink'), {recursive:true});
    renameSync(join(root, 'old-root'), join(root, 'state/limilink/sessions'));
    const moved = SessionManager.continueRecent(newCwd, journalDir(newCwd));
    assert.notEqual(moved.getSessionId(), id);
    assert.equal(moved.buildSessionContext().messages.length, 0);
    const movedFile = original.getSessionFile().replace(join(root, 'old-root'), join(root, 'state/limilink/sessions'));
    assert.deepEqual(readFileSync(movedFile), originalBytes);
    // An explicit file keeps the old cwd; an SDK override is invocation-local.
    const explicit = SessionManager.open(movedFile, journalDir(newCwd));
    assert.equal(explicit.getCwd(), oldCwd);
    assert(getMissingSessionCwdIssue(explicit, newCwd));
    const override = SessionManager.open(movedFile, journalDir(newCwd), newCwd);
    assert.equal(override.getCwd(), newCwd);
    assert.deepEqual(override.buildSessionContext(), original.buildSessionContext());
    assert.equal(override.getHeader().cwd, oldCwd);
    assert.deepEqual(readFileSync(movedFile), originalBytes);
    assert.notEqual(SessionManager.continueRecent(newCwd, journalDir(newCwd)).getSessionId(), id);
    // A chosen UUID is supported too, but only one target may be authoritative.
    const chosenDir = join(root, 'chosen-id-proof');
    const chosen = SessionManager.forkFrom(movedFile, newCwd, chosenDir, {id});
    assert.equal(chosen.getSessionId(), id);
    assert.deepEqual(chosen.buildSessionContext(), original.buildSessionContext());
    assert.equal(SessionManager.continueRecent(newCwd, chosenDir).getSessionId(), id);
    // Stock forkFrom preserves the complete entry tree without rewriting its source.
    const forked = SessionManager.forkFrom(movedFile, newCwd, journalDir(newCwd));
    assert.notEqual(forked.getSessionId(), id);
    assert.equal(forked.getCwd(), newCwd);
    assert.equal(forked.getHeader().parentSession, movedFile);
    assert.deepEqual(forked.getEntries(), original.getEntries());
    assert.deepEqual(forked.buildSessionContext(), original.buildSessionContext());
    assert.deepEqual(readFileSync(movedFile), originalBytes);
    forked.appendMessage({role:'user',content:'A turn after relocation.',timestamp:3});
    assert.equal(SessionManager.continueRecent(newCwd, journalDir(newCwd)).getSessionId(), forked.getSessionId());
    assert.equal(SessionManager.continueRecent(newCwd, journalDir(newCwd)).buildSessionContext().messages.length, 3);
    renameSync(join(root, 'state/limilink/sessions'), join(root, 'old-root'));
    const rolledBack = SessionManager.continueRecent(oldCwd, journalDir(oldCwd));
    assert.equal(rolledBack.getSessionId(), id);
    assert.equal(rolledBack.buildSessionContext().messages.length, 2);
    assert.notDeepEqual(rolledBack.buildSessionContext(), forked.buildSessionContext());
    console.log(JSON.stringify({reproduced:true,stockVersion:version,unchangedPathContinues:true,movedPathSilentlyStartsEmpty:true,explicitPathStillUsesOldCwd:true,sdkCwdOverrideDoesNotPersist:true,stockForkPreservesContextAndEntries:true,defaultForkUsesNewPiId:true,chosenUuidForkAlsoSupported:true,originalJournalUnmodified:true,postMoveTurnContinues:true,bareRollbackSelectsStaleOriginal:true,providerCalls:0}));
} finally {
    rmSync(root, {recursive:true,force:true});
}
