// Dev-only inputs for a native Ollama / LiteRT-LM comparison.
//
// These posts and the multi-filter labels were newly authored synthetic material
// for this experiment, before any inference results were inspected. They are
// not the owner's established rage-bait corpus in eval-corpus.ts and must be
// reported separately from that corpus. Boundary cases favor explicit topic
// definitions over subtle intent; they do not represent real-feed prevalence.
// The parent comparison review audits these labels independently before inference.
//
// Timed requests use different post content near the beginning, rather than a
// repeated post with an appended identifier. A runtime may reuse the common
// system/filter prefix, but cannot reuse an entire preceding identical post.

interface LongPostSeed {
  opening: string;
  project: string;
  detail: string;
  obstacle: string;
  result: string;
}

// Deterministic, post-like long-form narratives. The scenario changes in the
// opening and throughout the body. Every rendered post exceeds 3,000 characters
// so the production context budget exercises truncation; the runner must still
// measure and report the actual retained token count for each backend.
function longPost(seed: LongPostSeed): string {
  return `${seed.opening}

I wanted to write down the whole process of ${seed.project}, because the short version makes it sound much tidier than it felt. ${seed.detail} At the beginning I thought the main task would be choosing a plan and following it. In practice, most of the work was noticing small things that the plan had left out. I kept a paper notebook nearby, gave each trial its own page, and recorded what I changed before deciding whether the change had helped. This is a personal project diary about an invented afternoon, not a recommendation for a product or a service.

The first attempt at ${seed.project} was deliberately small. I cleared a flat surface, arranged the materials where I could see them, and wrote down what a useful result would look like. Then I worked slowly enough to stop after each stage. That sounds obvious, but I usually discover the missing step only after I have already moved on. This time I left a little space between steps so I could compare the new state with the previous one. ${seed.detail} Keeping those concrete details in view helped me avoid changing three things at once and then guessing which one mattered.

About halfway through, the simple version of ${seed.project} met its first complication. ${seed.obstacle} I was tempted to start again immediately, but a restart would have erased the evidence of what went wrong. Instead I marked the troublesome part in the notebook, took a break, and described it in plain words. I separated what I had actually observed from what I merely suspected. The difference was useful: an observation could guide the next attempt, while a suspicion needed another check. Nothing dramatic happened during that pause. It was just enough time to let the original idea loosen its grip.

For the next attempt, I kept the parts of ${seed.project} that were working and changed only the step connected to the obstacle. I put the old and new versions beside each other, rather than relying on my memory of the first one. ${seed.obstacle} Looking at both versions made the tradeoff clearer. The revised approach took a little longer at the start, but I spent less time correcting it afterward. I made a note of that distinction because a method that feels fast during the first minute can still be slow over the whole afternoon. The notebook now had enough detail that another person could understand the sequence without watching me work.

I also tried to make ${seed.project} comfortable to return to. The useful materials went into a shallow tray, the unfinished piece stayed separate from the finished example, and the notes described the next action instead of simply saying that more work remained. ${seed.detail} I learned that a clear stopping point matters as much as a clear beginning. If I leave everything in a pile, the next session starts with a small investigation into my own intentions. If I leave one precise next step, I can start calmly and spend my attention on the project itself. This is a modest difference, but it changed the mood of the work.

By the end of the session, ${seed.result} The result was not perfectly polished, and I am glad I did not pretend that it was. I could point to the part that improved, the part that remained awkward, and the part that needed a different tool or a fresh attempt. For ${seed.project}, that was more useful than announcing that the whole thing had been a success. I copied the short list of remaining tasks onto a clean page, kept the earlier pages as a record of the attempts, and put the materials away in the order I would need them again. The project felt small enough to continue, which was the real aim of the afternoon.

One thing I would repeat is the habit of making the evidence visible. ${seed.detail} A visible comparison prevented me from confusing confidence with progress. One thing I would change is the size of the first attempt: I would make it even smaller, so the difficulty would be easier to notice before it affected the rest of the work. The earlier observation was concrete: ${seed.obstacle} That does not mean every hobby needs a formal process. It means that a few ordinary notes can save a surprising amount of frustration when the activity has several dependent steps and the outcome takes time to appear.

My next session with ${seed.project} will start from the clean page of remaining tasks. I will keep the working example nearby, repeat the useful adjustment, and leave the uncertain part open until I have a direct observation. ${seed.result} For now, I have a practical record of what happened, a better sense of which details deserve attention, and a place to stop. Writing this long account is partly a way to remember the sequence and partly a reminder that an ordinary project can be satisfying without becoming a grand lesson about everything else.`;
}

export const NATIVE_LATENCY_POSTS: Record<'short' | 'medium' | 'long', string[]> = {
  short: [
    'The pottery shelf finally dried overnight. I moved the blue bowl beside the window, and the tiny uneven rim looks much better in morning light.',
    'A quiet train ride gave me time to finish the last chapter of my library book. The ending was gentle, and I kept thinking about it on the walk home.',
    'My tomato seedlings grew two new leaves this week. I rotated the tray toward the light and made a small pencil mark to compare their height tomorrow.',
    'I repaired the loose hinge on a wooden box this afternoon. The lid now closes smoothly, and the repair took less time than hunting for the right screw.',
    'The park fountain was switched off today, so the square sounded different. I could hear the leaves moving and someone sweeping the far end of the path.',
    'A loaf cooled on the counter while I washed the mixing bowl. The crust made little cracking sounds, and the kitchen smelled warm long after the oven stopped.',
    'I sorted a drawer of old pencils by softness instead of color. Finding the one I need for a sketch is easier now, even if the drawer looks less cheerful.',
    'The rain ended just before my evening walk. Every bench was still wet, but the pavement reflected the lamps and the air felt cooler than it had all day.',
    'I practiced a slow scale on the small keyboard for fifteen minutes. The tricky transition felt smoother when I stopped watching my hands and listened instead.',
    'A paper map helped me notice a footpath I usually miss. It loops behind the community garden and reaches the same street with a much quieter final stretch.',
    'The rice cooker clicked off while I chopped a cucumber. I mixed a simple dressing, opened the window, and ate dinner before the room became too warm.',
    'I rewove the loose corner of a basket with a spare reed. The patch is visible, but it holds firmly and gives the old basket a slightly different shape.',
    'A moth rested on the outside of the window this morning. I watched it fold its wings, then left the curtain open until it flew away into the shade.',
    'The new notebook has thicker paper than the last one. My pen no longer shows through, so I can use both sides without a ghost of yesterday underneath.',
    'I changed the order of the books on the low shelf. Tall volumes now sit at the ends, leaving a clear space in the middle for the small reading lamp.',
    'The elevator stopped for a routine check, so I took the stairs. Someone had placed a little plant on the landing, where a narrow window catches the afternoon sun.',
    'A soft brush removed the dust from the camera strap without damaging the stitching. I put the brush in the same pouch so I can find it next time.',
    'I folded a paper crane from a scrap of wrapping paper. One wing ended up wider than the other, but it balances nicely beside the jar of spare buttons.',
    'The neighborhood clock rang while I was crossing the bridge. I paused beside the railing and watched two leaves drift under it before continuing home.',
    'I replaced the felt pads under a chair today. It slides quietly across the floor now, which makes the whole room feel calmer when I move it to the desk.',
  ],
  medium: [
    'A ceramic cup came out of the cupboard with a tiny chip at the base, and that sent me into a slow afternoon of sorting the kitchen shelf. I grouped the cups by how often I actually use them, set the chipped one aside for holding pencils, and moved the heavy plates down where they are easier to reach. There was no dramatic transformation, just fewer awkward stacks. Making tea afterward felt unusually simple because every small thing I needed was already in the place my hand expected.',
    'The footpath behind the library was covered with leaves after the rain. I took the longer route home so I could walk beside the shallow stream and listen to the water slipping under the little bridge. A maintenance crew had cleared one narrow strip through the leaves, leaving the rest to dry naturally. The contrast made the shape of the path easy to see. I stopped for a moment at the bench, wrote two observations in my notebook, and reached home with muddy shoes and a quieter mind.',
    'My windowsill herb pots had started leaning in the same direction, so I spent the morning rotating them and checking the soil. The basil wanted more water, the thyme wanted less, and the parsley looked happiest in the corner I had nearly ignored. I drew a quick map of the pots rather than trusting my memory. Over the next week I will check whether the changes help. It is a small experiment, but watching new leaves arrive makes the daily routine feel less like another chore.',
    'An old wooden stool wobbled whenever I sat near the edge. I placed it upside down on a towel, checked each joint, and found that one screw had worked loose without the wood cracking. Tightening it solved most of the movement, while a thin felt pad evened out the last corner. I tested it several times before putting it back beside the desk. The stool still has its scratches, but now those marks look like ordinary wear instead of a warning that the next cup of tea might end up on the floor.',
    'The bread dough rose more slowly than usual because the room was cool. I stopped checking the clock and watched its shape instead, then gave it another half hour before baking. The loaf came out with a firmer crust and an uneven slash that I would not know how to repeat on purpose. I sliced it after it cooled, toasted the end piece, and saved the rest for tomorrow. Keeping a few notes about the room temperature may help next time, although the imperfect loaf was already a good dinner.',
    'A stack of loose sketchbook pages had been drifting around the desk for weeks. I finally spread them on the floor and arranged them by subject: windows, chairs, leaves, and a few shapes that had stopped looking like anything recognizable. Seeing them together made the changes in my drawing easier to notice. I bound the pages with two clips and wrote dates on the backs where I could remember them. The desk is clear now, and the pile feels like a record of practice instead of unfinished clutter.',
    'The small keyboard has one key that feels heavier than its neighbors. I practiced a slow melody around it today, listening for an even sound instead of trying to make every motion identical. After a few minutes I noticed that my shoulders were tensing before the difficult phrase. Taking a breath and lowering the tempo helped more than repeating it quickly. I recorded a short passage only for comparison with my next practice session, then closed the lid while the melody still felt pleasant to play.',
    'A paper street map showed a narrow lane I had never noticed on my usual walk. I followed it after lunch and found a row of shaded doors, a tiled wall, and a little open space where the lane bends back toward the main road. Nothing remarkable happened there, which was part of the appeal. I added a pencil line to the map when I returned. The new route takes five extra minutes, but it avoids the loud intersection and gives me a quieter way to reach the same familiar corner.',
    'The drawer of sewing supplies was difficult to close because every spool had escaped its little box. I sorted the thread by thickness, wound the loose ends, and put the needles in a folded piece of cloth with a clear label. A few scraps of fabric went into a separate envelope for small repairs. This took longer than the repair I had originally planned, but the repair was easy once I started it. I am keeping one empty compartment so the drawer can hold the next useful thing without becoming a puzzle again.',
    'A gentle rain kept me indoors, so I tried making vegetable soup from the carrots, beans, and half an onion left in the kitchen. I cooked the onion first, added water in small amounts, and waited until the beans were soft before seasoning the pot. The soup tasted better after sitting for a little while. I wrote down the rough quantities without pretending they were precise, washed the pot, and left a covered bowl in the fridge. Tomorrow’s lunch is settled, and the vegetable drawer is finally easy to see.',
    'The lamp on my desk made a bright patch on the page and left the rest of the room dark. I moved it to the other side, lowered the shade, and tried reading for a few minutes in each position. The better arrangement was less dramatic but easier on my eyes. I also shifted the little tray of pens out of the light so it stopped casting a long shadow. These were tiny changes, yet the desk feels more comfortable now. I will leave it this way for a week before deciding whether anything else needs moving.',
    'A basket handle had started separating from the rim. I used a spare reed to wrap the join, keeping the tension gentle so the old material would not split. The first wrap looked tidy but slipped when I lifted the basket; the second held after I tucked the end through a different gap. I tested it with a few folded towels rather than anything breakable. The repair has a slightly different color, which I like. It makes the useful old basket look cared for without trying to hide how long it has been around.',
    'The quietest part of the morning happened while I was cleaning the window track. I brushed out the grit, wiped the corners with a damp cloth, and discovered a tiny seed wedged beside the frame. The window slides smoothly again, and the whole task took less time than I had spent putting it off. Afterward I opened it wide and let the room cool while the floor dried. A mundane repair can change how a room feels, especially when it removes a little resistance from something used every day.',
    'My reading notes had become a mixture of quotations, grocery reminders, and half-finished thoughts. I copied the useful book observations into a fresh notebook and left the unrelated scraps in a separate folder. The clean pages made it easier to see which ideas were worth returning to. I did not copy everything; some notes were only useful in the moment when I wrote them. The old notebook is staying on the shelf as it is. The new one can begin with a clear purpose without erasing the untidy path that led to it.',
    'The camera pouch had collected fine dust around the seams, so I cleaned it with a soft brush and a barely damp cloth. I emptied the pocket first and found a spare strap clip I had forgotten about. Once the pouch dried, I put the small accessories in individual cloth sleeves so they would not scrape against one another. There is now a little more space and much less rattling. I have no special trip planned; I simply wanted the ordinary equipment I already own to be ready for the next walk.',
    'A board game box arrived with its rules printed in tiny type. I rewrote the setup steps on one sheet of paper, then laid out the pieces and checked the sequence against the original booklet. Two steps made more sense when I swapped their order in my notes, although the game itself stayed the same. The sheet is going inside the lid so the next session can start calmly. I like games with a lot of small decisions, but I would rather save the effort for playing than spend it searching the booklet for one missing instruction.',
    'The afternoon light made the paper crane on my shelf cast a surprisingly clear shadow. I folded another one from a larger square, slowing down at the corners that had become uneven in the first attempt. The second crane stands more neatly, but the first has a softer shape that I still prefer. I put them side by side instead of deciding which one was better. A small row of imperfect paper shapes is a pleasant reminder that practice changes the result without making every earlier attempt disposable.',
    'A loose cabinet knob turned a simple cupboard into a daily irritation. I found the correct screwdriver, held the knob steady, and tightened it from the inside without forcing the old screw. Then I checked the neighboring knobs and stopped when they felt secure. The whole job was finished before the kettle boiled. I returned the tool to its marked spot in the drawer so the next small repair will not begin with a search. The cupboard is ordinary again, which is exactly the result I had hoped for.',
    'The community garden path has a bend where fallen petals collect after a breeze. I walked past it slowly today and noticed that the pale petals were caught on one side while the darker leaves gathered on the other. A shallow ridge in the path seemed to be guiding them. I sketched the pattern from the bench and watched it change when the wind returned. It was a useful little drawing exercise because the subject would not stay still, and because none of the changes required me to call one version the correct one.',
    'My desk calendar had a whole blank page left from a quiet month. I cut it into small cards and used them as labels for the boxes in the hallway cupboard. One box holds spare cables, another holds fabric scraps, and a third is finally labeled honestly as things to sort later. I wrote the labels in pencil so they can change without wasting the cards. The cupboard is easier to use now, and giving the uncertain box a clear name made it feel manageable instead of like a secret task waiting behind the door.',
  ],
  long: [
    longPost({
      opening: 'Restoring a wobbly wooden stool turned into my slow afternoon project. The seat was sound, but each time I shifted my weight one leg lifted slightly from the floor.',
      project: 'repairing the wooden stool',
      detail: 'The stool had four narrow legs, a scratched seat, and one joint that moved when I pressed it gently by hand.',
      obstacle: 'One screw tightened normally while a neighboring joint still shifted under light pressure.',
      result: 'the stool rested evenly on the floor and supported a careful test without the old rocking motion.',
    }),
    longPost({
      opening: 'Recording the evening insects from the open window gave me a reason to sit quietly as the light changed. I wanted a small sound diary of an ordinary invented evening.',
      project: 'making a window-side insect recording',
      detail: 'The recorder sat on a folded cloth, pointed toward a patch of shrubs, with its cable kept away from the moving curtain.',
      obstacle: 'The curtain brushed the cable and added a low rustling sound to an otherwise clear recording.',
      result: 'the final short recording preserved the insect rhythm with much less distracting movement nearby.',
    }),
    longPost({
      opening: 'Planning a balcony herb tray began with three pots and a surprisingly uneven strip of sunlight. The bright corner faded early, while the shaded edge stayed cool all afternoon.',
      project: 'arranging the balcony herb tray',
      detail: 'The tray held basil, parsley, and thyme in separate pots, each marked with a pencil label and a simple watering note.',
      obstacle: 'Water collected under one pot even though the surface of its soil looked dry.',
      result: 'the pots stood in a better order with space underneath them and a clearer plan for checking moisture.',
    }),
    longPost({
      opening: 'Organizing a lentil soup notebook sounded easy until I laid out the scraps of paper on the table. Every attempt had a slightly different cooking time and a different amount of water.',
      project: 'organizing the lentil soup notes',
      detail: 'The notes described red lentils, diced carrots, a small onion, and the point at which the pot became thick enough to stir slowly.',
      obstacle: 'Two notes used the same heading but described different pan sizes and different starting quantities.',
      result: 'the notebook held one clearly described base recipe and separate notes for the two variations.',
    }),
    longPost({
      opening: 'Rewriting a board game setup sheet became a little puzzle of its own. The pieces were simple, but the original instructions introduced them in an order that made the table cluttered.',
      project: 'rewriting the board game setup sheet',
      detail: 'The game used wooden counters, a folded board, and a small deck whose cards needed to be sorted before the first turn.',
      obstacle: 'A setup step referred to a pile of cards that had not yet been created in the written sequence.',
      result: 'the sheet explained the setup in an order that matched the actual movement of the pieces.',
    }),
    longPost({
      opening: 'Mending a canvas tote started with an empty bag and a frayed corner seam. I liked the bag enough to try a visible repair, especially because the rest of the fabric was still strong.',
      project: 'mending the canvas tote corner',
      detail: 'A square cotton patch, a blunt needle, and thick thread were laid out beside the tote with the damaged seam facing upward.',
      obstacle: 'The first stitches pulled the patch into a wrinkle when the bag opened fully.',
      result: 'the patch lay flat and the repaired seam held several folded towels without stretching apart.',
    }),
    longPost({
      opening: 'Drawing the same window from two chairs made the room feel unfamiliar in a useful way. The frame barely changed, but the angles and reflected light shifted every time I moved.',
      project: 'drawing the window from two positions',
      detail: 'I used a soft pencil, plain paper, and two chairs set at different angles to the same square window frame.',
      obstacle: 'The reflected curtain looked like another edge of the frame in the first sketch.',
      result: 'the second sketch separated the real frame from the reflection while keeping the first drawing for comparison.',
    }),
    longPost({
      opening: 'Building a small paper lantern from leftover craft sheets gave me an excuse to work slowly with scissors. I wanted the folds to hold their shape before choosing any decoration.',
      project: 'folding the small paper lantern',
      detail: 'The lantern used a rectangle of thick paper, a rounded pair of scissors, and a narrow strip reserved for its handle.',
      obstacle: 'The cut slots opened unevenly because two folds were a little closer together than the others.',
      result: 'the lantern stood upright with a smoother curve and a handle that stayed centered above it.',
    }),
    longPost({
      opening: 'Sorting a box of spare buttons made a surprisingly good rainy-day activity. A few had matching partners, many were alone, and one flat wooden button kept rolling beneath the table.',
      project: 'sorting the spare button box',
      detail: 'The buttons were arranged by hole count and thickness in shallow dishes rather than being grouped only by color.',
      obstacle: 'Several buttons looked alike from above but had different shank shapes underneath.',
      result: 'the useful pairs were easy to find and the unmatched buttons had a separate, clearly marked compartment.',
    }),
    longPost({
      opening: 'Checking a bicycle basket mount started with a faint rattle on a short ride. The basket itself was intact, so I brought it indoors and looked carefully at the straps and support points.',
      project: 'checking the bicycle basket mount',
      detail: 'The empty basket rested beside its two mounting straps, with a folded towel protecting the table from the metal brackets.',
      obstacle: 'One strap looked tight but slipped when the basket was lifted at a slight angle.',
      result: 'the basket sat firmly in its mount and stayed quiet during a careful walk with the bicycle.',
    }),
    longPost({
      opening: 'Arranging a pressed-leaf album began with a stack of dry leaves wrapped in plain paper. The shapes were clear, but some stems had curled and needed a little extra space on the page.',
      project: 'arranging the pressed-leaf album',
      detail: 'The album used thick pages, small paper corners, and pencil notes describing each invented leaf shape without naming a collection place.',
      obstacle: 'A broad leaf covered the note space when I placed it according to the first page sketch.',
      result: 'the leaves fit with enough room for the notes and could be viewed without lifting fragile edges.',
    }),
    longPost({
      opening: 'Testing three pencil sharpeners became an afternoon of quiet comparisons. I wanted a dependable point for sketching, so I used pencils of the same width and kept each shaving pile separate.',
      project: 'comparing the pencil sharpeners',
      detail: 'Three hand sharpeners, six plain pencils, and a sheet for testing the resulting lines were set out in a row.',
      obstacle: 'A point that looked sharp broke on the first heavy line and made the visual comparison misleading.',
      result: 'the notes described both the shape of the point and how it behaved during a simple drawing test.',
    }),
    longPost({
      opening: 'Mapping a quiet walking loop with a paper sketch helped me notice where the pavement narrowed. I wanted a route that returned to the same bench without crossing the busiest intersection.',
      project: 'sketching the quiet walking loop',
      detail: 'The sketch marked a bench, a little bridge, two shaded turns, and the wide pavement near the end of the loop.',
      obstacle: 'One turn looked connected on the rough sketch but actually ended at a closed garden gate.',
      result: 'the revised loop followed open paths and returned to the bench by a quieter final stretch.',
    }),
    longPost({
      opening: 'Cleaning the tracks of a sliding window made a small household job feel like a careful repair. The glass moved freely at first, then caught near the end where grit had gathered in a corner.',
      project: 'cleaning the sliding window track',
      detail: 'A soft brush, a damp cloth, and a wooden stick wrapped in fabric reached different parts of the narrow track.',
      obstacle: 'Fine grit kept moving into the cleaned section when I wiped from the wrong direction.',
      result: 'the window slid through its full range with less resistance and the corners were easy to inspect.',
    }),
    longPost({
      opening: 'Designing cloth dividers for a camera pouch started with the sound of small accessories knocking together. I wanted each piece to have its own soft place without making the pouch bulky.',
      project: 'making the camera pouch dividers',
      detail: 'The empty pouch held a strap clip, a lens cloth, and two small covers whose edges needed to stay away from each other.',
      obstacle: 'The first folded divider made one pocket too narrow to remove its cover comfortably.',
      result: 'each accessory had a soft compartment and the pouch closed without pressing the pieces together.',
    }),
    longPost({
      opening: 'Practicing an easy keyboard melody slowly revealed a difficult transition I had been rushing past. The notes were familiar, but the pause between two phrases kept arriving in the wrong place.',
      project: 'practicing the slow keyboard melody',
      detail: 'The keyboard sat at a comfortable height with a short handwritten score and a simple tempo mark for each attempt.',
      obstacle: 'My left hand began the next phrase early while the right hand was still holding its last note.',
      result: 'the transition sounded more even at a slow tempo and the notes showed where to resume next time.',
    }),
    longPost({
      opening: 'Preparing small labels for storage boxes started with a leftover calendar page. I cut the blank section into cards and tried to describe the contents in words I would understand months later.',
      project: 'labeling the hallway storage boxes',
      detail: 'The boxes held spare cables, folded fabric, repair tools, and a small group of objects that still needed sorting.',
      obstacle: 'A broad label such as miscellaneous did not help me distinguish two boxes with different contents.',
      result: 'the labels named the contents clearly and one box honestly kept its separate list of things still to sort.',
    }),
    longPost({
      opening: 'Measuring a curtain hem gave me a slow afternoon with a ruler and a line of pins. The curtain was only a little too long, but its bottom edge rested on the floor unevenly.',
      project: 'measuring the curtain hem',
      detail: 'The curtain hung from its usual rod while a ruler, chalk, and blunt pins marked the proposed lower edge.',
      obstacle: 'The floor sloped slightly, so equal measurements from the fabric edge did not give an even hanging line.',
      result: 'the pinned hem followed the visible hanging line and left a small, even gap above the floor.',
    }),
    longPost({
      opening: 'Rearranging a reading lamp changed the shadows on the desk more than I expected. The old position lit the middle of the book brightly but left the outer margin dark and the pens in the way.',
      project: 'rearranging the desk reading lamp',
      detail: 'The lamp, an open book, and a shallow pen tray were moved a little at a time across the same desk surface.',
      obstacle: 'A position that reduced the page shadow also put a reflection directly into my eyes.',
      result: 'the lamp lit both pages comfortably while the pen tray stayed out of the main beam.',
    }),
    longPost({
      opening: 'Repairing a woven basket rim started with one reed that had lifted out of place. The basket was still useful, and I wanted to secure that loose edge before it caught on a sleeve.',
      project: 'repairing the woven basket rim',
      detail: 'The basket lay on its side beside a spare reed, a shallow dish of water, and a smooth wooden tool for guiding the weave.',
      obstacle: 'The dry spare reed cracked slightly when I tried to bend it around the tightest corner.',
      result: 'the softened replacement followed the rim and the loose edge stayed tucked beneath the surrounding weave.',
    }),
  ],
};

// The phrases define the labeling scope. For example, ordinary AI engineering
// does not match the exaggerated-claims filter, and a normal conversational
// question does not match the explicit engagement-boosting request filter.
const F = {
  crypto: 'cryptocurrency investing or promotion',
  sports: 'sports results or commentary',
  food: 'food and cooking',
  fitness: 'exercise routines and fitness training',
  politics: 'government policy or election politics',
  aiHype: 'exaggerated claims that artificial intelligence will solve everything',
  celebrity: 'gossip about famous entertainers or celebrities',
  promotion: "promotion of the author's own product or paid service",
  engagement: 'requests for likes, reposts, or replies to boost engagement',
  drama: 'personal feuds or public insults between people',
};

export const MULTI_FILTER_CASES: Array<{
  id: string;
  text: string;
  filters: string[];
  expectedMatches: string[];
  rationale: string;
}> = [
  {
    id: 'single-crypto-positive',
    text: 'I am buying more of this cryptocurrency token today. I expect its price to double, and I think other investors should buy before the next rally.',
    filters: [F.crypto],
    expectedMatches: [F.crypto],
    rationale: 'An explicit token investment and purchase recommendation.',
  },
  {
    id: 'single-crypto-negative',
    text: 'I counted the coins in the desk drawer and put the spare change in a jar. The drawer now closes easily, and I can finally find the scissors.',
    filters: [F.crypto],
    expectedMatches: [],
    rationale: 'Physical spare change is unrelated to cryptocurrency investment.',
  },
  {
    id: 'single-sports-positive',
    text: 'The home team won the basketball final by six points. Their defense forced three turnovers in the last quarter, which decided a close game.',
    filters: [F.sports],
    expectedMatches: [F.sports],
    rationale: 'A game result with direct sports commentary.',
  },
  {
    id: 'single-sports-negative',
    text: 'I walked around the garden to inspect the new fence. The corner post is level, and the gate opens without scraping the path.',
    filters: [F.sports],
    expectedMatches: [],
    rationale: 'An ordinary household inspection contains no sporting event or commentary.',
  },
  {
    id: 'single-food-positive',
    text: 'For dinner I simmered lentils with carrots and onion, then added lemon juice after turning off the heat. The extra acidity balanced the soup.',
    filters: [F.food],
    expectedMatches: [F.food],
    rationale: 'Ingredients, cooking steps, and the taste of a meal.',
  },
  {
    id: 'single-fitness-positive',
    text: 'Today’s strength session was three sets of squats, three sets of rows, and ten minutes of mobility work. I reduced the weight to practice a steady form.',
    filters: [F.fitness],
    expectedMatches: [F.fitness],
    rationale: 'A clearly described exercise and strength-training routine.',
  },
  {
    id: 'single-politics-positive',
    text: 'The council election debate focused on housing policy. One candidate supports public rental homes, while another wants to reduce zoning restrictions.',
    filters: [F.politics],
    expectedMatches: [F.politics],
    rationale: 'An election debate and competing government policy proposals.',
  },
  {
    id: 'single-ai-hype-negative',
    text: 'I tested a small language model on sorting synthetic support tickets. It made several errors, so I added a manual review step and documented its limitations.',
    filters: [F.aiHype],
    expectedMatches: [],
    rationale: 'Measured AI engineering with stated limitations does not make sweeping solution claims.',
  },
  {
    id: 'single-celebrity-positive',
    text: 'A famous film star was seen leaving a party with a famous singer. Gossip columns are speculating that they are dating, although neither has said so.',
    filters: [F.celebrity],
    expectedMatches: [F.celebrity],
    rationale: 'Relationship speculation about famous entertainers is celebrity gossip.',
  },
  {
    id: 'single-promotion-negative',
    text: 'I repaired the binding on my old notebook and moved it beside the reading lamp. The pages open flat again, which makes my evening notes easier to write.',
    filters: [F.promotion],
    expectedMatches: [],
    rationale: 'A personal repair diary does not offer the author’s product or paid service.',
  },
  {
    id: 'single-engagement-positive',
    text: 'Please like this post, repost it, and leave any reply so it reaches more people. I am trying to boost the engagement numbers on this account.',
    filters: [F.engagement],
    expectedMatches: [F.engagement],
    rationale: 'The author explicitly requests platform actions to boost engagement.',
  },
  {
    id: 'single-drama-negative',
    text: 'A neighbor corrected the delivery time on the noticeboard. We checked the schedule together, agreed on the right time, and updated the note calmly.',
    filters: [F.drama],
    expectedMatches: [],
    rationale: 'A calmly resolved factual correction contains neither a feud nor a public insult.',
  },
  {
    id: 'triple-crypto-and-food',
    text: 'I bought more cryptocurrency tokens this morning because I expect a price increase. Afterward I made tomato soup by roasting tomatoes and blending them with stock.',
    filters: [F.crypto, F.sports, F.food],
    expectedMatches: [F.crypto, F.food],
    rationale: 'Two explicit topics match; no sporting event is discussed.',
  },
  {
    id: 'triple-sports-middle',
    text: 'The visiting football team won two to one. A late header decided the match after the home side missed a penalty in the first half.',
    filters: [F.food, F.sports, F.crypto],
    expectedMatches: [F.sports],
    rationale: 'Only the middle filter matches the match result and commentary.',
  },
  {
    id: 'triple-fitness-and-politics',
    text: 'I finished a strength workout with squats and rows. Later I read the council candidates’ proposals for public housing and compared their election pledges.',
    filters: [F.fitness, F.politics, F.aiHype],
    expectedMatches: [F.fitness, F.politics],
    rationale: 'An exercise routine and election policy match; there are no AI claims.',
  },
  {
    id: 'triple-hype-promotion-engagement',
    text: 'Artificial intelligence will solve every problem in every industry, with no limits. Buy my own paid AI course today, and like and repost this announcement to boost its reach.',
    filters: [F.aiHype, F.promotion, F.engagement],
    expectedMatches: [F.aiHype, F.promotion, F.engagement],
    rationale: 'Sweeping AI promises, the author’s paid course, and explicit engagement boosting all match.',
  },
  {
    id: 'triple-celebrity-and-drama',
    text: 'A famous actor and a famous singer are publicly feuding over rumors about their breakup. The actor called the singer a liar, and the singer answered with personal insults.',
    filters: [F.celebrity, F.drama, F.politics],
    expectedMatches: [F.celebrity, F.drama],
    rationale: 'Celebrity relationship gossip and an explicit personal feud match; no government politics.',
  },
  {
    id: 'triple-drama-and-engagement',
    text: 'My former collaborator is a dishonest fool, and I am continuing our public feud here. Like this post and reply with an insult so the argument gets more engagement.',
    filters: [F.drama, F.engagement, F.promotion],
    expectedMatches: [F.drama, F.engagement],
    rationale: 'Personal insults and an explicit engagement request match; nothing is offered for sale.',
  },
  {
    id: 'triple-all-negative',
    text: 'I sanded the rough edge of a wooden picture frame and applied a thin layer of clear wax. It now sits flat on the shelf beside the lamp.',
    filters: [F.food, F.fitness, F.sports],
    expectedMatches: [],
    rationale: 'A woodworking diary contains none of the three requested topics.',
  },
  {
    id: 'triple-policy-only',
    text: 'The legislature is debating a bill that would require landlords to disclose rent increases in advance. I am comparing the proposed notice periods and enforcement rules.',
    filters: [F.politics, F.crypto, F.aiHype],
    expectedMatches: [F.politics],
    rationale: 'Government legislation matches politics without cryptocurrency or AI claims.',
  },
  {
    id: 'triple-selling-own-baking-class',
    text: 'I am selling places in my own paid bread-baking class. I teach mixing, kneading, and baking a simple loaf, and registration for my next class is now open.',
    filters: [F.promotion, F.food, F.crypto],
    expectedMatches: [F.promotion, F.food],
    rationale: 'The author promotes their paid service and describes cooking; no cryptocurrency.',
  },
  {
    id: 'triple-celebrity-middle',
    text: 'Entertainment gossip magazines are speculating about which famous actress is dating a famous musician. The reports rely on party photographs and anonymous rumors.',
    filters: [F.engagement, F.celebrity, F.sports],
    expectedMatches: [F.celebrity],
    rationale: 'Celebrity dating speculation matches without any request for engagement or sports discussion.',
  },
  {
    id: 'triple-fitness-only',
    text: 'My training plan this week has two strength sessions and one easy cycling session. I am increasing the recovery time between sets rather than adding more weight.',
    filters: [F.fitness, F.aiHype, F.drama],
    expectedMatches: [F.fitness],
    rationale: 'Explicit fitness training matches; no AI hype or interpersonal conflict.',
  },
  {
    id: 'triple-crypto-policy-own-guide',
    text: 'I am selling my own paid guide to buying cryptocurrency tokens. The guide also compares proposed government taxes on token investment gains and the parties’ election pledges.',
    filters: [F.crypto, F.politics, F.promotion],
    expectedMatches: [F.crypto, F.politics, F.promotion],
    rationale: 'Token investment, government tax/election policy, and the author’s paid guide all match.',
  },
  {
    id: 'five-everyday-negative',
    text: 'I arranged smooth stones by size on the windowsill and sketched their shadows. The smallest stone made the sharpest outline when the afternoon light reached it.',
    filters: [F.crypto, F.sports, F.food, F.fitness, F.politics],
    expectedMatches: [],
    rationale: 'An ordinary drawing observation contains none of the five topics.',
  },
  {
    id: 'five-all-topics-reversed',
    text: 'The election candidates debated a housing bill. I then completed three sets of squats, cooked lentil soup, watched the basketball team win its final, and bought a cryptocurrency token as an investment.',
    filters: [F.politics, F.fitness, F.food, F.sports, F.crypto],
    expectedMatches: [F.politics, F.fitness, F.food, F.sports, F.crypto],
    rationale: 'Each of the five explicit topic statements matches in the requested reverse-style order.',
  },
  {
    id: 'five-hype-gossip-sale-bait-feud',
    text: 'AI will solve every human problem without exception. Buy my own paid AI course. A famous singer’s rumored breakup has become a public feud with a famous actor, and they are trading personal insults. Like and repost this to boost engagement.',
    filters: [F.aiHype, F.celebrity, F.promotion, F.engagement, F.drama],
    expectedMatches: [F.aiHype, F.celebrity, F.promotion, F.engagement, F.drama],
    rationale: 'The text explicitly contains all five narrow definitions.',
  },
  {
    id: 'five-second-group-negative',
    text: 'I repaired a torn page in a library book with archival paper and a careful fold. The page opens properly now, and the pencil note in the margin is still easy to read.',
    filters: [F.drama, F.engagement, F.promotion, F.celebrity, F.aiHype],
    expectedMatches: [],
    rationale: 'A quiet book repair describes no feud, engagement request, sale, gossip, or sweeping AI claim.',
  },
  {
    id: 'five-food-and-fitness-separated',
    text: 'I cooked rice and grilled vegetables for lunch. In the afternoon I followed a strength routine with squats, rows, and a short mobility session.',
    filters: [F.food, F.aiHype, F.crypto, F.promotion, F.fitness],
    expectedMatches: [F.food, F.fitness],
    rationale: 'Cooking and a stated workout match the first and last filters only.',
  },
  {
    id: 'five-sports-and-policy',
    text: 'The volleyball team won the final in four sets. Later I compared the two council candidates’ proposed housing policies ahead of the election.',
    filters: [F.sports, F.politics, F.drama, F.engagement, F.celebrity],
    expectedMatches: [F.sports, F.politics],
    rationale: 'Sports results and election policy match without personal insults, platform requests, or entertainer gossip.',
  },
  {
    id: 'five-crypto-hype-own-service',
    text: 'Buy access to my own paid cryptocurrency prediction service. I tell investors which tokens to buy, and I claim its AI will solve every financial problem perfectly, with no errors or limitations.',
    filters: [F.crypto, F.promotion, F.food, F.aiHype, F.politics],
    expectedMatches: [F.crypto, F.promotion, F.aiHype],
    rationale: 'Token investment promotion, an author-owned paid service, and unlimited AI solution claims match.',
  },
  {
    id: 'five-gossip-feud-engagement-permutation',
    text: 'Two famous film stars are feuding publicly over rumors about their former relationship. They called each other dishonest and pathetic. Like this post and leave a reply so the gossip gets more engagement.',
    filters: [F.fitness, F.drama, F.celebrity, F.food, F.engagement],
    expectedMatches: [F.drama, F.celebrity, F.engagement],
    rationale: 'The feud, celebrity gossip, and explicit engagement request match in filter order.',
  },
  {
    id: 'five-own-fitness-service',
    text: 'Enroll in my own paid strength-training program. I wrote the workout plan myself: three weekly sessions of squats, presses, rows, and progressive resistance exercises.',
    filters: [F.promotion, F.sports, F.fitness, F.politics, F.crypto],
    expectedMatches: [F.promotion, F.fitness],
    rationale: 'An author-owned paid training service and an exercise routine match; no sports result or commentary.',
  },
  {
    id: 'five-food-last-only',
    text: 'I roasted carrots with a little oil, stirred them into cooked barley, and added lemon at the end. The meal tasted sweeter after the carrots browned at the edges.',
    filters: [F.celebrity, F.aiHype, F.engagement, F.drama, F.food],
    expectedMatches: [F.food],
    rationale: 'Only the last filter matches the recipe and meal description.',
  },
  {
    id: 'five-policy-crypto-engagement',
    text: 'The election debate included a proposal to remove taxes on cryptocurrency investment profits. I support buying tokens under that policy. Like and repost this post to boost its engagement.',
    filters: [F.politics, F.crypto, F.engagement, F.food, F.sports],
    expectedMatches: [F.politics, F.crypto, F.engagement],
    rationale: 'Election tax policy, token investing, and an explicit engagement request match.',
  },
  {
    id: 'five-ai-hype-first-only',
    text: 'Artificial intelligence will solve every problem in every field, instantly and perfectly. No task will ever need human judgment again because AI has no meaningful limitations.',
    filters: [F.aiHype, F.fitness, F.promotion, F.drama, F.celebrity],
    expectedMatches: [F.aiHype],
    rationale: 'The unlimited AI solution claim matches; nothing is sold and no other listed topic appears.',
  },
  {
    id: 'ten-all-negative',
    text: 'I tightened the loose hinge on a wooden storage box and polished the lid with a soft cloth. The box closes smoothly again and fits beneath the desk.',
    filters: [F.crypto, F.sports, F.food, F.fitness, F.politics, F.aiHype, F.celebrity, F.promotion, F.engagement, F.drama],
    expectedMatches: [],
    rationale: 'A simple household repair contains none of the ten filter definitions.',
  },
  {
    id: 'ten-crypto-only',
    text: 'I bought a cryptocurrency token as a speculative investment. I expect its market price to rise and plan to sell if the value doubles.',
    filters: [F.drama, F.food, F.crypto, F.engagement, F.politics, F.fitness, F.celebrity, F.promotion, F.sports, F.aiHype],
    expectedMatches: [F.crypto],
    rationale: 'A personal token investment matches only cryptocurrency investing.',
  },
  {
    id: 'ten-sports-only',
    text: 'The basketball championship ended with a five-point win for the visiting team. Their defense held the lead through the final two minutes, and the last shot hit the rim.',
    filters: [F.aiHype, F.promotion, F.fitness, F.celebrity, F.crypto, F.sports, F.drama, F.politics, F.engagement, F.food],
    expectedMatches: [F.sports],
    rationale: 'A championship result and game analysis match sports alone.',
  },
  {
    id: 'ten-cooking-and-training',
    text: 'I cooked a bowl of lentils, rice, and vegetables for lunch. My afternoon strength workout consisted of three sets of squats, presses, and rows, followed by gentle mobility exercises.',
    filters: [F.fitness, F.crypto, F.celebrity, F.food, F.engagement, F.aiHype, F.politics, F.drama, F.promotion, F.sports],
    expectedMatches: [F.fitness, F.food],
    rationale: 'Training and cooking match in requested order even though cooking appears first in the post.',
  },
  {
    id: 'ten-politics-only',
    text: 'The council candidates disagree about a proposed housing bill. The election will determine whether the new rent-notice rules proceed, so I compared the policy text and the enforcement powers.',
    filters: [F.food, F.sports, F.engagement, F.crypto, F.promotion, F.celebrity, F.politics, F.fitness, F.aiHype, F.drama],
    expectedMatches: [F.politics],
    rationale: 'Election and government housing policy match without the other nine topics.',
  },
  {
    id: 'ten-ai-hype-only',
    text: 'AI will solve every human problem instantly. It will make all work flawless and remove every need for human judgment; there will never be a task it cannot handle perfectly.',
    filters: [F.politics, F.drama, F.sports, F.food, F.fitness, F.celebrity, F.engagement, F.crypto, F.aiHype, F.promotion],
    expectedMatches: [F.aiHype],
    rationale: 'An explicit unlimited AI promise matches hype alone; the author offers no product.',
  },
  {
    id: 'ten-celebrity-feud',
    text: 'Gossip magazines claim a famous singer and a famous actor have ended their relationship. Their public feud escalated when each called the other a selfish liar in personal posts.',
    filters: [F.promotion, F.drama, F.crypto, F.food, F.aiHype, F.sports, F.politics, F.engagement, F.celebrity, F.fitness],
    expectedMatches: [F.drama, F.celebrity],
    rationale: 'Personal insults and entertainer relationship gossip match, ordered by the requested filters.',
  },
  {
    id: 'ten-own-product-and-engagement',
    text: 'My own handmade ceramic vase collection is now available to buy from me. I made every vase and set the prices. Please like and repost this sales announcement to boost its engagement.',
    filters: [F.engagement, F.fitness, F.celebrity, F.politics, F.food, F.promotion, F.sports, F.drama, F.aiHype, F.crypto],
    expectedMatches: [F.engagement, F.promotion],
    rationale: 'An engagement request and the author’s own product sale match; pottery is not cooking.',
  },
  {
    id: 'ten-crypto-policy-own-guide',
    text: 'Buy my own paid guide to cryptocurrency investing. It explains token purchase strategies and compares the political parties’ election proposals for taxing cryptocurrency investment profits.',
    filters: [F.celebrity, F.promotion, F.engagement, F.aiHype, F.fitness, F.crypto, F.drama, F.sports, F.food, F.politics],
    expectedMatches: [F.promotion, F.crypto, F.politics],
    rationale: 'The author’s paid guide, token investment, and election tax policy match in requested order.',
  },
  {
    id: 'ten-sports-food-fitness',
    text: 'The football team won its final match by one goal. At home I baked potatoes and made bean soup, then completed my planned strength session of squats, rows, and presses.',
    filters: [F.aiHype, F.food, F.drama, F.politics, F.sports, F.celebrity, F.crypto, F.fitness, F.promotion, F.engagement],
    expectedMatches: [F.food, F.sports, F.fitness],
    rationale: 'A meal, a sports result, and a workout match in filter order rather than text order.',
  },
  {
    id: 'ten-five-topic-mixed',
    text: 'My former partner is a dishonest fool, and our personal feud is continuing publicly. Buy my own paid cryptocurrency investment service: it recommends tokens and claims its AI will solve every financial problem perfectly. Like and repost this to boost engagement.',
    filters: [F.sports, F.drama, F.food, F.engagement, F.aiHype, F.fitness, F.crypto, F.politics, F.promotion, F.celebrity],
    expectedMatches: [F.drama, F.engagement, F.aiHype, F.crypto, F.promotion],
    rationale: 'Five explicit definitions match: feud, engagement boosting, unlimited AI claims, token investing, and an own paid service.',
  },
  {
    id: 'ten-all-topics-permuted',
    text: 'A famous singer and a famous actor are rumored to have broken up, and their public feud now includes personal insults. I cooked lentil soup, bought cryptocurrency tokens as an investment, and completed a squat-and-row workout. The basketball team won the final. Election candidates debated a housing bill. I claim AI will solve every problem without limits. Buy my own paid notebook product, then like and repost this announcement to boost engagement.',
    filters: [F.drama, F.food, F.crypto, F.engagement, F.politics, F.fitness, F.celebrity, F.promotion, F.sports, F.aiHype],
    expectedMatches: [F.drama, F.food, F.crypto, F.engagement, F.politics, F.fitness, F.celebrity, F.promotion, F.sports, F.aiHype],
    rationale: 'Ten explicit topic statements match all filters in their requested permutation.',
  },
];

// Exact copies of gemma-comparison.ts's five synthetic suggestion inputs.
// These are generation/strict-validation fixtures, not pre-labeled quality rows.
export const SUGGESTION_FIXTURES = [
  'absolutely disgusting. quote this everywhere until the company is forced to answer for it.',
  '100x incoming. buy this coin before the crowd wakes up and thank me later 🚀',
  'look at this celebrity meltdown. tag a friend and pile on before the post disappears.',
  'another AI founder claiming their wrapper changes everything. repost if you are tired of the hype.',
  'just a humble reminder that I work harder than everyone complaining in my replies.',
];
