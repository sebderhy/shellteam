// QA-11 / SHE-79: phone-grade 44px touch targets.
//
// At phone width every interactive header/composer control must offer a
// ≥44px-tall tap area. The audited visual system stays untouched: composer
// buttons (freestanding circles) grow to a real 44px, while header controls
// keep their visual size and get an invisible ::after overlay extending the
// hit area — width capped at half the tightest inter-control gap (6px) per
// side so adjacent targets never overlap.
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
    const rule = block.match(/\.btn-attach,\s*\.btn-mic,\s*\.btn-send\s*\{[^}]*\}/);
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

test('header controls carry the 44px hit-area overlay at phone width', () => {
    const block = mobileBlock();
    const overlay = block.match(
        /\.conv-switcher::after,\s*\.quota-meter::after,\s*\.btn-ai::after,\s*\.btn-icon::after\s*\{[^}]*\}/,
    );
    assert.ok(overlay, 'header hit-area overlay rule missing from the 480px block');
    assert.match(overlay[0], /height:\s*44px/, 'overlay must extend the tap area to 44px tall');
    // Horizontal growth is half the 6px right-cluster gap per side: any more
    // makes adjacent header targets overlap and taps in the gap ambiguous.
    assert.match(overlay[0], /left:\s*-3px;\s*right:\s*-3px/,
        'overlay growth must stay at 3px per side — half the tightest gap');
    // And the overlay only works if the controls establish a positioning context.
    assert.match(block, /\.conv-switcher,\s*\.quota-meter,\s*\.btn-ai,\s*\.btn-icon\s*\{\s*position:\s*relative/,
        'overlay targets must be position: relative inside the 480px block');
});

test('the switcher/meter overlays cannot overlap even when their boxes touch', () => {
    // The switcher is flex:1 and can abut the subscription meter at 320px
    // (release-audit P2-03): the switcher must not grow horizontally at all,
    // and the meter must grow only to its RIGHT (toward its real 6px gap).
    const block = mobileBlock();
    assert.match(block, /\.conv-switcher::after\s*\{\s*left:\s*0;\s*right:\s*0;?\s*\}/,
        'the conversation switcher overlay must not extend horizontally');
    assert.match(block, /\.quota-meter::after\s*\{\s*left:\s*0;?\s*\}/,
        'the subscription meter overlay must not extend toward the switcher');
});
