// QA-11 / SHE-79: phone-grade 44px touch targets.
//
// At phone width every interactive header/composer control must offer a
// ≥44px-tall tap area. The audited visual system stays untouched: composer
// buttons (freestanding circles) grow to a real 44px; in the header the chat
// title keeps its visual size and gets an invisible ::after overlay extending
// its hit area, and the column's rows are 44px or more (cockpit map, U7).
//
// Verified live at 390px and 320px via elementFromPoint probing (all hit
// areas ≥44px tall, zero horizontal overflow). This source contract pins the
// CSS so the rules can't silently regress — e.g. the earlier "full-size touch
// targets" mobile rule that actually SHRANK attach/mic from 42px to 40px.
//
// Run: node --test computer/ai-chat/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'styles.css'),
    'utf8',
);

// The whole ≤480px media block (ends where the ≤360px block begins).
function mobileBlock() {
    const start = css.indexOf('@media (max-width: 480px)');
    const end = css.indexOf('@media (max-width: 360px)');
    assert.ok(start !== -1 && end > start, 'mobile media blocks not found in styles.css');
    return css.slice(start, end);
}

test('composer controls are a real 44px at phone width', () => {
    const block = mobileBlock();
    // Every composer control, not a fixed list: a button added to the composer
    // has to join this rule or it ships at 42px on a phone.
    const rule = block.match(/\.btn-attach,[^{]*\.btn-send\s*\{[^}]*\}/);
    for (const cls of ['.btn-attach', '.btn-mic', '.btn-audio-reply', '.btn-send']) {
        assert.ok(rule && rule[0].includes(cls), `${cls} must be in the composer touch-target rule`);
    }
    assert.ok(rule, 'combined composer touch-target rule missing from the 480px block');
    assert.match(rule[0], /width:\s*44px/, 'composer buttons must be 44px wide');
    assert.match(rule[0], /height:\s*44px/, 'composer buttons must be 44px tall');
});

test('the old 40px composer shrink must not come back', () => {
    assert.ok(
        !/\.btn-attach,\s*\.btn-mic\s*\{[^}]*40px/.test(mobileBlock()),
        'a mobile rule shrinks attach/mic below their 42px desktop size again',
    );
});

test('daily header and column controls are at least 44px on a phone (U7)', () => {
    const pj = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'projects.css'), 'utf8');
    const phone = pj.slice(pj.indexOf('@media (max-width: 720px)'));
    // The chat title is the way back to the chats: its hit area is 44px tall
    // even though the title's own line is shorter.
    assert.match(phone, /\.pj-title::after \{[^}]*height: 44px;/);
    assert.match(phone, /\.pj-back, html\.pj-side-shut \.pj-back \{[^}]*width: 40px; height: 48px;/);
    assert.match(phone, /\.quota-meter \{ height: 44px; min-width: 40px;/);
    // The column: a chat row, starting an agent, opening a folder, the tools row.
    assert.match(phone, /\.pj-ag \{ height: 46px; \}/);
    assert.match(phone, /\.pj-new, \.pj-add, \.pj-older \{ height: 44px;/);
    assert.match(phone, /\.pj-jump-btn \{ height: 44px;/);
    assert.match(phone, /\.pj-tool \{[^}]*min-height: 48px;/);
    assert.match(phone, /\.actions-item, \.chat-menu \.actions-item \{[^}]*min-height: 48px;/);
});
