/**
 * A vocabulary of plain subject names for naming themes and topics (`naming.ts`). Server-only.
 *
 * The local multilingual model places each name near conversations about it in any language,
 * so a group of English, Norwegian and Russian conversations about sleep can be called "Sleep
 * problems". **Broad** names are candidates for themes, the others for topics. A group gets a
 * vocabulary name only when it fits clearly (`atlas.ts`); otherwise it is named by its words.
 *
 * Written as a general list of everyday subjects of chat-assistant conversations, not from any
 * particular archive. Editing it changes names only (never groups); `CONCEPTS_VERSION` must
 * change with it, which invalidates cached names and the precomputed vectors.
 */

export const CONCEPTS_VERSION = 1;

export type Concept = { name: string; broad: boolean };

const BROAD = [
  "Programming and software",
  "Computers, phones and gadgets",
  "Food and cooking",
  "Gardening and plants",
  "Fitness and sport",
  "Health and wellbeing",
  "Home and housing",
  "Money and personal finance",
  "Work and career",
  "Study and education",
  "Languages",
  "Travel and outdoors",
  "Family and relationships",
  "Pets and animals",
  "Writing and creativity",
  "Music",
  "Arts and crafts",
  "Paperwork, law and bureaucracy",
  "Science and nature",
  "History and culture",
  "Society and politics",
  "Business and marketing",
  "Cars and transport",
  "Games and entertainment",
  "Shopping and products",
  "Events and celebrations",
  "Beauty and fashion",
  "Philosophy and religion",
];

const SPECIFIC = [
  // programming and devices
  "Python and data analysis",
  "Spreadsheets and Excel",
  "SQL and databases",
  "Web backends and APIs",
  "Frontend and React",
  "Git and version control",
  "Deployment and DevOps",
  "Automation and scripts",
  "Mobile apps",
  "Machine learning and AI",
  "Security and passwords",
  "Laptops and computers",
  "Phones and tablets",
  "Home network and Wi-Fi",
  "Smart home devices",
  // food and garden
  "Dinner recipes and meal planning",
  "Bread and baking",
  "Desserts and cakes",
  "Coffee and tea",
  "Cocktails and wine",
  "Vegetarian cooking",
  "Vegetable garden",
  "Houseplants",
  "Lawn and garden care",
  // fitness and health
  "Running and races",
  "Strength training and gym",
  "Cycling and bikes",
  "Yoga and stretching",
  "Swimming",
  "Team sports",
  "Sleep problems",
  "Stress and anxiety",
  "Nutrition and diet",
  "Weight loss",
  "Pain and injuries",
  "Illness and symptoms",
  "Medication",
  "Mental health and therapy",
  "Pregnancy and birth",
  // home and money
  "Renovation",
  "Home repairs",
  "Cleaning and organising",
  "Furniture and interior design",
  "Energy and heating",
  "Budgeting and saving",
  "Taxes",
  "Investing and funds",
  "Loans and mortgages",
  "Insurance",
  "Pensions",
  // work and study
  "Job applications and CVs",
  "Job interviews",
  "Colleagues and managers",
  "Workload and burnout",
  "Career change",
  "Salary negotiation",
  "Freelancing",
  "Meetings and productivity",
  "Exams and studying",
  "Thesis and research",
  "Homework help",
  "University applications",
  "Mathematics",
  "Physics",
  "Chemistry",
  "Biology",
  "Learning a language",
  "Translation",
  "Grammar and spelling",
  // travel and family
  "City trips",
  "Hiking and camping",
  "Flights and train travel",
  "Packing",
  "Beach holidays",
  "Parenting young children",
  "Teenagers",
  "Relationships and dating",
  "Friendship",
  "Elderly parents",
  "Weddings",
  "Divorce and separation",
  "Dogs",
  "Cats",
  "Other pets",
  // creative
  "Fiction and stories",
  "Poetry",
  "Speeches and toasts",
  "Emails and letters",
  "Essays",
  "Learning an instrument",
  "Singing",
  "Music production",
  "Songwriting",
  "Knitting and sewing",
  "Woodworking",
  "Drawing and painting",
  "Pottery",
  "Photography",
  // admin, science and the rest
  "Moving house",
  "Renting and landlords",
  "Residence permits and visas",
  "Government forms",
  "Consumer rights and complaints",
  "Contracts",
  "Space and astronomy",
  "Animals and nature",
  "Weather and climate",
  "The human body",
  "History",
  "Philosophy",
  "Religion",
  "Politics",
  "Economics",
  "Cars and driving",
  "Public transport",
  "Video games",
  "Board games and puzzles",
  "Film and TV",
  "Books",
  "Gifts",
  "Fashion and clothes",
  "Skincare and beauty",
  "Birthdays and parties",
  "Holidays and Christmas",
];

export const CONCEPTS: readonly Concept[] = [...BROAD.map((name) => ({ name, broad: true })), ...SPECIFIC.map((name) => ({ name, broad: false }))];

/** The shape of `concept-vectors.generated.ts` (written by `npm run concepts:embed`). */
export type ConceptVectorFile = {
  readonly conceptsVersion: number;
  readonly embeddingVersion: string;
  readonly namesHash: string;
  /** One base64 int8-quantised vector per concept, in `CONCEPTS` order. */
  readonly vectors: readonly string[];
};
