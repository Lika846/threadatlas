// M5.0 synthetic multilingual evaluation set, v0 (2026-11-09). Entirely invented text;
// no real conversation data. Languages: en, no (Bokmål), ru.
//
// Conversations: { id, lang, title, kind, messages: [user, assistant, user, ...] }
//   kind: target | decoy | negative (hard negative) | filler
// Queries: { id, category, lang, text, relevant: { convId: grade }, target?: [convId, messageNumber | messageNumber[]] }
//   grade 2 = what the query is about, 1 = partially relevant. messageNumber is 1-based
//   among the conversation's displayed messages (the number shown in the app).
// Categories: paraphrase, crosslingual, buried, decoy, unfinished, keyword (control).

const rep = (sentences, n) => Array.from({ length: n }, (_, i) => sentences[i % sentences.length]).join(" ");

// Topic-specific sentence banks for long conversations (buried ideas sit inside them).
const BUDGET_EN = [
  "Start with one sheet per quarter and a summary sheet that pulls the totals with SUMIFS.",
  "Keep categories short and consistent, for example housing, food, transport and savings.",
  "A pivot table can show how each category changes from month to month.",
  "Use data validation so every row gets a category from the same list.",
  "Conditional formatting helps you spot months where a category is over its limit.",
  "Freeze the header row so the column names stay visible while you scroll.",
];
const MOVING_NO = [
  "Lag en liste over alle rom og hva som skal pakkes i hvert av dem.",
  "Bestill flyttebil i god tid, særlig hvis du flytter ved månedsskiftet.",
  "Merk eskene med rom og innhold på to sider, så blir det lettere å bære dem riktig sted.",
  "Husk å melde flytting til Folkeregisteret og å flytte strømavtalen.",
  "Ta bilder av målerstanden i den gamle leiligheten før du leverer nøklene.",
  "Pakk en egen eske med det du trenger den første kvelden.",
];
const BATHROOM_RU = [
  "Сначала нужно проверить гидроизоляцию пола и стен в зоне душа.",
  "Плитку лучше покупать с запасом примерно в десять процентов.",
  "Затирку для швов в душевой выбирайте эпоксидную, она меньше впитывает влагу.",
  "Вентиляция в ванной должна работать хорошо, иначе появится плесень.",
  "Трубы стоит заменить до укладки плитки, пока к ним есть доступ.",
  "Смеситель с термостатом удобнее, но стоит дороже обычного.",
];
const K8S_EN = [
  "Check the pod events with kubectl describe to see why the container keeps restarting.",
  "A CrashLoopBackOff often means the process exits right after start, so read the previous logs.",
  "Make sure the readiness probe points to a path that responds quickly.",
  "Resource limits that are too low can make the container get killed for running out of memory.",
  "Roll back with kubectl rollout undo if the new image is broken.",
  "Keep the deployment manifest in version control so every change is reviewed.",
];
const MARATHON_RU = [
  "Длинную пробежку делайте раз в неделю и увеличивайте её не больше чем на десять процентов.",
  "Большую часть тренировок нужно бегать в лёгком темпе, когда можно разговаривать.",
  "За три недели до старта объём тренировок постепенно снижают.",
  "На дистанции пейте понемногу на каждом пункте питания.",
  "Кроссовки для марафона лучше разносить заранее, а не надевать новые в день старта.",
  "Силовые упражнения для ног и корпуса помогают избежать травм.",
];
const WEDDING_NO = [
  "Sett opp et budsjett først, og fordel det på lokale, mat, musikk og pynt.",
  "Book lokalet tidlig, særlig hvis dere vil gifte dere en lørdag i juni.",
  "Lag en gjesteliste i et regneark med kolonner for svar og allergier.",
  "Snakk med fotografen om hvilke bilder som er viktigst for dere.",
  "En detaljert tidsplan for dagen gjør det lettere for toastmasteren.",
  "Send ut invitasjoner minst tre måneder før.",
];

export const conversations = [
  // ---------- paraphrase targets ----------
  { id: "c01", lang: "en", kind: "target", title: "Balcony tomatoes", messages: [
    "My tomatoes on the balcony dry out every afternoon in July. Any ideas?",
    "Mulch the pots, water early in the morning and move them out of the hottest sun if you can.",
    "I was thinking of putting a barrel under the gutter and running a thin hose from it to the pots, so they get the rain we collect.",
    "That works: raise the barrel on bricks so gravity pushes the water through a drip line, and add a mesh lid against mosquitoes.",
  ] },
  { id: "c16", lang: "en", kind: "target", title: "Sleep schedule", messages: [
    "For weeks I keep waking up at 4 am and then I just lie there until the alarm goes off.",
    "Waking long before you need to and not getting back to sleep is common with stress. Keep the same wake time every day and avoid screens if you wake.",
    "Should I just get up when it happens?",
    "If you are awake for more than about twenty minutes, get up, do something calm in dim light, and go back to bed when you feel sleepy.",
  ] },
  { id: "c17", lang: "no", kind: "target", title: "Valpen bjeffer", messages: [
    "Valpen vår bjeffer og hyler hele tiden når vi går på jobb og hun er alene hjemme.",
    "Det høres ut som hun blir urolig når dere drar. Øv på korte fravær først, noen minutter, og øk gradvis.",
    "Hjelper det å gi henne et tyggeleke når vi går?",
    "Ja, et tyggeleke eller en aktivitetsball kan gjøre avreisen til noe positivt. Ikke gjør noe stort nummer ut av å gå eller komme hjem.",
  ] },
  { id: "c18", lang: "ru", kind: "target", title: "Разговор о зарплате", messages: [
    "Через неделю у меня встреча с руководителем, и я хочу попросить больше денег. Как это сделать?",
    "Подготовьте список результатов за год и узнайте, сколько платят за похожую работу на рынке.",
    "Какую сумму назвать первой?",
    "Назовите конкретную цифру немного выше той, на которую готовы согласиться, и объясните, почему ваша работа её стоит.",
  ] },
  { id: "c13", lang: "en", kind: "target", title: "Apple Watch question", messages: [
    "Since the last update my Apple Watch is empty by lunchtime. It used to last two days.",
    "After an update the watch often re-indexes for a day or two. If it continues, check which apps refresh in the background and turn off the always-on display.",
    "It is still bad after a week.",
    "Then unpair and pair it again, and look at the battery health in Settings; a worn battery can drain much faster.",
  ] },
  // ---------- cross-lingual targets ----------
  { id: "c02", lang: "no", kind: "target", title: "Sykle til jobben om vinteren", messages: [
    "Jeg vil fortsette å sykle til jobben i vinter. Hva trenger jeg?",
    "Piggdekk er det viktigste når det er is. Kjøp også gode lys foran og bak og en refleksvest.",
    "Hva med klær? Jeg blir svett, men fryser på hendene.",
    "Kle deg i lag med ull innerst, et vindtett ytterlag og tykke votter eller lobstervotter.",
  ] },
  { id: "c03", lang: "ru", kind: "target", title: "Учу японский", messages: [
    "Хочу выучить японский к поездке через год. С чего начать?",
    "Начните с хираганы и катаканы, а слова учите по карточкам с интервальными повторениями, например в Anki.",
    "Сколько новых слов в день добавлять?",
    "Десять–пятнадцать новых карточек в день достаточно; главное — повторять каждый день.",
  ] },
  // ---------- buried-idea targets (long conversations) ----------
  { id: "c04", lang: "en", kind: "target", title: "Quarterly budget spreadsheet", messages: [
    "Can you help me set up a spreadsheet for our household budget?",
    rep(BUDGET_EN, 12),
    "How do I handle irregular costs like car repairs?",
    rep(BUDGET_EN.slice(2), 8) + " By the way, since you keep the paper receipts in a drawer, you could photograph each one with your phone and file the pictures in folders by month, so the receipts become a small archive you can search later. " + rep(BUDGET_EN, 8),
    "Thanks, and should savings be a category?",
    rep(BUDGET_EN.slice(1), 10),
  ] },
  { id: "c05", lang: "no", kind: "target", title: "Flytting til ny leilighet", messages: [
    "Vi flytter om tre uker. Kan du lage en plan?",
    rep(MOVING_NO, 12),
    "Hva gjør vi med alle de gamle avisene og bildene fra nabolaget som vi fant på loftet?",
    rep(MOVING_NO.slice(1), 8) + " Forresten, de gamle bildene og avisene kunne vært utgangspunkt for en liten podkast der dere forteller hvordan strøket har forandret seg, og intervjuer de eldste naboene. " + rep(MOVING_NO, 8),
    "Takk! Og nøkkelen til boden?",
    rep(MOVING_NO.slice(2), 10),
  ] },
  { id: "c06", lang: "ru", kind: "target", title: "Ремонт ванной", messages: [
    "Начинаем ремонт ванной. Что сделать в первую очередь?",
    rep(BATHROOM_RU, 12),
    "Пока идёт ремонт, цветы с подоконника в ванной стоят в коридоре, и я всё время забываю их поливать.",
    rep(BATHROOM_RU.slice(1), 8) + " Кстати, можно написать маленького телеграм-бота, который раз в несколько дней присылает напоминание полить цветы. " + rep(BATHROOM_RU, 8),
    "А какую плитку выбрать на пол?",
    rep(BATHROOM_RU.slice(2), 10),
  ] },
  { id: "c22", lang: "en", kind: "target", title: "Deployment keeps restarting", messages: [
    "Our service keeps restarting after the last deploy. Where do I start?",
    rep(K8S_EN, 12),
    "We had three of these incidents this month and nobody remembers what fixed them.",
    rep(K8S_EN.slice(1), 8) + " One idea: write a short weekly note for the team that sums up each incident, what caused it and how it was fixed, and send it every Friday. " + rep(K8S_EN, 8),
    "Ok, and the memory limits?",
    rep(K8S_EN.slice(2), 10),
  ] },
  { id: "c23", lang: "ru", kind: "target", title: "Подготовка к марафону", messages: [
    "Я хочу пробежать первый марафон весной. Помоги составить план.",
    rep(MARATHON_RU, 12),
    "Летом на длинных пробежках мне всегда не хватает воды в городе.",
    rep(MARATHON_RU.slice(1), 8) + " Кстати, можно сделать карту всех питьевых фонтанчиков в городе и поделиться ею с другими бегунами. " + rep(MARATHON_RU, 8),
    "А сколько раз в неделю бегать?",
    rep(MARATHON_RU.slice(2), 10),
  ] },
  { id: "c24", lang: "no", kind: "target", title: "Planlegge bryllup", messages: [
    "Vi skal gifte oss neste sommer. Hvor begynner vi?",
    rep(WEDDING_NO, 12),
    "Vi har bestilt altfor mange blomster, tror jeg.",
    rep(WEDDING_NO.slice(1), 8) + " En idé: tørk blomstene som blir til overs og lag små buketter som dere sender til gjestene som takk etter bryllupet. " + rep(WEDDING_NO, 8),
    "Og musikken?",
    rep(WEDDING_NO.slice(2), 10),
  ] },
  // ---------- unfinished projects (and finished hard negatives) ----------
  { id: "c07", lang: "en", kind: "target", title: "Birdhouse plans", messages: [
    "I'm building a birdhouse for blue tits. I've cut all the panels from cedar.",
    "Great. The entrance hole should be 25 mm for blue tits, about 12 cm above the floor.",
    "I haven't drilled the hole or put the roof on yet. I'll get back to it next weekend, the parts are in the shed.",
    "When you continue: drill the hole, attach the roof with hinges so you can clean it, and hang it facing north-east.",
  ] },
  { id: "c08", lang: "no", kind: "target", title: "Strikke genser", messages: [
    "Jeg strikker min første genser etter en oppskrift med raglan.",
    "Raglan er fint for en første genser. Strikk en prøvelapp først så du får riktig strikkefasthet.",
    "Bolen og det ene ermet er ferdig, men så la jeg den bort. Den har ligget i en kurv siden mars.",
    "Neste steg er det andre ermet; skriv ned hvor mange masker og omganger du brukte på det første, så blir de like.",
  ] },
  { id: "c09", lang: "ru", kind: "target", title: "Приложение для учёта расходов", messages: [
    "Хочу сделать своё мобильное приложение, чтобы записывать траты.",
    "Начните с модели данных: операция, категория, сумма, дата. Потом простой экран добавления.",
    "Модель данных и первый экран я сделал, а потом отложил проект до лучших времён.",
    "Когда вернётесь к нему, следующий шаг — список операций за месяц и экспорт в CSV.",
  ] },
  { id: "c10", lang: "en", kind: "target", title: "Novel: the lighthouse keeper", messages: [
    "I'm writing a novel about a lighthouse keeper who finds letters in the walls.",
    "A strong premise. Decide early who wrote the letters and what the keeper wants.",
    "I wrote three chapters last winter and then got stuck. I haven't opened the document since.",
    "To restart, write a one-page outline of the remaining chapters, then write the next scene even if it is rough.",
  ] },
  { id: "c25", lang: "ru", kind: "target", title: "Сайт-портфолио", messages: [
    "Делаю сайт-портфолио со своими фотографиями.",
    "Выберите десять лучших работ и простой шаблон с галереей.",
    "Шаблон выбрал, загрузил пять фото, но так и не закончил — страница «Обо мне» до сих пор пустая.",
    "Чтобы закончить, напишите короткий текст о себе, добавьте контакты и опубликуйте сайт.",
  ] },
  { id: "c26", lang: "no", kind: "target", title: "Restaurere gammel båt", messages: [
    "Jeg har kjøpt en gammel trebåt som skal restaureres.",
    "Start med å skrape bunnen og sjekke om plankene er råtne.",
    "Bunnen er skrapt, men jeg kom aldri videre. Båten har stått under en presenning i to år.",
    "Når du tar det opp igjen: bytt de råtne plankene, og olje treverket før du maler.",
  ] },
  { id: "n01", lang: "en", kind: "negative", title: "Bookshelf finished", messages: [
    "I finished the oak bookshelf this weekend!",
    "Congratulations! How did the finish turn out?",
    "Two coats of oil, it's in the living room and already full of books.",
    "It sounds great. Remember to check that it is anchored to the wall.",
  ] },
  { id: "n02", lang: "no", kind: "negative", title: "Ferdig med lua", messages: [
    "Endelig ferdig med den strikkede lua til datteren min!",
    "Så fint! Hvilket garn brukte du?",
    "Merinoull, og hun har brukt den hver dag siden.",
    "Vask den forsiktig i kaldt vann, så holder den lenge.",
  ] },
  // ---------- keyword decoys ----------
  { id: "c11", lang: "en", kind: "target", title: "Pandas groupby question", messages: [
    "In Python, how do I sum sales per region with pandas?",
    "Use df.groupby('region')['sales'].sum(), and reset_index() if you want a DataFrame back.",
    "And the average per month?",
    "Group by both columns: df.groupby(['region', 'month'])['sales'].mean().",
  ] },
  { id: "d01", lang: "en", kind: "decoy", title: "Ball python enclosure", messages: [
    "My ball python's shed came off in pieces. Is the enclosure too dry?",
    "Ball pythons need 55–60 % humidity, higher during shedding. Add a humid hide with damp moss.",
    "Should I mist the terrarium?",
    "Light misting helps, but avoid soaking the substrate; check with a hygrometer.",
  ] },
  { id: "c12", lang: "en", kind: "target", title: "Savings account", messages: [
    "Which bank gives the best interest on a savings account right now?",
    "Compare the effective annual rate and check whether the rate is fixed or can change.",
    "Is it safe to keep everything in one bank?",
    "Deposits are usually guaranteed up to a limit per bank, so spread larger amounts.",
  ] },
  { id: "d02", lang: "en", kind: "decoy", title: "Cabin by the river", messages: [
    "The river bank next to our cabin is washing away after the spring floods.",
    "Plant willow cuttings along the bank; their roots hold the soil. Large stones at the bottom also help.",
    "Can we do it ourselves?",
    "Small sections, yes; for long stretches ask the municipality, since work in rivers often needs a permit.",
  ] },
  { id: "d03", lang: "en", kind: "decoy", title: "Apple pie", messages: [
    "Give me a simple apple pie recipe.",
    "Slice six apples, mix with sugar and cinnamon, put them in a pastry shell, cover and bake for 45 minutes at 190 °C.",
    "Which apples are best?",
    "Firm, slightly sour apples keep their shape when baked.",
  ] },
  { id: "c14", lang: "no", kind: "target", title: "Middag med laks", messages: [
    "Jeg trenger en rask rett til middag, jeg har laks i kjøleskapet.",
    "Stek laksen i ovnen med sitron og dill i femten minutter, og server med poteter og brokkoli.",
    "Kan jeg lage en saus?",
    "Rør sammen rømme, sitron og dill, så har du en enkel saus.",
  ] },
  { id: "d04", lang: "no", kind: "decoy", title: "Nabokrangel", messages: [
    "Naboen har satt opp et gjerde på vår side av tomtegrensen. Har jeg rett til å få det fjernet?",
    "Start med å få grensen målt opp av kommunen. Hvis dere ikke blir enige, kan saken gå til forliksrådet og senere til tingretten.",
    "Hvor lang tid tar det i retten?",
    "Det kan ta måneder; mange slike saker løses med mekling før det blir rettssak.",
  ] },
  { id: "c15", lang: "ru", kind: "target", title: "Потерял ключи", messages: [
    "Не могу найти ключи от квартиры, а запасных нет.",
    "Проверьте карманы вчерашней одежды и сумку; позвоните туда, где были вчера.",
    "Если не найду?",
    "Вызовите мастера по вскрытию замков и потом поменяйте личинку замка.",
  ] },
  { id: "d05", lang: "ru", kind: "decoy", title: "Велосипедный ключ", messages: [
    "Какой ключ нужен, чтобы снять педали с велосипеда?",
    "Обычно педальный ключ на 15 мм; на некоторых педалях — шестигранник на 8 мм.",
    "В какую сторону откручивать левую?",
    "Левая педаль откручивается по часовой стрелке, у неё обратная резьба.",
  ] },
  // ---------- keyword controls ----------
  { id: "c19", lang: "en", kind: "target", title: "Database connection error", messages: [
    "My app fails with ECONNREFUSED 127.0.0.1:5432 when it starts.",
    "Port 5432 is PostgreSQL. The server is probably not running or is listening on another address.",
    "It runs in Docker.",
    "Then publish the port with -p 5432:5432 or connect to the container's host name instead of localhost.",
  ] },
  { id: "c20", lang: "ru", kind: "target", title: "Настройка роутера", messages: [
    "Купил роутер Keenetic, как настроить гостевую сеть?",
    "В веб-интерфейсе откройте раздел «Домашняя сеть» и создайте гостевой сегмент с отдельным паролем.",
    "А ограничить скорость можно?",
    "Да, в настройках сегмента можно задать ограничение скорости для гостей.",
  ] },
  { id: "c21", lang: "no", kind: "target", title: "Studiefinansiering", messages: [
    "Når må jeg søke om stipend og lån fra Lånekassen for høsten?",
    "Du kan søke fra våren; søk før 15. november for høstsemesteret for å få full støtte.",
    "Får jeg mer stipend hvis jeg bor hjemmefra?",
    "Ja, borteboere kan få en del av lånet gjort om til stipend når de består eksamen.",
  ] },
  // ---------- fillers ----------
  { id: "f01", lang: "en", kind: "filler", title: "Weekend in Rome", messages: ["Plan two days in Rome for me.", "Day one: Colosseum, Forum and Trastevere in the evening. Day two: Vatican Museums and the Pantheon.", "Where should we eat?", "Try a trattoria away from the main squares; book ahead on weekends."] },
  { id: "f02", lang: "en", kind: "filler", title: "Leaking tap", messages: ["The kitchen tap drips all night.", "Usually the washer or cartridge is worn. Turn off the water under the sink before you open it.", "Do I need special tools?", "An adjustable spanner and a screwdriver are usually enough."] },
  { id: "f03", lang: "en", kind: "filler", title: "Cover letter", messages: ["Help me start a cover letter for a project manager job.", "Open with the role and one concrete result you are proud of.", "How long should it be?", "Keep it under one page, three or four short paragraphs."] },
  { id: "f04", lang: "en", kind: "filler", title: "Pancakes", messages: ["Easy pancake recipe?", "Mix 2 eggs, 250 ml milk and 125 g flour, rest the batter and fry in butter.", "Can I make them vegan?", "Use oat milk and a mashed banana instead of eggs."] },
  { id: "f05", lang: "en", kind: "filler", title: "Learning guitar", messages: ["Which chords should a beginner learn first?", "G, C, D, E minor and A minor cover many songs.", "My fingertips hurt.", "That is normal for the first weeks; practise in short sessions."] },
  { id: "f06", lang: "en", kind: "filler", title: "Gift ideas", messages: ["Gift for my father who likes fishing?", "A good thermos, a tackle box organiser or a guided fishing trip.", "Something under 30 euros?", "Quality lures or a waterproof phone case."] },
  { id: "f07", lang: "no", kind: "filler", title: "Tur i fjellet", messages: ["Hva bør jeg pakke til en dagstur i fjellet?", "Vindjakke, ull, kart, kompass, mat og drikke, og førstehjelpsutstyr.", "Trenger jeg brodder?", "Tidlig på sommeren kan det ligge snø; sjekk forholdene før du drar."] },
  { id: "f08", lang: "no", kind: "filler", title: "Skattemelding", messages: ["Når må skattemeldingen leveres?", "Fristen er normalt 30. april.", "Kan jeg få utsettelse?", "Du kan søke om utsettelse på Skatteetatens nettsider."] },
  { id: "f09", lang: "no", kind: "filler", title: "Brødbaking", messages: ["Hvordan baker jeg grovbrød?", "Bruk halvparten sammalt hvete, la deigen heve i en time, form og etterhev.", "Hvor lenge skal det stekes?", "Omtrent 50 minutter på 200 grader."] },
  { id: "f10", lang: "no", kind: "filler", title: "Ny telefon", messages: ["Hvordan flytter jeg alt til den nye telefonen?", "Ta sikkerhetskopi av den gamle og velg gjenoppretting når du starter den nye.", "Blir bildene med?", "Ja, hvis de er med i sikkerhetskopien."] },
  { id: "f11", lang: "no", kind: "filler", title: "Hagearbeid", messages: ["Når skal jeg klippe hekken?", "Tidlig sommer og igjen sent på sommeren.", "Kan jeg klippe den nå i oktober?", "Litt formklipp går fint, men ikke klipp hardt så sent."] },
  { id: "f12", lang: "no", kind: "filler", title: "Engelsk eksamen", messages: ["Hvordan forbereder jeg meg til muntlig eksamen i engelsk?", "Øv på å snakke om temaene høyt, gjerne med noen som stiller spørsmål.", "Jeg blir nervøs.", "Pust rolig og øv på åpningen din til den sitter."] },
  { id: "f13", lang: "ru", kind: "filler", title: "Поездка в Казань", messages: ["Что посмотреть в Казани за выходные?", "Кремль, улицу Баумана и набережную; вечером — национальную кухню.", "Сколько нужно денег?", "Зависит от гостиницы; заранее посмотрите цены."] },
  { id: "f14", lang: "ru", kind: "filler", title: "Борщ", messages: ["Как сварить борщ?", "Сварите бульон, добавьте свёклу, капусту, картофель и морковь, в конце — чеснок и зелень.", "Сколько варить?", "Около полутора часов с бульоном."] },
  { id: "f15", lang: "ru", kind: "filler", title: "Резюме", messages: ["Помоги улучшить резюме для аналитика.", "Начните с краткого описания и укажите конкретные результаты в цифрах.", "Нужно ли фото?", "Не обязательно; важнее опыт и навыки."] },
  { id: "f16", lang: "ru", kind: "filler", title: "Кот не ест", messages: ["Кот второй день плохо ест.", "Если он вялый или не пьёт, сходите к ветеринару.", "Он активный, просто не ест сухой корм.", "Попробуйте влажный корм и проверьте, свежая ли вода."] },
  { id: "f17", lang: "ru", kind: "filler", title: "Английский для работы", messages: ["Как быстро улучшить деловой английский?", "Читайте рабочую переписку на английском и выписывайте полезные фразы.", "А разговорную речь?", "Найдите собеседника и разговаривайте хотя бы раз в неделю."] },
  { id: "f18", lang: "en", kind: "filler", title: "Running shoes", messages: ["How often should I replace running shoes?", "Roughly every 600–800 km.", "How do I know they're worn?", "The cushioning feels flat and the outsole is worn through."] },
];

export const queries = [
  // paraphrase (same language, different words)
  { id: "p01", category: "paraphrase", lang: "en", text: "watering potted plants with collected rainwater", relevant: { c01: 2 }, target: ["c01", 3] },
  { id: "p02", category: "paraphrase", lang: "en", text: "insomnia early morning awakening", relevant: { c16: 2 }, target: ["c16", 1] },
  { id: "p03", category: "paraphrase", lang: "no", text: "separasjonsangst hos hunden", relevant: { c17: 2 }, target: ["c17", 1] },
  { id: "p04", category: "paraphrase", lang: "ru", text: "переговоры о повышении оплаты труда", relevant: { c18: 2 }, target: ["c18", 1] },
  { id: "p05", category: "paraphrase", lang: "en", text: "smartwatch battery drains fast", relevant: { c13: 2 }, target: ["c13", [1, 4]] },
  { id: "p06", category: "paraphrase", lang: "en", text: "weekly summary of production outages for colleagues", relevant: { c22: 2 }, target: ["c22", 4] },
  // cross-lingual
  { id: "x01", category: "crosslingual", lang: "en", text: "cycling to work in winter with studded tyres", relevant: { c02: 2 }, target: ["c02", 2] },
  { id: "x02", category: "crosslingual", lang: "en", text: "learning Japanese vocabulary with flashcards", relevant: { c03: 2 }, target: ["c03", 2] },
  { id: "x03", category: "crosslingual", lang: "no", text: "samle regnvann til tomatene på balkongen", relevant: { c01: 2 }, target: ["c01", 3] },
  { id: "x04", category: "crosslingual", lang: "ru", text: "просыпаюсь в четыре утра и не могу уснуть", relevant: { c16: 2 }, target: ["c16", 1] },
  { id: "x05", category: "crosslingual", lang: "en", text: "how to ask my boss for a raise", relevant: { c18: 2 }, target: ["c18", 1] },
  { id: "x06", category: "crosslingual", lang: "en", text: "puppy barks when left home alone", relevant: { c17: 2 }, target: ["c17", 1] },
  // buried ideas
  { id: "b01", category: "buried", lang: "en", text: "idea to archive paper receipts by photographing them", relevant: { c04: 2 }, target: ["c04", 4] },
  { id: "b02", category: "buried", lang: "no", text: "starte en podkast om historien til nabolaget", relevant: { c05: 2 }, target: ["c05", 4] },
  { id: "b03", category: "buried", lang: "en", text: "chat bot that reminds me to water the plants", relevant: { c06: 2 }, target: ["c06", 4] },
  { id: "b04", category: "buried", lang: "ru", text: "карта питьевых фонтанчиков для бегунов", relevant: { c23: 2 }, target: ["c23", 4] },
  { id: "b05", category: "buried", lang: "no", text: "tørkede blomster som takkegave til gjestene", relevant: { c24: 2 }, target: ["c24", 4] },
  { id: "b06", category: "buried", lang: "en", text: "newsletter summarising incidents every Friday", relevant: { c22: 2 }, target: ["c22", 4] },
  // keyword decoys: each query shares only the ambiguous word (python, bank, apple, rett, ключ)
  // with both the target and the decoy; the rest is paraphrased (revised after the first baseline run)
  { id: "d01", category: "decoy", lang: "en", text: "my python's skin is peeling off in bits", relevant: { d01: 2 }, target: ["d01", 1] },
  { id: "d02", category: "decoy", lang: "en", text: "python totals for each category in a table", relevant: { c11: 2 }, target: ["c11", 1] },
  { id: "d03", category: "decoy", lang: "en", text: "the bank is crumbling into the water", relevant: { d02: 2 }, target: ["d02", 1] },
  { id: "d04", category: "decoy", lang: "en", text: "which bank pays most for money I put aside", relevant: { c12: 2 }, target: ["c12", 1] },
  { id: "d05", category: "decoy", lang: "en", text: "apple dessert for the oven", relevant: { d03: 2 }, target: ["d03", 2] },
  { id: "d06", category: "decoy", lang: "no", text: "en rett med fisk", relevant: { c14: 2 }, target: ["c14", 1] },
  { id: "d07", category: "decoy", lang: "ru", text: "ключ потерялся, не попасть домой", relevant: { c15: 2 }, target: ["c15", 1] },
  // unfinished projects
  { id: "u01", category: "unfinished", lang: "en", text: "woodworking project I never finished", relevant: { c07: 2, c26: 1 }, target: ["c07", 3] },
  { id: "u02", category: "unfinished", lang: "en", text: "knitting project left half done", relevant: { c08: 2 }, target: ["c08", 3] },
  { id: "u03", category: "unfinished", lang: "en", text: "abandoned expense tracking app", relevant: { c09: 2 }, target: ["c09", 3] },
  { id: "u04", category: "unfinished", lang: "no", text: "romanprosjekt som stoppet opp", relevant: { c10: 2 }, target: ["c10", 3] },
  { id: "u05", category: "unfinished", lang: "en", text: "projects I started but never finished", relevant: { c07: 2, c08: 2, c09: 2, c10: 2, c25: 2, c26: 2 } },
  { id: "u06", category: "unfinished", lang: "no", text: "prosjekter jeg aldri ble ferdig med", relevant: { c07: 2, c08: 2, c09: 2, c10: 2, c25: 2, c26: 2 } },
  { id: "u07", category: "unfinished", lang: "ru", text: "незаконченные проекты, которые я забросил", relevant: { c07: 2, c08: 2, c09: 2, c10: 2, c25: 2, c26: 2 } },
  // keyword controls (exact words should work)
  { id: "k01", category: "keyword", lang: "en", text: "ECONNREFUSED 5432", relevant: { c19: 2 }, target: ["c19", 1] },
  { id: "k02", category: "keyword", lang: "ru", text: "Keenetic гостевая сеть", relevant: { c20: 2 }, target: ["c20", 1] },
  { id: "k03", category: "keyword", lang: "no", text: "Lånekassen stipend", relevant: { c21: 2 }, target: ["c21", 1] },
  { id: "k04", category: "keyword", lang: "en", text: "groupby", relevant: { c11: 2 }, target: ["c11", [2, 4]] },
  { id: "k05", category: "keyword", lang: "ru", text: "Anki", relevant: { c03: 2 }, target: ["c03", 2] },
  { id: "k06", category: "keyword", lang: "en", text: "ball python", relevant: { d01: 2 }, target: ["d01", 1] },
];
