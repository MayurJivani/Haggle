// News written from what the market itself did (a SimNote), not from a template chosen in advance.
// Every claim in a story is a fact about the simulation at that tick: the size of the fall, the credit
// spread, whether the sector had run ahead of its earnings. Nothing is said about what happens next.
import type { Category, Figure, Scope } from './events.js';
import type { SimNote } from './sim.js';

export interface NoteStory {
  template: string;
  category: Category;
  scope: Scope;
  target: string | null;
  related: string[];
  headline: string;
  body: string;
  figures: Figure[];
  severity: 1 | 2 | 3;
}

const KINDS: SimNote['kind'][] = ['sector-crash', 'panic', 'recession', 'recovery', 'credit-tight', 'credit-easy'];

/**
 * A durable id for a note: negative, so it can never meet a scheduled story's serial id, and derived
 * from the tick and the note (sector notes by sector), so a replay after a restart produces the same id
 * and the story is stored and shown once.
 */
export function noteId(note: SimNote, sectorIndex: number): number {
  const slot = note.kind === 'sector-crash' ? sectorIndex : 16 + KINDS.indexOf(note.kind);
  return -(note.seq * 32 + slot);
}

const pct = (logMove: number) => `${Math.round(Math.abs(Math.expm1(logMove)) * 100)}%`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function noteStory(note: SimNote, credit: number): NoteStory {
  const spread = `${credit.toFixed(1)} points`;
  switch (note.kind) {
    case 'sector-crash': {
      const ranAhead = note.heat > 0.05;
      return {
        template: `sim:${note.kind}`, category: 'sector', scope: 'sector', target: note.sector, related: note.tickers,
        headline: ranAhead
          ? `${note.sector} shares slump as stretched valuations unwind`
          : `A wave of selling hits ${note.sector}`,
        body: ranAhead
          ? `The sector had run well ahead of its earnings, about ${pct(note.heat)} above what its reported numbers support. Today's fall of around ${pct(note.size)} at the outset hit ${list(note.tickers)} hardest.`
          : `${note.sector} companies fell around ${pct(note.size)} at the outset with no single trigger; ${list(note.tickers)} were hit hardest.`,
        figures: [{ label: 'Initial fall', value: `about ${pct(note.size)}` }, ...(ranAhead ? [{ label: 'Premium before', value: `about ${pct(note.heat)}` }] : [])],
        severity: Math.abs(note.size) > 0.15 ? 3 : 2,
      };
    }
    case 'panic':
      return {
        template: `sim:${note.kind}`, category: 'macro', scope: 'market', target: null, related: note.tickers,
        headline: 'Panic selling sweeps the market',
        body: `Investors sold across every sector at once. Volatility jumped and corporate credit spreads widened to ${spread}. Smaller and more indebted companies fell hardest, including ${list(note.tickers)}.`,
        figures: [{ label: 'Initial fall', value: `about ${pct(note.size)} for an average stock` }, { label: 'Credit spread', value: spread }],
        severity: 3,
      };
    case 'recession':
      return {
        template: `sim:${note.kind}`, category: 'macro', scope: 'factor', target: 'growth', related: [],
        headline: 'Economic data confirm the economy is shrinking',
        body: `Output and hiring have fallen for months. Demand is weakening for companies tied to the business cycle, earnings expectations are being cut, and credit spreads stand at ${spread}.`,
        figures: [{ label: 'Credit spread', value: spread }],
        severity: 2,
      };
    case 'recovery':
      return {
        template: `sim:${note.kind}`, category: 'macro', scope: 'factor', target: 'growth', related: [],
        headline: 'The economy is growing again',
        body: `Output and hiring have picked up for months after the downturn. Credit spreads stand at ${spread}.`,
        figures: [{ label: 'Credit spread', value: spread }],
        severity: 1,
      };
    case 'credit-tight':
      return {
        template: `sim:${note.kind}`, category: 'macro', scope: 'factor', target: 'credit', related: [],
        headline: `Borrowing costs jump: corporate credit spreads widen to ${spread}`,
        body: 'Lenders are demanding more to fund companies. Banks and smaller or heavily indebted firms are the most exposed to tighter credit.',
        figures: [{ label: 'Credit spread', value: spread }],
        severity: 2,
      };
    case 'credit-easy':
      return {
        template: `sim:${note.kind}`, category: 'macro', scope: 'factor', target: 'credit', related: [],
        headline: `Credit conditions ease as spreads narrow to ${spread}`,
        body: 'Lenders are competing to fund companies again, and borrowing costs have come down.',
        figures: [{ label: 'Credit spread', value: spread }],
        severity: 1,
      };
  }
}
