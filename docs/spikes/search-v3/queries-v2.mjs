// Search quality spike (2026-11-19): natural-language queries over the mind-map v2 synthetic set,
// written BEFORE any ranking variant was run (only the diagnosis of the first query had been
// seen). Relevance comes from the set's topic labels, decided per query here: grade 2 for the
// topic(s) the query is about, grade 1 for closely related topics. A conversation's grade is the
// highest grade among its labelled topics; one-offs are never relevant. Same author as the
// labels and the ranking code: a known bias, reported in the README.
export const QUERIES = [
  { id: "work-evening", text: "I can't stop thinking about work in the evening", grades: { stress: 2, sleep: 1, workplace: 1 } },
  { id: "sleep-wake", text: "why do I keep waking up in the middle of the night", grades: { sleep: 2, stress: 1 } },
  { id: "sourdough", text: "my bread doesn't rise properly", grades: { bread: 2, desserts: 1 } },
  { id: "dinner", text: "easy weeknight meals for the family", grades: { dinners: 2, nutrition: 1 } },
  { id: "coffee", text: "how to make better coffee at home", grades: { "coffee-tea": 2 } },
  { id: "pandas", text: "combining two tables of data in python", grades: { "py-data": 2, sql: 1 } },
  { id: "deploy", text: "putting my web app on a server", grades: { "git-devops": 2, "web-backend": 1 } },
  { id: "react", text: "my component renders too many times", grades: { frontend: 2 } },
  { id: "run-plan", text: "training schedule for my first race", grades: { running: 2, cycling: 1, strength: 1 } },
  { id: "gym", text: "building muscle with weights", grades: { strength: 2, nutrition: 1 } },
  { id: "bike", text: "problems with my bicycle", grades: { cycling: 2 } },
  { id: "budget", text: "how to save more money each month", grades: { budgeting: 2, investing: 1 } },
  { id: "tax", text: "what do I need to know about paying tax", grades: { taxes: 2 } },
  { id: "interview", text: "preparing for a job interview", grades: { interviews: 2, applications: 1 } },
  { id: "colleague", text: "a conflict with someone on my team", grades: { workplace: 2 } },
  { id: "exam", text: "studying for an exam when I procrastinate", grades: { exams: 2, stress: 1 } },
  { id: "language", text: "learning a new language as an adult", grades: { languages: 2 } },
  { id: "trip", text: "a weekend city break on a budget", grades: { "city-trips": 2, logistics: 1 } },
  { id: "hike", text: "what to bring on a mountain hike", grades: { hiking: 2, logistics: 1 } },
  { id: "cat", text: "my cat behaves strangely", grades: { cats: 2, dogs: 1 } },
  { id: "dog", text: "training a dog that pulls", grades: { dogs: 2 } },
  { id: "parents", text: "my elderly mother needs more help", grades: { elderly: 2, parenting: 1 } },
  { id: "toddler", text: "my child won't sleep or listen", grades: { parenting: 2, sleep: 1 } },
  { id: "plants", text: "leaves turning yellow on my indoor plant", grades: { houseplants: 2, vegetables: 1 } },
  { id: "renovate", text: "fixing up an old bathroom", grades: { renovation: 2, repairs: 1 } },
  { id: "landlord", text: "problems with my landlord", grades: { renting: 2, moving: 1 } },
  { id: "wifi", text: "the internet is slow at home", grades: { network: 2, devices: 1 } },
  { id: "phone", text: "choosing a new phone or laptop", grades: { devices: 2 } },
  { id: "speech", text: "writing a toast for a celebration", grades: { speeches: 2, fiction: 1 } },
  { id: "music", text: "practising an instrument with little time", grades: { music: 2 } },
  // Norwegian and Russian queries (cross-language retrieval)
  { id: "no-sleep", text: "jeg sover dårlig og våkner tidlig", grades: { sleep: 2, stress: 1 } },
  { id: "no-budget", text: "hvordan spare penger hver måned", grades: { budgeting: 2, investing: 1 } },
  { id: "ru-cat", text: "кошка ведёт себя странно", grades: { cats: 2, dogs: 1 } },
  { id: "ru-stress", text: "постоянный стресс на работе", grades: { stress: 2, workplace: 2 } },
];
