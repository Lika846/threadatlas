// Subject labels for the mind-map spike (2026-11-16). Written BEFORE any clustering was run,
// from titles and content of the synthetic conversations only. First tag = primary subject;
// further tags = genuine secondary subjects (a second topic in the conversation, not a single
// buried sentence). Same author as the clustering code: a known bias, see README.
//
// Tags (17): code, food, garden, fitness, health, home, moving, travel, languages, career,
// money, pets, devices, crafts, music, writing, occasions, study, transport, legal, business, games
export const LABELS = {
  // ---- chat corpus (en; titles derived from ids, as in topics.model.test.ts) ----
  "dinner-idea": ["food"],
  "python-keyerror": ["code"],
  sourdough: ["food"],
  "react-render": ["code"],
  "lisbon-trip": ["travel"],
  "cover-letter": ["career", "writing"],
  "birthday-mom": ["occasions", "writing"],
  photosynthesis: ["study"],
  "workout-plan": ["fitness"],
  "spanish-translation": ["languages"],
  "landlord-leak": ["home", "writing"],
  "budget-spreadsheet": ["money"],
  "autumn-poem": ["writing"],
  "guitar-chords": ["music"],
  "interview-prep": ["career"],
  "git-merge": ["code"],
  "sql-query": ["code"],
  "laptop-choice": ["devices"],
  "sleep-tips": ["health"],
  "dog-training": ["pets"],
  houseplants: ["garden"],
  "wedding-speech": ["occasions", "writing"],
  "car-maintenance": ["transport"],
  "startup-name": ["business"],
  "chess-opening": ["games"],
  marathon: ["fitness"],
  "moving-checklist": ["moving"],
  "coffee-brewing": ["food"],
  "tax-question": ["money"],
  meditation: ["health"],
  "norwegian-phrases": ["languages"],
  "book-summary": ["writing"],
  "excel-formula": ["code", "money"],
  "garden-tomatoes": ["garden"],
  // ---- M5.0 v0 set (en / no / ru) ----
  c01: ["garden"], // Balcony tomatoes
  c16: ["health"], // Sleep schedule
  c17: ["pets"], // Valpen bjeffer
  c18: ["career"], // Salary talk
  c13: ["devices"], // Apple Watch battery
  c02: ["transport", "fitness"], // Cycling to work in winter
  c03: ["languages", "travel"], // Learning Japanese for a trip
  c04: ["money"], // Quarterly budget spreadsheet
  c05: ["moving"], // Moving to a new flat
  c06: ["home"], // Bathroom renovation
  c22: ["code"], // Deployment keeps restarting
  c23: ["fitness"], // Marathon (ru)
  c24: ["occasions"], // Wedding planning
  c07: ["crafts"], // Birdhouse
  c08: ["crafts"], // Knitting a sweater
  c09: ["code", "money"], // Expense-tracking app
  c10: ["writing"], // Novel
  c25: ["code"], // Portfolio website (photography)
  c26: ["crafts"], // Restoring an old boat
  n01: ["crafts"], // Bookshelf finished
  n02: ["crafts"], // Knitted hat finished
  c11: ["code"], // Pandas groupby
  d01: ["pets"], // Ball python enclosure
  c12: ["money"], // Savings account
  d02: ["home"], // Cabin river bank
  d03: ["food"], // Apple pie
  c14: ["food"], // Salmon dinner
  d04: ["legal", "home"], // Neighbour's fence
  c15: ["home"], // Lost keys
  d05: ["transport"], // Bicycle pedal wrench
  c19: ["code"], // Database connection error
  c20: ["devices"], // Router guest network
  c21: ["money", "study"], // Student finance (Lånekassen)
  f01: ["travel"], // Weekend in Rome
  f02: ["home"], // Leaking tap
  f03: ["career", "writing"], // Cover letter
  f04: ["food"], // Pancakes
  f05: ["music"], // Learning guitar
  f06: ["occasions"], // Gift ideas
  f07: ["travel"], // Mountain day trip
  f08: ["money"], // Tax return
  f09: ["food"], // Bread baking
  f10: ["devices"], // New phone
  f11: ["garden"], // Hedge trimming
  f12: ["languages", "study"], // English oral exam
  f13: ["travel"], // Kazan weekend
  f14: ["food"], // Borscht
  f15: ["career"], // CV
  f16: ["pets"], // Cat not eating
  f17: ["languages", "career"], // Business English
  f18: ["fitness"], // Running shoes
  // ---- M5.0 long set (each has a second topic later in the conversation) ----
  L01: ["home"], // Spare-room office; 2nd: shed workshop (also home)
  L02: ["study", "career"], // Thesis plan; 2nd: conference talk
  L03: ["code", "games"], // Puzzle game in Godot
  L04: ["home"], // Cabin renovation; 2nd: solar panels (home)
  L05: ["fitness", "health"], // Running after knee surgery
  L06: ["business", "food"], // Bakery in Trondheim; 2nd: accountant
  L07: ["moving", "transport"], // Relocation; 2nd: moving the car
  L08: ["code", "career"], // Python for an accountant
  L09: ["garden"], // Dacha plot
};
