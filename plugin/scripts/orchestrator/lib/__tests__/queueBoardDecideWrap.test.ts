// Phone width: a decision card's answer buttons take the full row there, so a long label such as
// "Answer, and prepare a new round (recommended)" must wrap inside the button instead of running past the card's edge.
// board.css is read as text (comments stripped), like the other board CSS tests.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of every `.decide-options .button { ... }` rule inside a max-width: 720px media block. */
function phoneOptionRules(): string[] {
  const out: string[] = [];
  const media = /@media \(max-width: 720px\) \{/g;
  let m: RegExpExecArray | null;
  while ((m = media.exec(css))) {
    // Walk braces to find the end of this media block.
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    const block = css.slice(m.index + m[0].length, i - 1);
    for (const r of block.matchAll(/\.decide-options \.button \{([^}]*)\}/g)) out.push(r[1]);
  }
  return out;
}

describe('decision answer buttons at phone width', () => {
  it('wrap a long label inside the button and never grow past the card', () => {
    const rules = phoneOptionRules();
    expect(rules.length).toBeGreaterThan(0);
    const body = rules.join('\n');
    expect(body).toMatch(/white-space:\s*normal/);
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/text-align:\s*left/);
  });
});
