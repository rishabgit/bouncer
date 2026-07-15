// Fixed labeled corpus for the dev-only accuracy eval. Original synthetic posts
// (not scraped), short and colloquial like real tweets, so the inputs are stable
// and shareable. Text-only by design, matching the production Gemma path.
//
// One filter, held constant across every example: "rage bait". The positive
// class is "should hide". Positives are posts engineered to FARM OUTRAGE —
// share/RT/QT imperatives, pile-ons, manufactured "you won't believe",
// inflammatory bait. Sincere anger, fair criticism, personal venting, and CALM
// doomerism are deliberately NON-matches; that boundary is the whole point of
// the eval. Each ambiguous negative is a near-twin of a positive so the test
// isolates rage-bait *intent* from mere negativity — e.g. a7's calm "it's all
// winding down" (allow) vs p11's weaponized doom (hide). Positives span loud
// share/RT/QT/tag bait AND quieter CTA-light contempt bait (p10) so a model can't
// pass just by keying on caps + an explicit call to action.
//
// No slurs / no protected-class hate: "they/them" in the positives is left
// intentionally vague so we probe the *structure* of outrage farming, not a hate
// target (such content is both unwanted in-repo and trivially easy → no signal).

import type { LocalPromptMode } from './prompts';

export interface EvalPost {
  id: string;
  // pos      → rage bait, should hide (the positive class)
  // neg-easy → obviously fine, should allow (easy anchor)
  // neg-amb  → negativity/anger present but NOT rage bait, should allow (the trap)
  kind: 'pos' | 'neg-easy' | 'neg-amb';
  text: string;
}

// Single source of truth for the gold label: only rage bait should be hidden.
export function expectsHide(post: EvalPost): boolean {
  return post.kind === 'pos';
}

export interface EvalVariant {
  id: 'baseline' | 'filter-outrage-farming' | 'prompt-intent' | 'combined-intent-outrage-farming';
  label: string;
  filters: string[];
  promptMode: LocalPromptMode;
  description: string;
}

export const EVAL_VARIANTS: EvalVariant[] = [
  {
    id: 'baseline',
    label: 'Baseline',
    filters: ['rage bait'],
    promptMode: 'baseline',
    description: 'Current shipped prompts with the current rage bait filter wording.',
  },
  {
    id: 'filter-outrage-farming',
    label: 'Filter wording: outrage farming',
    filters: ['outrage farming'],
    promptMode: 'baseline',
    description: 'Current shipped prompts with a narrower filter phrase.',
  },
  {
    id: 'prompt-intent',
    label: 'Intent prompt',
    filters: ['rage bait'],
    promptMode: 'intent',
    description: 'Intent-aware dev prompt with the current filter phrase.',
  },
  {
    id: 'combined-intent-outrage-farming',
    label: 'Intent prompt + outrage farming',
    filters: ['outrage farming'],
    promptMode: 'intent',
    description: 'Intent-aware dev prompt with the narrower filter phrase.',
  },
];

// Compatibility alias for baseline callers and docs.
export const EVAL_FILTERS = EVAL_VARIANTS[0].filters;

export const EVAL_POSTS: EvalPost[] = [
  // --- Positives: rage bait / outrage farming (should hide) ---
  { id: 'p1', kind: 'pos', text: `absolutely DISGUSTING that this is still allowed in 2026. everyone involved should be ashamed. RT until they answer for it.` },
  { id: 'p2', kind: 'pos', text: `of course the same crowd is defending this again. you literally cannot make this up. wake up people 🤡` },
  { id: 'p3', kind: 'pos', text: `unpopular opinion: anyone who disagrees with me on this is genuinely a bad person. QT me with your worst takes, i'll wait 🔥` },
  { id: 'p4', kind: 'pos', text: `let's make this guy famous everyone 👇 read what he posted and tell me you're not furious. the internet never forgets.` },
  { id: 'p5', kind: 'pos', text: `you will NOT believe what this company just did to its own workers. this should make your blood boil 🧵 (1/12)` },
  { id: 'p6', kind: 'pos', text: `imagine being this entitled. they expect the rest of us to just sit down and take it?? absolutely not. who's with me??` },
  { id: 'p7', kind: 'pos', text: `dumbest thing i've read all year and it has 10k likes. tells you everything about where society's headed. ratio him into the ground.` },
  { id: 'p8', kind: 'pos', text: `they're laughing while they rob you blind and you're STILL defending them. when do people finally wake up and get angry??` },
  { id: 'p9', kind: 'pos', text: `why is NO ONE talking about this?? they're praying you stay quiet. don't give them that. make it loud, share everywhere 🔁` },
  { id: 'p10', kind: 'pos', text: `imagine still defending landlords in this economy 🤡 if that upsets you, good — stay mad and keep proving the point.` },
  { id: 'p11', kind: 'pos', text: `we're genuinely cooked and half of you are still pretending everything's fine 🙃 some of us saw this coming — tag someone who's still in denial.` },
  { id: 'p12', kind: 'pos', text: `they're counting on everyone scrolling past this. don't. repost until the board has to answer.` },
  { id: 'p13', kind: 'pos', text: `look at this decision and tell me the defenders aren't part of the problem. tag someone still making excuses.` },
  { id: 'p14', kind: 'pos', text: `friendly reminder: if you're okay with this policy, you're helping it happen. quote this with receipts.` },
  { id: 'p15', kind: 'pos', text: `another company quietly broke the promise they made last month. save the screenshots before they disappear.` },
  { id: 'p16', kind: 'pos', text: `i'm done pretending this is normal. every defender in the replies deserves the ratio they're getting.` },
  { id: 'p17', kind: 'pos', text: `notice how they dropped this on a friday? they know you'll stay quiet. prove them wrong.` },
  { id: 'p18', kind: 'pos', text: `some people will excuse anything if the right logo is attached. bookmark this when they deny it later.` },

  // --- Easy negatives: obviously fine (should allow) ---
  { id: 'e1', kind: 'neg-easy', text: `what a game last night, that overtime winner was unreal. still buzzing ⚽ on to the playoffs!` },
  { id: 'e2', kind: 'neg-easy', text: `finally — city council passed the transit budget today, three new bus lines on the east side by spring. about time.` },
  { id: 'e3', kind: 'neg-easy', text: `sixth try and the sourdough finally rose properly!! look at this crumb 🍞 absurdly proud of myself.` },
  { id: 'e4', kind: 'neg-easy', text: `rainy sunday, good coffee, cat asleep on my lap, nowhere to be. this is the good stuff.` },

  // --- Ambiguous negatives: anger/criticism present but NOT rage bait (should allow) ---
  { id: 'a1', kind: 'neg-amb', text: `refs were rough tonight. that blown call in the 4th genuinely cost us the game, gutted to lose like that.` },
  { id: 'a2', kind: 'neg-amb', text: `i think the new policy's a mistake — the projected costs just don't add up to me, so i'm voting no.` },
  { id: 'a3', kind: 'neg-amb', text: `third night this week up with a sick toddler. completely running on fumes. someone please send coffee ☕` },
  { id: 'a4', kind: 'neg-amb', text: `40 applications, 40 rejections. at this point i'm just collecting them like trading cards 😂 send help` },
  { id: 'a5', kind: 'neg-amb', text: `oh GREAT, another update that moved every single button. love relearning my own phone every two weeks 🙃` },
  { id: 'a6', kind: 'neg-amb', text: `two stars. food came out cold and we waited an hour. staff were lovely but i won't be back.` },
  { id: 'a7', kind: 'neg-amb', text: `some days it really does feel like nothing we do matters and it's all just winding down, you know? anyway. more tea.` },
  { id: 'a8', kind: 'neg-amb', text: `three hours on hold with insurance just to be told to call back tomorrow. so unbelievably tired of this.` },
  { id: 'a9', kind: 'neg-amb', text: `i disagree with the proposal; the staffing numbers are off and the timeline feels rushed. i'll send comments before friday.` },
  { id: 'a10', kind: 'neg-amb', text: `the portal crashed after 45 minutes and i lost the form. too tired to be mad, just want it fixed.` },
  { id: 'a11', kind: 'neg-amb', text: `genuinely annoyed that the app moved settings again, but the redesign has some nice parts too.` },
  { id: 'a12', kind: 'neg-amb', text: `our flight got canceled after four delays. frustrated, heading home and trying again tomorrow.` },
  { id: 'a13', kind: 'neg-amb', text: `please email the board if you rely on the late bus; public comments close tonight.` },
  { id: 'a14', kind: 'neg-amb', text: `i don't like the company's refund decision, but support was polite and the policy is at least clear.` },
  { id: 'a15', kind: 'neg-amb', text: `that headline is doing too much. the actual report is more boring, but still worth reading.` },
  { id: 'a16', kind: 'neg-amb', text: `rough week for the team. the mistakes are obvious, but piling on after the whistle doesn't help.` },
  { id: 'a17', kind: 'neg-amb', text: `i'm worried this plan leaves renters with fewer options. hope the council explains the tradeoffs clearly.` },
  { id: 'a18', kind: 'neg-amb', text: `another surprise bill from the clinic. i'm exhausted, making tea, and calling them in the morning.` },
];
