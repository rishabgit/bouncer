// Fixed text corpus for the latency benchmark. Original synthetic posts (not
// scraped) so the inputs are stable and shareable. Text-only by design — the
// head-to-head is Qwen 3.5 vs Gemma, both text-only.

export interface CorpusPost {
  id: 'short' | 'medium' | 'long';
  label: string;
  text: string;
}

// Short ≈ a typical tweet.
const SHORT = `Finally swapped my morning doomscroll for a 20-minute walk and honestly my brain feels less like soup. small wins.`;

// Medium ≈ a chunky multi-sentence post. Used as the shared midpoint cell.
const MEDIUM = `Spent the weekend rebuilding my desk setup from scratch. Moved the monitor up on a riser, ran the cables through a tray underneath, and finally ditched the second screen I never actually used. The big surprise was how much the clutter on the desk was quietly stressing me out — clearing it made focusing way easier on Monday morning. If you have been putting off a cleanup, this is your sign. Took maybe three hours total and cost almost nothing since I reused what I had lying around.`;

// Long ≈ deliberately oversized so it exceeds the ~1024-token context budget
// and exercises the truncateText path (prefill plateaus at the cap). One
// rambling first-person thread, repeated thematically to fill the budget.
const LONG = [
  `Okay, long post incoming, but I promised I would write up how the whole apartment-move actually went because so many of you asked and the short version genuinely does not do it justice.`,
  `We started planning roughly two months out, which everyone told me was overkill, and which turned out to be exactly right. The first thing we did was go room by room with a notebook and write down every single thing we owned that we actually used in the last year. Anything we could not remember using went into a maybe pile, and the maybe pile became the donate pile about a week later once the guilt wore off.`,
  `The packing itself was the part I dreaded and it was, predictably, the worst. Books are deceptively heavy and you will always underestimate how many boxes you need. Buy more tape than you think. Label the sides of the boxes, not the tops, because once they are stacked you cannot read the tops. Color-code by room if you can; we used cheap colored stickers and it saved us probably an hour on the other end when the movers were asking where everything went.`,
  `Moving day was chaos but a manageable kind of chaos. We booked the elevator in our old building for a two-hour window in the morning and that pressure actually kept us moving fast. The movers were great, although one of them kept trying to convince me that my couch would not fit through the new doorway, and reader, it did, with about a centimeter to spare and a lot of held breath.`,
  `The thing nobody warns you about is the first night in a new place. Nothing is where it should be, you cannot find the box with the bedsheets, and the light switches are all in the wrong spots so you keep slapping the wall in the dark. We ordered food, sat on the floor, and just kind of laughed about it. That part I would not trade.`,
  `Unpacking took another full week of evenings. My advice: do the kitchen and the bedroom first, because if you can cook and sleep, everything else can wait. The living room stayed a maze of boxes for ten days and the world did not end.`,
  `Anyway, two months in now and it finally feels like home. The light in the mornings is incredible, the neighbors are friendly, and I have a tiny balcony where I have already managed to keep two plants alive, which for me is a personal record. Would I do it again soon? Absolutely not. Am I glad we did it? Completely. If you are on the fence about a move, my honest take is that the dread is always bigger than the reality, and the reality is mostly just a lot of boxes and a few good stories.`,
].join(' ');

export const POSTS: Record<CorpusPost['id'], CorpusPost> = {
  short: { id: 'short', label: 'Short (~tweet)', text: SHORT },
  medium: { id: 'medium', label: 'Medium', text: MEDIUM },
  long: { id: 'long', label: 'Long (truncation-bound)', text: LONG },
};

// Ordered pool of realistic filter topics. The filter-count sweep slices the
// first N, so order is stable across runs.
export const CATEGORY_POOL = [
  'crypto',
  'politics',
  'engagement bait',
  'sports',
  'ai hype',
  'celebrity gossip',
  'self-promotion',
  'food',
  'fitness',
  'drama',
];

// Filter counts swept (Gemma's output budget = max(20, 6 + 4·N); Qwen's output
// is fixed but its prefill/TTFT still grows with the list).
export const FILTER_COUNTS = [1, 3, 5, 10];

export function categories(n: number): string[] {
  return CATEGORY_POOL.slice(0, n);
}
