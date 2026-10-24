import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL('../src/ui/history-view.js', import.meta.url), 'utf8'), context);
const parts = text => JSON.parse(JSON.stringify(context.LimilinkHistory.linkParts(text, 'https://chat.example/app/')));
const links = text => parts(text).filter(part => part.href);

for (const [source, label, href] of [
    ['[Preview](/example)', 'Preview', 'https://chat.example/example'],
    ['[next](../older?q=one&two=2#result)', 'next', 'https://chat.example/older?q=one&two=2#result'],
    ['[fragment](#chat-container)', 'fragment', 'https://chat.example/app/#chat-container'],
    ['[HTTP](http://example.invalid/)', 'HTTP', 'http://example.invalid/'],
    ['<https://example.invalid/a?x=1&y=2>', 'https://example.invalid/a?x=1&y=2', 'https://example.invalid/a?x=1&y=2'],
    ['<HTTP://example.invalid/>', 'HTTP://example.invalid/', 'http://example.invalid/'],
    ['[wiki](https://example.invalid/wiki/Thing_(part))', 'wiki', 'https://example.invalid/wiki/Thing_(part)'],
    ['[a [literal] label](https://example.invalid/)', 'a [literal] label', 'https://example.invalid/'],
    ['[angle](<https://example.invalid/unmatched(>)', 'angle', 'https://example.invalid/unmatched('],
    ['[日本語](https://example.invalid/道)', '日本語', 'https://example.invalid/%E9%81%93'],
]) test('recognizes ' + source, () => assert.deepEqual(links(source), [{ text: label, href }]));

test('surrounding text and adjacent links are not lost', () => {
    assert.deepEqual(parts('Before [one](/one)<http://example.invalid/> after'), [
        { text: 'Before ' }, { text: 'one', href: 'https://chat.example/one' },
        { text: 'http://example.invalid/', href: 'http://example.invalid/' }, { text: ' after' },
    ]);
});

for (const source of [
    '[script](javascript:alert(1))', '[mixed](JaVaScRiPt:alert(1))',
    '[data](data:text/html,<script>alert(1)</script>)', '[file](file:///etc/passwd)',
    '[script](vbscript:run)', '[custom](custom:thing)', '[mail](mailto:test@example.invalid)',
    '[control](java\tscript:alert(1))', '[control](https://example.invalid/\u0000x)',
    '[newline](\nhttps://example.invalid/)', '[space](https://example.invalid/a b)',
    '[title](https://example.invalid/ "unsupported title")', '[padding]( /relative )',
    String.raw`[escape](https://example.invalid/a\b)`,
    '<https://example.invalid/a b>', '<javascript:alert(1)>',
    'https://example.invalid/plain', '<img src=x onerror=alert(1)>',
    '![image](https://example.invalid/image.png)', '![<https://example.invalid/>](/image)',
    '[[inner](https://example.invalid/)](javascript:alert(1))',
    String.raw`\[literal](https://example.invalid/)`, String.raw`\<https://example.invalid/>`,
    '`[code](/path)`', '``<https://example.invalid/>``',
    '```unfinished\n[label](/path) <https://example.invalid/>',
    '[missing](https://example.invalid/', '[missing] text', '[](/empty)',
    '[multi\nline](/path)', '[reference][name]',
]) test('keeps unsupported/unsafe/literal text: ' + JSON.stringify(source), () => {
    assert.equal(links(source).length, 0);
    assert.deepEqual(parts(source), [{ text: source }]);
});

test('even escape parity permits links, without decoding source escapes', () => {
    assert.equal(links(String.raw`\\[active](/path)`).length, 1);
    assert.equal(links(String.raw`\\<https://example.invalid/>`).length, 1);
});

test('code delimiters of different lengths and links outside a code span', () => {
    assert.deepEqual(links('``one ` [literal](/no)`` [yes](/yes)'), [{ text: 'yes', href: 'https://chat.example/yes' }]);
});

test('rejected outer candidates cannot activate nested labels or destination autolinks', () => {
    assert.deepEqual(links('[[inner](/no)](data:bad) <https://example.invalid/yes>'), [
        { text: 'https://example.invalid/yes', href: 'https://example.invalid/yes' },
    ]);
});

test('large malformed delimiter inputs terminate without recursion or overlapping retries', () => {
    for (const source of [
        '['.repeat(30000) + 'label' + ']'.repeat(30000) + '(javascript:alert(1))',
        '<'.repeat(30000) + 'http://example.invalid/',
        '[x](javascript:' + '[x]('.repeat(15000) + ')'.repeat(15001),
        '`'.repeat(30000) + '[literal](/path)',
    ]) assert.equal(links(source).length, 0);
});
