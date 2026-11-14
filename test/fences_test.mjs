import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({URL});
vm.runInContext(readFileSync(new URL('../src/ui/history-view.js', import.meta.url), 'utf8'), context);
const parts = text => JSON.parse(JSON.stringify(context.LimilinkHistory.fenceParts(text)));

test('four backticks contain triple-backtick Markdown verbatim', () => {
    const body = 'markdown\n# Example\n```js\nconsole.log("hi");\n```\n[not a link](/literal)\n';
    assert.deepEqual(parts('Before\n````' + body + '````\nAfter'), [
        {text:'Before\n'}, {text:body,code:true}, {text:'After'},
    ]);
});

test('only a same-character, sufficiently long, bare fence closes a block', () => {
    const body = 'text\n```\n~~~\n````not a closer\nkeep this\n';
    assert.deepEqual(parts('````' + body + '`````\n'), [{text:body,code:true}]);
    assert.deepEqual(parts('~~~~markdown\n```\n~~~\n~~~~~\n'), [{text:'markdown\n```\n~~~\n',code:true}]);
});

test('adjacent fences, indentation, CRLF and prose are preserved', () => {
    assert.deepEqual(parts('Intro\r\n  ```py\r\nx\r\n\t```\r\n~~~\ny\n~~~\nEnd'), [
        {text:'Intro\r\n'}, {text:'py\r\nx\r\n',code:true}, {text:'\ny\n',code:true}, {text:'End'},
    ]);
    assert.deepEqual(parts('```\n```'), [{text:'\n',code:true}]);
});

test('unclosed fences remain literal, including nested links and shorter fences', () => {
    for (const run of ['````','~~~~']) {
        const unfinished = run + 'markdown\n```\n[no](/no)\n```';
        assert.deepEqual(parts('Before\n'+unfinished), [{text:'Before\n'}, {text:unfinished,literal:true}]);
    }
});

test('inline backticks and non-fence prose do not become blocks', () => {
    for (const text of ['Use ```inline``` here', '`inline`', '\\```escaped\ntext', '```bad`info\ntext', 'plain']) {
        assert.deepEqual(parts(text), [{text}]);
    }
});

test('large fence runs and many shorter nested runs are handled without recursion', () => {
    const run = '`'.repeat(30000), body = 'markdown\n' + '```\n'.repeat(20000);
    assert.deepEqual(parts(run + body + run), [{text:body,code:true}]);
});
