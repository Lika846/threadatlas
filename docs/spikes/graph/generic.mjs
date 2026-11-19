// Graph spike: a stress variant of the mind-map v2 synthetic set (docs/spikes/mindmap/v2) where
// 40% of conversations get one extra, generic assistant message in their own language: the kind of
// boilerplate ChatGPT adds ("I hope this helps! Let me know if…"). Deterministic (seeded).
// Usage: node docs/spikes/graph/generic.mjs <out.json>
import fs from "node:fs";

const out = process.argv[2];
if (!out) throw new Error("usage: generic.mjs <out.json>");
const convs = JSON.parse(fs.readFileSync("docs/spikes/mindmap/v2/conversations.json", "utf8"));
const labels = JSON.parse(fs.readFileSync("docs/spikes/mindmap/v2/labels.json", "utf8"));

const GENERIC = {
  en: [
    "I hope this helps! If you have any other questions or need further clarification on any of these points, feel free to ask. I'm happy to help you with anything else.",
    "Great question! Let me know if you would like me to go into more detail on any of these steps, or if there is anything else I can help you with today.",
    "Glad that worked for you! If you run into any other problems or want to explore this further, just let me know and we can go through it together step by step.",
    "You're welcome! Feel free to come back anytime if you have more questions. Good luck, and I hope everything goes smoothly for you from here.",
    "Of course! To summarise, the key points are above. If you want, I can also give you a short checklist or more examples so it is easier to follow.",
  ],
  no: [
    "Håper dette hjelper! Hvis du har flere spørsmål eller trenger mer forklaring på noen av punktene, er det bare å spørre. Jeg hjelper gjerne med noe annet også.",
    "Godt spørsmål! Si fra hvis du vil at jeg skal gå mer i detalj på noen av stegene, eller om det er noe annet jeg kan hjelpe deg med i dag.",
    "Så fint at det fungerte! Hvis du får andre problemer eller vil se nærmere på dette, er det bare å si fra, så går vi gjennom det sammen steg for steg.",
    "Bare hyggelig! Kom gjerne tilbake hvis du har flere spørsmål. Lykke til, og jeg håper alt går greit videre for deg.",
  ],
  ru: [
    "Надеюсь, это поможет! Если у вас есть другие вопросы или нужно больше пояснений по какому-либо пункту, просто спросите. Я с радостью помогу с чем-нибудь ещё.",
    "Отличный вопрос! Дайте знать, если хотите, чтобы я подробнее объяснил какой-то из шагов, или если я могу помочь с чем-то ещё.",
    "Рад, что получилось! Если возникнут другие проблемы или захотите разобраться глубже, напишите, и мы пройдём всё вместе шаг за шагом.",
    "Пожалуйста! Возвращайтесь в любое время, если появятся вопросы. Удачи, и надеюсь, дальше всё пойдёт гладко.",
  ],
};

let a = 20261118;
const rnd = () => {
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const generic = {};
const result = convs.map((c) => {
  if (rnd() >= 0.4) return c;
  const pool = GENERIC[labels[c.id].lang] ?? GENERIC.en;
  const text = pool[Math.floor(rnd() * pool.length)];
  generic[c.id] = c.messages.length; // index of the added message
  return { ...c, messages: [...c.messages, { role: "assistant", text }] };
});
fs.writeFileSync(out, JSON.stringify(result));
fs.writeFileSync(out.replace(/\.json$/, ".generic.json"), JSON.stringify(generic));
console.log(`${Object.keys(generic).length} of ${convs.length} conversations got a generic message → ${out}`);
