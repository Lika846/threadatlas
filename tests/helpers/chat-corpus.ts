/**
 * A synthetic corpus shaped like real ChatGPT conversations (M5.2 quality regression):
 * a user question, a long assistant answer with lists or code, and the short chatter real
 * conversations have ("thanks!", "can you make it shorter?"). Written for these tests; no
 * real conversation. Each entry alternates user and assistant messages.
 *
 * Two targets reproduce the reported misses: `dinner-idea` (should be found by "some
 * recipe") and `python-keyerror` (should be found by "when i was debugging some code").
 */
export type ChatConversation = { id: string; messages: string[] };

export const CHAT_CORPUS: ChatConversation[] = [
  {
    id: "dinner-idea",
    messages: [
      "What can I make for dinner tonight? I have chicken thighs, a bit of rice and a bag of spinach, and I don't want anything complicated.",
      "Here's an easy one-pan idea: garlic chicken with spinach rice.\n\nIngredients:\n- 4 chicken thighs\n- 1 cup of rice\n- 2 cups of chicken stock\n- 2 handfuls of spinach\n- 3 cloves of garlic, a lemon, salt, pepper and paprika\n\nSteps:\n1. Season the chicken with salt, pepper and paprika and brown it skin-side down for 6 minutes.\n2. Take the chicken out, fry the garlic for a minute, then stir in the rice and the stock.\n3. Put the chicken back on top, cover and simmer for 20 minutes.\n4. Stir in the spinach at the end until it wilts, and finish with lemon juice.\n\nIt takes about 35 minutes and serves four.",
      "sounds good, thanks!",
      "You're welcome, enjoy your dinner!",
    ],
  },
  {
    id: "python-keyerror",
    messages: [
      "My python script crashes with a KeyError when it reads the settings file. Here is the code:\n\nimport json\n\nwith open('settings.json') as f:\n    cfg = json.load(f)\nprint(cfg['output_dir'])\n\nCan you help me figure out what's wrong?",
      "The KeyError means the dictionary loaded from settings.json has no key called 'output_dir'. A few things to check:\n\n1. Print the keys that were actually loaded: print(cfg.keys()).\n2. Check the spelling and the case of the key in the JSON file.\n3. If the key is optional, read it with a default: cfg.get('output_dir', 'out').\n\nThe traceback line number tells you exactly which lookup failed.",
      "ah, the key was called outputDir in the file. That fixed it, thanks",
      "Glad it works now! Keeping the key names consistent between the code and the file avoids this kind of error.",
    ],
  },
  {
    id: "sourdough",
    messages: [
      "My sourdough bread comes out dense and flat. I feed the starter every day. What am I doing wrong?",
      "Dense sourdough usually means under-proofing or a weak starter. Make sure the starter doubles within 4 to 6 hours after feeding, let the dough rise until it has grown by about half, and shape it with enough surface tension. A cold overnight proof in the fridge also helps the loaf hold its shape.",
      "ok I'll try the overnight proof",
    ],
  },
  {
    id: "react-render",
    messages: [
      "My React component doesn't re-render when I push an item to the array in state. Why?",
      "React compares state by reference. Pushing into the same array keeps the same reference, so React sees no change. Create a new array instead: setItems([...items, newItem]).",
      "perfect, that was it",
    ],
  },
  {
    id: "lisbon-trip",
    messages: [
      "Can you plan a three day trip to Lisbon for me? I like museums and walking.",
      "Day 1: Alfama and the castle, then a tram ride on line 28 and dinner in Bairro Alto.\nDay 2: Belém, the Jerónimos Monastery, the tower and the MAAT museum.\nDay 3: the Gulbenkian Museum in the morning and a walk along the river in the afternoon.",
      "can you make it shorter?",
      "Day 1: Alfama. Day 2: Belém. Day 3: Gulbenkian and the riverside.",
    ],
  },
  {
    id: "cover-letter",
    messages: [
      "Write a short cover letter for a junior data analyst position at a logistics company.",
      "Dear hiring manager,\n\nI am applying for the junior data analyst position. During my studies I built dashboards in SQL and Python to track delivery times, and I enjoy turning messy data into clear decisions. I would welcome the chance to bring that to your team.\n\nKind regards",
      "great, thank you",
    ],
  },
  {
    id: "birthday-mom",
    messages: [
      "Help me write a birthday message for my mom, she's turning 60.",
      "Happy 60th birthday, Mom! Thank you for your patience, your laughter and every Sunday phone call. Here's to many more adventures together. Love you always.",
      "aww that's lovely",
    ],
  },
  {
    id: "photosynthesis",
    messages: [
      "Explain photosynthesis like I'm ten years old.",
      "Plants make their own food using sunlight. Their leaves take in carbon dioxide from the air and water from the roots, and with the energy of sunlight they turn them into sugar. The leftover oxygen is released into the air, which is the oxygen we breathe.",
      "thanks!",
    ],
  },
  {
    id: "workout-plan",
    messages: [
      "I want a simple workout plan for three days a week at home, no equipment.",
      "Monday: squats, push-ups and planks, three rounds. Wednesday: lunges, glute bridges and mountain climbers. Friday: burpees, wall sits and side planks. Rest for a minute between rounds and add repetitions every week.",
      "ok",
    ],
  },
  {
    id: "spanish-translation",
    messages: [
      "Translate 'Where is the nearest train station?' into Spanish.",
      "¿Dónde está la estación de tren más cercana?",
      "and how do I say thank you very much?",
      "Muchas gracias.",
    ],
  },
  {
    id: "landlord-leak",
    messages: [
      "Write an email to my landlord about a leak under the kitchen sink.",
      "Subject: Leak under the kitchen sink\n\nHello, there is a leak under the kitchen sink that started on Monday. Water collects in the cabinet and the wood is getting soft. Could you send a plumber this week? I am at home in the evenings. Thank you.",
      "perfect",
    ],
  },
  {
    id: "budget-spreadsheet",
    messages: [
      "How should I set up a monthly budget spreadsheet?",
      "Use one column per month and rows for income, fixed costs such as rent and insurance, variable costs such as groceries and transport, and savings. Add a total row and a formula for what is left over at the end of the month.",
      "thanks, very helpful",
    ],
  },
  {
    id: "autumn-poem",
    messages: [
      "Write a short poem about autumn.",
      "Leaves of amber drift and fall,\nquiet rain on garden wall,\nshorter days and longer nights,\nwarm tea and the kitchen lights.",
      "nice",
    ],
  },
  {
    id: "guitar-chords",
    messages: [
      "Which guitar chords should a beginner learn first?",
      "Start with G, C, D, E minor and A minor. With those five chords you can play hundreds of songs. Practise switching between two of them slowly before speeding up.",
      "cool, thanks",
    ],
  },
  {
    id: "interview-prep",
    messages: [
      "I have a job interview tomorrow for a marketing role. What questions should I prepare for?",
      "Prepare to talk about a campaign you are proud of, how you measure success, a time you handled a tight deadline, and why you want this company. Have two questions ready for them about the team and their goals.",
      "thank you so much",
    ],
  },
  {
    id: "git-merge",
    messages: [
      "How do I resolve a merge conflict in git?",
      "Open the conflicting files, look for the <<<<<<< and >>>>>>> markers, keep the lines you want and delete the markers. Then run git add on the file and git commit to finish the merge.",
      "got it",
    ],
  },
  {
    id: "sql-query",
    messages: [
      "Write an SQL query that returns the ten customers with the highest total order value.",
      "SELECT customer_id, SUM(amount) AS total\nFROM orders\nGROUP BY customer_id\nORDER BY total DESC\nLIMIT 10;",
      "thanks",
    ],
  },
  {
    id: "laptop-choice",
    messages: [
      "Which laptop should I buy for university, my budget is about 800 euros?",
      "Look for at least 16 GB of memory, an SSD of 512 GB and a battery that lasts a full day. A lightweight 14-inch model is easiest to carry between lectures.",
      "ok, makes sense",
    ],
  },
  {
    id: "sleep-tips",
    messages: [
      "I can't fall asleep at night. Any tips?",
      "Keep the same bedtime every day, avoid screens for an hour before bed, keep the bedroom cool and dark, and avoid coffee after lunch.",
      "I'll try that, thanks",
    ],
  },
  {
    id: "dog-training",
    messages: [
      "How do I stop my puppy from biting my hands?",
      "When the puppy bites, say 'ouch' calmly, stop playing for a few seconds and offer a chew toy instead. Reward gentle play. Be consistent and everyone in the family should react the same way.",
      "thanks!",
    ],
  },
  {
    id: "houseplants",
    messages: [
      "The leaves of my monstera are turning yellow. What should I do?",
      "Yellow leaves often mean too much water. Let the top few centimetres of soil dry out before watering again, make sure the pot drains, and give the plant bright indirect light.",
      "ok",
    ],
  },
  {
    id: "wedding-speech",
    messages: [
      "I'm the best man at my brother's wedding. Can you help with an opening for the speech?",
      "Good evening everyone. For those who don't know me, I'm the groom's brother, which means I have twenty-five years of embarrassing stories, and I promised to tell only three of them tonight.",
      "haha love it",
    ],
  },
  {
    id: "car-maintenance",
    messages: [
      "How often should I change the oil in my car?",
      "Most modern cars need an oil change every 10,000 to 15,000 kilometres or once a year, whichever comes first. Check the owner's manual for the exact interval.",
      "thanks",
    ],
  },
  {
    id: "startup-name",
    messages: [
      "Give me some name ideas for a startup that rents out camping gear.",
      "Some ideas: TrailBox, Basecamp Rentals, GearLoop, Pitch & Go, and WildKit.",
      "I like GearLoop",
    ],
  },
  {
    id: "chess-opening",
    messages: [
      "What is a good chess opening for beginners?",
      "The Italian Game is a good start: 1. e4 e5 2. Nf3 Nc6 3. Bc4. It develops pieces quickly and teaches control of the centre.",
      "nice, thanks",
    ],
  },
  {
    id: "marathon",
    messages: [
      "I want to run my first marathon in six months. How should I train?",
      "Build up slowly: three to four runs a week, one long run that grows by about a kilometre each week, and an easy week every fourth week. Taper for the last two weeks before the race.",
      "ok great",
    ],
  },
  {
    id: "moving-checklist",
    messages: [
      "Make me a checklist for moving to a new apartment.",
      "Two weeks before: book movers, collect boxes, tell the post office. One week before: pack rooms you rarely use, arrange internet at the new place. Moving day: read the meters, photograph the old apartment and keep documents with you.",
      "very useful",
    ],
  },
  {
    id: "coffee-brewing",
    messages: [
      "How do I make better coffee with a French press?",
      "Use coarsely ground beans, about 60 grams per litre of water just off the boil. Stir, wait four minutes, press slowly and pour immediately so it doesn't over-extract.",
      "thanks!",
    ],
  },
  {
    id: "tax-question",
    messages: [
      "Can I deduct my home office from my taxes as an employee?",
      "It depends on the country. In many countries employees can only deduct a home office if the employer requires it and does not provide a workplace. Keep records of the room size and your costs and check the rules of your tax authority.",
      "ok, I'll check",
    ],
  },
  {
    id: "meditation",
    messages: [
      "How do I start meditating?",
      "Sit comfortably for five minutes, close your eyes and follow your breath. When your mind wanders, notice it and gently come back to the breath. Increase the time slowly.",
      "thank you",
    ],
  },
  {
    id: "norwegian-phrases",
    messages: [
      "Hvordan sier jeg 'good morning' på norsk?",
      "Du sier 'god morgen'.",
      "takk!",
    ],
  },
  {
    id: "book-summary",
    messages: [
      "Summarise the book 1984 in a few sentences.",
      "In a totalitarian state ruled by the Party and Big Brother, Winston Smith works rewriting history. He secretly rebels and falls in love with Julia, but both are caught, and Winston is broken until he loves Big Brother.",
      "thanks",
    ],
  },
  {
    id: "excel-formula",
    messages: [
      "What Excel formula adds up a column only when another column says 'paid'?",
      "Use SUMIF: =SUMIF(B:B, \"paid\", C:C). It adds the values in column C on rows where column B is 'paid'.",
      "works, thanks",
    ],
  },
  {
    id: "garden-tomatoes",
    messages: [
      "When should I plant tomatoes outside?",
      "Plant tomatoes outside after the last frost, when the nights stay above about 10 °C. Harden the seedlings off for a week first by putting them outside for a few hours a day.",
      "ok",
    ],
  },
];

const FILLER_TOPICS = [
  "fixing a squeaky door", "planning a picnic", "choosing a phone plan", "learning to knit", "writing a thank-you note",
  "organising a closet", "painting a bedroom", "cleaning a laptop keyboard", "picking running shoes", "setting up a router",
  "studying for an exam", "repotting a cactus", "booking a hotel", "renewing a passport", "keeping a journal",
  "starting a podcast", "choosing a camera", "hanging a shelf", "planning a road trip", "writing a resignation letter",
];
const ACKNOWLEDGEMENTS = ["thanks!", "ok", "thank you", "great, thanks", "perfect", "ok cool", "that helps", "nice", "got it, thanks", "awesome", "sounds good", "thx", "very helpful, thanks", "ok I'll try", "cool"];

/**
 * 300 short, chatter-heavy conversations on everyday topics: what makes an archive look
 * like a real one to search (more than half of all chunks are acknowledgements). With them,
 * before the M5.2 quality fix, "recipe" found `dinner-idea` at rank 8 and "debugging" found
 * `python-keyerror` at rank 11.
 */
export const CHAT_FILLER: ChatConversation[] = Array.from({ length: 300 }, (_, i) => {
  const topic = FILLER_TOPICS[i % FILLER_TOPICS.length]!;
  return {
    id: `filler-${i}`,
    messages: [
      `Can you give me some advice on ${topic}? (${i})`,
      `Sure. For ${topic}, start small, gather what you need first, and take it one step at a time. Variation ${i}.`,
      ACKNOWLEDGEMENTS[i % ACKNOWLEDGEMENTS.length]!,
      "You're welcome!",
      ACKNOWLEDGEMENTS[(i * 7) % ACKNOWLEDGEMENTS.length]!,
    ],
  };
});
