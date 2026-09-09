// QA-05: the composer's icon-only controls must carry accessible names.
// Chromium exposed the Send button as an unnamed `button` (WCAG 4.1.2) — the
// SVG glyph contributes no text, so without aria-label a screen reader
// announces nothing. Pins every icon-only composer control, not just Send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html'),
    'utf8',
);

const CONTROLS = [
    { cls: 'btn-send', label: 'Send message' },
    { cls: 'btn-attach', label: 'Attach file' },
    { cls: 'btn-mic', label: 'Voice message' },
];

function openingTag(cls) {
    const match = html.match(new RegExp(`<button[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`));
    assert.ok(match, `composer control .${cls} not found in index.html`);
    return match[0];
}

test('every icon-only composer control has an accessible name', () => {
    for (const { cls, label } of CONTROLS) {
        const tag = openingTag(cls);
        assert.match(
            tag,
            new RegExp(`aria-label="${label}"`),
            `.${cls} must carry aria-label="${label}" — its SVG glyph gives a screen reader nothing to announce`,
        );
    }
});

test('composer controls are type=button so they never submit an enclosing form', () => {
    for (const { cls } of CONTROLS) {
        assert.match(openingTag(cls), /type="button"/, `.${cls} missing type="button"`);
    }
});
