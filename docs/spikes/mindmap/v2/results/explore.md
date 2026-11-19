# Post-hoc exploration (after the frozen run; not used for the decision)

## 1. Ignoring placeholder titles in all+title [det] (topic-level B³ F)

| t | all [det] | all+title [det] | all+title [det], placeholders ignored |
|---|---|---|---|
| 0.7 | 0.53 | 0.47 | 0.47 |
| 0.75 | 0.54 | 0.49 | 0.49 |
| 0.8 | 0.52 | 0.50 | 0.50 |
| 0.85 | 0.45 | 0.49 | 0.49 |

## 2. Theme level, all [det]: candidate coarse settings

| setting | groups | largest | unsorted | theme B³ F |
|---|---|---|---|---|
| hierarchical t=0.8 | 63 | 8% | 2% | 0.52 |
| hierarchical t=0.85 | 38 | 16% | 1% | 0.61 |
| hierarchical t=0.9 | 24 | 16% | 0% | 0.59 |
| hierarchical t=0.95 | 12 | 21% | 0% | 0.51 |
| Louvain k=10 γ=2 | 14 | 14% | 0% | 0.54 |
| Louvain k=15 γ=2 | 13 | 14% | 0% | 0.55 |
| Louvain k=15 γ=3 | 19 | 10% | 0% | 0.56 |

## 3. Two levels with all [det]: themes (t=0.9) → topics (t=0.75)

### Theme (74; en/no/ru) — main theme label `code` 71/74
- (28) Merge two CSV files on customer id [en; py-data] · Plot monthly sales with a rolling average [en; py-data] · Fix SettingWithCopyWarning [no; py-data] · Groupby with several aggregations [en; py-data, budgeting] · Разбор дат в разных форматах [ru; py-data] · Numpy broadcasting error [en; py-data] · Rens telefonnumre i et regneark med Python [no; py-data] · New chat [en; py-data] · Seaborn heatmap of correlations [en; py-data] · Pivot table to wide format [en; py-data] · Как ускорить apply по строкам [ru; py-data] · Read Excel file with several sheets [en; py-data] · Dedupe rows but keep the newest [en; py-data] · Hvordan logge riktig i en Node-tjeneste [no; web-backend] · Window function: running total per customer [en; sql] · Slow query with LIKE '%term%' [en; sql] · Finn kunder som ikke har handlet i år [no; sql] · Database design for tags [en; sql] · EXPLAIN shows a sequential scan [en; sql] · Удалить дубликаты из таблицы [ru; sql] · Pivot rows into columns in SQL [en; sql] · Automatisk sende rapport på e-post [no; automation] · Bash: loop over files with spaces in the name [en; automation] · Скрипт для выгрузки курсов валют [ru; automation] · Automate filling a web form [en; automation] · New chat [en; py-data, automation] · Debugging a slow Django page [en; web-backend, sql] · Grocery spending app for my household [en; py-data, budgeting]
- (13) Express API returns 404 for every route [en; web-backend] · CORS error from my React app [en; web-backend, frontend] · Rate limiting a public endpoint [en; web-backend] · Webhook from Stripe fails signature check [en; web-backend] · useEffect runs twice [en; frontend] · Center a div, again [en; frontend] · Form state in React getting messy [en; frontend] · Mørk modus på nettsiden [no; frontend] · TypeScript: type for an object with dynamic keys [en; frontend] · Tailwind classes not applied [en; frontend] · Animate a list when items are removed [en; frontend] · Хук для загрузки данных с повтором [ru; frontend, web-backend] · Nginx som reverse proxy for to apper [no; git-devops]
- (13) Dockerize a Django app [en; web-backend, git-devops] · Ошибка 500 после деплоя на сервер [ru; web-backend] · Undo the last commit but keep my changes [en; git-devops] · Merge conflict in package-lock.json [en; git-devops] · GitHub Actions: cache node_modules [en; git-devops] · Docker container exits immediately [en; git-devops] · Как настроить автодеплой на VPS [ru; git-devops, web-backend] · Rewrite history to remove a leaked secret [en; git-devops] · Pre-commit hooks for formatting [en; git-devops] · Ускорить сборку Docker-образа [ru; git-devops] · Cron job that doesn't run [en; automation] · Keyboard macro to paste a signature [en; automation] · Переход с Windows на Mac для работы [ru; devices]
- (5) Jupyter kernel keeps dying [en; py-data] · Хранить файлы в базе или на диске [ru; web-backend] · Liste i React blir treg med 5000 rader [no; frontend] · SQLite or Postgres for a side project [en; sql] · Deploying a small app cheaply [en; git-devops, web-backend]
- (4) Сайт медленно грузится на телефоне [ru; frontend] · Script to rename hundreds of photos by date [en; automation] · Organisere digitale bilder [no; organising, devices] · Building a portfolio site as a photographer [en; frontend, crafts]
- (3) JWT token expires too fast [en; web-backend] · Commit-melding på engelsk [no; git-devops] · Deadlock between two transactions [en; sql, web-backend]
- (3) Postgres connection pool exhausted [en; web-backend, sql] · Background jobs in a web app [en; web-backend] · Websocket disconnects every 60 seconds [en; web-backend]
- (2) REST API: PUT eller PATCH? [no; web-backend] · GraphQL vs REST for a small app [en; web-backend]
- (2) Accessible modal dialog [en; frontend] · Kubernetes pod in CrashLoopBackOff [en; git-devops]
- (alone) Explain blockchain without hype [en; oneoff:blockchain]

### Theme (61; en/no/ru) — main theme label `food` 29/61
- (23) Sourdough starter smells like nail polish [en; bread] · Dense whole wheat bread [no; bread] · Focaccia overnight in the fridge [en; bread] · Почему корка у хлеба мягкая [ru; bread] · Rugbrød med surdeig [no; bread] · New chat [en; bread] · Pizza dough in a home oven [en; bread, dinners] · Quick dinner with chickpeas and spinach [en; dinners] · Middag til fem barn på en hverdag [no; dinners, parenting] · Chicken plov recipe [ru; dinners] · Meal prep for the work week [en; dinners, nutrition] · One-pan salmon and potatoes [en; dinners] · Fiskesuppe som bergensere liker [no; dinners] · Vegetarian dinner guests [en; dinners] · Ужин за 15 минут после работы [ru; dinners] · Cheesecake cracked on top [en; desserts, desserts] · Kanelboller som blir tørre [no; desserts] · Chocolate mousse without raw eggs [en; desserts] · Медовик в домашних условиях [ru; desserts] · Lemon tart filling too runny [en; desserts] · Weekly dinner plan for a family of four [en; dinners, budgeting] · Can I freeze cooked rice [en; dinners] · (no title) [en; oneoff:convert]
- (15) Tomatoes on the balcony split [en; vegetables] · Potato late blight [no; vegetables] · Огурцы горчат [ru; vegetables] · When to plant garlic [en; vegetables] · Grønnsakshage for nybegynnere [no; vegetables] · Squash plants with white powder [en; vegetables, houseplants] · Monstera leaves turning yellow [en; houseplants] · Orkideen blomstrer ikke igjen [no; houseplants] · Мошки в цветочных горшках [ru; houseplants] · Plants for a dark bathroom [en; houseplants] · Repot a cactus without getting stabbed [en; houseplants] · Stueplanter når vi er på ferie [no; houseplants] · Fiddle leaf fig dropping leaves [en; houseplants] · Lawn full of moss [en; vegetables] · Kitchen garden on a north-facing balcony [en; vegetables, houseplants]
- (8) Сколько белка нужно для роста мышц [ru; strength, nutrition] · Creatine — worth it? [en; strength, nutrition] · Healthy breakfast that keeps me full [en; nutrition] · Spise mindre sukker [no; nutrition] · Питание при повышенном холестерине [ru; nutrition] · Vegan and iron levels [en; nutrition] · Calorie counting for weight loss [en; nutrition] · Snacks for a long hike [en; nutrition, hiking]
- (3) Pour-over coffee tastes sour [en; coffee-tea] · Espresso machine for beginners [en; coffee-tea] · Cold brew ratio [en; coffee-tea]
- (3) Mushroom identification [en; oneoff:mushroom] · Hvor gammel kan en hummer bli [no; oneoff:lobster] · Life on Mars? [en; oneoff:mars-life]
- (2) Baguettes keep spreading flat [en; bread] · Sleeping bag for cold nights [en; hiking]
- (2) Hvor mye vann bør jeg drikke [no; nutrition] · Солнце и горы: как не сгореть [ru; hiking]
- (2) Wine with lamb [en; dinners] · Make a cocktail with gin and grapefruit [en; oneoff:cocktail]
- (alone) Is brown sugar the same as white plus molasses [en; desserts]
- (alone) Kaffe i presskanne blir grumsete [no; coffee-tea]
- (alone) Как выбрать арбуз [ru; oneoff:watermelon]

### Theme (44; en/no/ru) — main theme label `career` 25/44
- (19) Søknad på sommerjobb [no; applications] · Junior QA resume tips [ru; applications] · LinkedIn headline [en; applications] · Tailoring a CV to each job [en; applications] · "Tell me about yourself" answer [en; interviews] · Jobbintervju på engelsk [no; interviews, languages] · Как отвечать про слабые стороны [ru; interviews] · Salary question in the interview [en; interviews, workplace] · Questions to ask the interviewer [en; interviews] · Difficult conversation with a colleague [en; workplace] · Første gang som leder [no; workplace] · Как попросить повышение зарплаты [ru; workplace] · Too many meetings [en; workplace] · Giving negative feedback to a team member [en; workplace] · Quitting a job gracefully [en; workplace] · Choosing a thesis topic [en; thesis] · Как подготовиться к собеседованию в норвежскую компанию [ru; interviews, languages] · Teamet mitt er overarbeidet [no; workplace, stress] · Kontorlandskap og konsentrasjon [no; workplace]
- (5) Cover letter for a career change [en; applications] · Writing a portfolio case study [en; applications] · Thesis outline in marine biology [en; thesis] · Как написать литературный обзор [ru; thesis] · Помогите с эссе на английском для поступления [ru; applications, languages]
- (5) Exam stress and procrastination [en; exams, stress] · Hvordan lese til eksamen i statsvitenskap [no; exams] · Memorising anatomy [en; exams] · Note-taking: by hand or laptop [en; exams] · Masteroppgave: skrivesperre [no; thesis, stress]
- (4) Negotiating a 4-day week [en; workplace] · NAV unemployment benefits [no; bureaucracy] · Сменить профессию в 40 лет [ru; applications, stress] · Stress før eksamen og jobbsøking samtidig [no; stress, exams]
- (3) Learning Norwegian as an adult [en; languages] · Barnet vil ikke snakke morsmålet [no; languages, parenting] · Shadowing technique [en; languages]
- (3) Math exam preparation [ru; exams] · Eksamen i matte R1 [no; exams] · Пересдача экзамена в университете [ru; exams]
- (2) Missing values: fill or drop? [en; py-data] · Thesis data analysis in R or Python [en; thesis, py-data]
- (2) Technical interview prep plan [en; interviews, py-data] · Spansk før ferien [no; languages, city-trips]
- (alone) Hjemmekontor og ensomhet [no; workplace, stress]

### Theme (39; en/no/ru) — main theme label `money` 27/39
- (17) Budget that actually sticks [en; budgeting] · Student monthly budget [no; budgeting] · Как вести семейный бюджет вдвоём [ru; budgeting] · Emergency fund size [en; budgeting, investing] · Spreadsheet for tracking shared flat costs [en; budgeting, py-data] · Index funds for a beginner [en; investing] · Aksjesparekonto eller fondskonto [no; investing] · Инвестиции: вклад или облигации [ru; investing] · Should I pay off my student loan or invest [en; investing, budgeting] · Crypto: worth putting money in? [en; investing] · Dollar-cost averaging vs lump sum [en; investing] · Fondssparing for barna [no; investing, parenting] · Lommepenger: hvor mye? [no; parenting, budgeting] · Hvordan komme i gang med indeksfond [no; investing, budgeting] · Explain inflation like I'm 12 [en; oneoff:inflation] · Monthly budget for a couple saving for a house [en; budgeting, investing] · Flytte hjem til foreldrene for å spare [no; budgeting, moving]
- (9) Hvordan følge opp en søknad [no; applications] · Письмо на норвежском в коммуну [ru; languages, bureaucracy] · Виза в Японию для граждан России [ru; logistics] · Переезд в другую страну с котом [ru; moving, cats] · Как получить норвежский D-номер [ru; bureaucracy] · Renewing a passport for a child [en; bureaucracy, parenting] · Taxes after moving countries mid-year [en; taxes, moving] · Moving abroad for a job [en; moving, applications] · Applying for a residence permit for my partner [en; bureaucracy]
- (6) Tax deduction for home office [en; taxes] · Skattemeldingen og utleie av hybel [no; taxes, renting] · Налоговый вычет за лечение [ru; taxes] · Freelancer: setting money aside for taxes [en; taxes, budgeting] · Selling shares and capital gains [en; taxes, investing] · Fradrag for reisevei [no; taxes]
- (2) Paperwork system at home [en; organising, budgeting] · Receipts for VAT as a small business [en; taxes]
- (2) Subscriptions eating my money [en; budgeting] · Слишком много подписок и денег не хватает [ru; budgeting]
- (2) Cheap eats in Tokyo [en; city-trips] · Tipping in the US [en; oneoff:tipping]
- (alone) Change of address checklist [en; moving, bureaucracy]

### Theme (28; en/no/ru) — main theme label `fitness` 24/28
- (14) First 10K training plan [en; running] · Как не задыхаться при беге [ru; running] · Should I run with a heart rate monitor [en; running, devices] · Shin splints after starting to run [en; running] · Halvmaraton i Oslo [no; running] · Beginner strength routine [en; strength] · Styrketrening hjemme uten utstyr [no; strength] · Deadlift lower back pain [en; strength] · Pull-up progression [en; strength] · Treningsprogram for 50-åringer [no; strength] · Sore for days after leg day [en; strength] · Planlegge maratonløp etter fødsel [no; running, parenting] · Søvn og trening om kvelden [no; sleep, strength] · Løpe raskere på 5 km [no; running]
- (7) Løpe om vinteren på glatte veier [no; running] · Trail running shoes or road shoes [en; running, hiking] · Commuting by bike in the rain [en; cycling] · First gravel ride [en; cycling, hiking] · Hiking boots or trail runners [en; hiking, running] · Training for a trail race [en; running, hiking] · Как выбрать рюкзак для похода [ru; hiking]
- (3) Велосипед скрипит при педалировании [ru; cycling] · Bike fit: knee pain on longer rides [en; cycling] · Rebuilding a bike's rear wheel [en; cycling, repairs]
- (2) Первый поход с палаткой [ru; hiking] · Packing light for two weeks [en; logistics]
- (alone) Indoor trainer winter plan [en; cycling]
- (alone) Dog pulls on the leash [en; dogs]

### Theme (24; en/no/ru) — main theme label `creative` 10/24
- (5) Short story about a lighthouse [en; fiction] · Novelle om en gammel båt [no; fiction] · Best man speech opening [en; speeches] · Tale til pappas 70-årsdag [no; speeches] · Toast for a friend's 40th [en; speeches]
- (5) Name ideas for a fantasy kingdom [en; fiction] · Хорошая книга для отпуска [ru; oneoff:book-holiday] · Help me name a cat [en; cats] · Что посмотреть из старых фильмов [ru; oneoff:old-films] · Hvem skrev Peer Gynt [no; oneoff:peer-gynt]
- (4) Как преодолеть кризис в середине романа [ru; fiction] · Writing believable dialogue [en; fiction] · Unfinished fantasy novel [en; fiction, stress] · Мой сын не хочет читать [ru; parenting, exams]
- (3) Hvem var Harald Hårfagre [no; oneoff:harald] · What happened to the Library of Alexandria [en; oneoff:alexandria] · Romerrikets fall [no; oneoff:rome-fall]
- (2) Stoicism quick summary [en; oneoff:stoicism] · Trolley problem [en; oneoff:trolley]
- (2) Origin of the word "salary" [en; oneoff:etymology] · Hvorfor er sjøvann salt [no; oneoff:seawater]
- (alone) Fanfiction og opphavsrett [no; fiction]
- (alone) Riddle for a treasure hunt [en; oneoff:riddle]
- (alone) Почему люди боятся пауков [ru; oneoff:spiders]

### Theme (23; ru/no/en) — main theme label `home` 18/23
- (7) Bathroom renovation order of work [en; renovation] · Insulating an attic [en; renovation] · Adding a window to a wall [en; renovation] · Garage conversion to home office [en; renovation] · Door won't close properly [en; repairs] · Fryseren lager is på veggene [no; repairs] · Renovating an old bathroom floor [en; renovation, repairs]
- (6) Чай пуэр как заваривать [ru; coffee-tea] · Matcha klumper seg [no; coffee-tea] · Mould around the shower [en; repairs] · Fixing a wobbly chair [en; repairs, crafts] · Как начать работать с эпоксидной смолой [ru; crafts] · Как убрать пятно от красного вина [ru; organising]
- (4) Radiator stays cold at the top [en; repairs] · Strømregningen er altfor høy [no; budgeting, repairs] · Noisy laptop fan [ru; devices] · Термостат и отопление по расписанию [ru; smart-home, budgeting]
- (2) Male panel i stua [no; renovation] · Новый пол на кухне [ru; renovation]
- (2) Kitchen tap dripping [en; repairs] · Течёт бачок унитаза [ru; repairs]
- (2) Sikringen går hele tiden [no; repairs] · Robot vacuum worth it? [en; smart-home, organising]

### Theme (20; en/no/ru) — main theme label `travel` 15/20
- (13) Weekend in Copenhagen [en; city-trips] · Helg i Berlin med tenåringer [no; city-trips, parenting] · Что посмотреть в Стамбуле за 3 дня [ru; city-trips] · Rome with a toddler [en; city-trips, parenting] · Bytur til Edinburgh [no; city-trips] · Lisbon in winter [en; city-trips] · Bestige Galdhøpiggen [no; hiking] · Packing for a hut-to-hut hike in Jotunheimen [en; hiking, logistics] · Лучшее время посетить Байкал [ru; oneoff:baikal] · Weekend in Prague on a budget [en; city-trips, budgeting] · Helg i Stockholm med venninner [no; city-trips] · St Petersburg white nights trip [ru; city-trips] · Hike Trolltunga safely [en; hiking]
- (4) Melatonin dose [en; sleep] · Forsinket fly og kompensasjon [no; logistics] · Train from Oslo to Stockholm [en; logistics] · Как справиться с боязнью полётов [ru; oneoff:fear-flying]
- (2) Travel insurance — what to check [en; logistics] · Flyttebyrå eller gjøre det selv [no; moving]
- (alone) Birdwatching for beginners [en; oneoff:birds]

### Theme (19; ru/no/en) — main theme label `family` 12/19
- (8) Конфликт между двумя сотрудниками в команде [ru; workplace] · Toddler tantrums in the supermarket [en; parenting] · Подросток не хочет разговаривать [ru; parenting] · Sibling fights [en; parenting] · Takketale ved avskjed på jobb [no; speeches, workplace] · Как правильно ответить на свадебное приглашение [ru; oneoff:rsvp] · Перевести письмо на английский официально [ru; languages] · Как помириться с подругой [ru; oneoff:friend-fight]
- (5) Mamma med begynnende demens [no; elderly] · Elderly father refuses help at home [en; elderly] · Moving my mother to a care home [en; elderly] · Eulogy for my grandmother [en; speeches] · Мама не хочет переезжать к нам [ru; elderly, moving]
- (4) Potty training in a week [en; parenting] · Barnehagestart for ettåringen [no; parenting] · Moving checklist with kids [en; moving, parenting] · Переезд с детьми в новый город [ru; moving, parenting]
- (alone) Fjelltur med barn [no; hiking, parenting]
- (alone) Plan a surprise anniversary weekend [en; oneoff:anniversary]

### Theme (18; en/no/ru) — main theme label `creative` 10/18
- (7) Learning guitar as an adult [en; music] · Как научиться петь чисто [ru; music] · Music theory for songwriting [en; music] · Как научиться жонглировать [ru; oneoff:juggling] · Learning piano as an adult with little time [en; music] · Lære å synge i kor [no; music] · Гитара: как перестать бросать [ru; music]
- (3) Matteangst [no; exams] · Skjermtid for 10-åringen [no; parenting] · Pianoøving for barn [no; music, parenting]
- (3) Home recording setup [en; music, devices] · How do noise cancelling headphones work [en; oneoff:anc] · Home studio acoustic treatment [en; music, renovation]
- (2) Chess: what to do after 1.e4 e5 [en; oneoff:chess] · Шахматы или го для ребёнка [ru; oneoff:go]
- (alone) Anki deck for vocabulary [en; languages]
- (alone) Pottery wheel or hand building [en; crafts]
- (alone) Fastest way to learn to type [en; oneoff:typing]

### Theme (17; en/ru/no) — main theme label `tech` 15/17
- (7) Wifi slow upstairs [en; network] · Sette opp gjestenett hjemme [no; network] · Почему падает скорость интернета вечером [ru; network] · VPN at home: needed? [en; network] · Port forwarding for a game server [en; network] · Smart lights that work without the cloud [en; smart-home] · New chat [en; network, devices]
- (5) Digital detox weekend [en; stress] · Как помочь пожилым родителям с телефоном [ru; elderly, devices] · Telefonen blir varm og batteriet tømmes [no; devices] · iPhone storage full [en; devices] · Bytte fra Android til iPhone [no; devices]
- (3) Laptop for a design student [en; devices] · Old laptop: Linux? [en; devices] · Home Assistant on a Raspberry Pi [en; smart-home, automation]
- (alone) Smarthus for en eldre forelder [no; smart-home, elderly]
- (alone) Appealing a parking fine [en; bureaucracy]

### Theme (15; en/no/ru) — main theme label `health` 12/15
- (8) Waking at 3am every night [en; sleep, stress] · Anxiety before presentations [en; stress, workplace] · Følelsen av å aldri strekke til [no; stress] · Выгорание на работе [ru; stress, workplace] · Breathing exercise for panic [en; stress] · Meditasjon for nybegynnere [no; stress] · Overwhelmed and can't switch off [en; stress, sleep] · Exam anxiety in driving test [en; exams, stress]
- (3) Shifting a late sleep schedule [ru; sleep] · Kids bedtime takes two hours [en; sleep, parenting] · Indoor cat bored [en; cats]
- (2) Søvnrytme etter nattskift [no; sleep] · Snorking og dårlig søvn [no; sleep]
- (2) (no title) [en; oneoff:bee] · Dream about losing teeth [en; oneoff:dream]

### Theme (13; ru/en/no) — main theme label `admin` 9/13
- (6) Ремонт в съёмной квартире [ru; renovation, renting] · Deposit not returned [en; renting] · Сосед сверху затопил [ru; renting, repairs] · Subletting my room for the summer [en; renting] · Mould in a rental flat [en; renting, repairs] · Landlord entering without notice [en; renting]
- (2) Declutter a small apartment [en; organising] · Как приучить семью к порядку [ru; organising, parenting]
- (2) Leieavtale: kan utleier øke husleia? [no; renting] · Klage på manglende vedlikehold [no; renting, repairs]
- (2) Плохо сплю после переезда [ru; sleep, moving] · Стресс из-за ремонта соседей [ru; stress]
- (alone) Klage på nabohundens bjeffing [no; oneoff:neighbour-dog]

### Theme (13; no/ru/en) — main theme label `family` 13/13
- (13) Hunden bjeffer på andre hunder [no; dogs] · Puppy chewing furniture [ru; dogs] · Adopting a rescue dog [en; dogs] · Dog food: grain-free? [en; dogs, nutrition] · Valp og alenetid [no; dogs] · Cat scratching the sofa [en; cats] · Katten tisser utenfor kassen [no; cats] · Кошка не ест сухой корм [ru; cats] · Introducing a second cat [en; cats] · Hund og katt sammen [no; dogs, cats] · Kan katter drikke melk [no; cats] · Почему кошки мурлычут [ru; cats] · Why do cats knock things off tables [en; cats]

### Theme (9; en/ru/no) — main theme label `oneoff:sky` 1/9
- (4) Why is the sky blue [en; oneoff:sky] · Hvordan fungerer nordlys [no; oneoff:aurora] · Black hole in simple words [en; oneoff:black-hole] · Hva er forskjellen på vær og klima [no; oneoff:weather-climate]
- (2) Сколько спутников у Юпитера [ru; oneoff:jupiter] · Как работает GPS [ru; oneoff:gps]
- (2) Speed of a sneeze [en; oneoff:sneeze] · How much does a cloud weigh [en; oneoff:cloud-weight]
- (alone) Что такое квантовая запутанность [ru; oneoff:entanglement]

### Theme (7; no/en) — main theme label `creative` 2/7
- (3) Strikke lusekofte [no; crafts] · Origami crane instructions [en; oneoff:origami] · Lage strikkemønster selv [no; crafts]
- (2) Pakke kjøkkenet [no; moving] · Sudoku strategy [en; oneoff:sudoku]
- (alone) Datavisualisering for styremøtet [no; py-data]
- (alone) Hvordan lage et godt passord [no; devices]

### Theme (7; en/ru/no) — main theme label `learning` 3/7
- (2) French subjunctive [en; languages] · Translate a sentence into Japanese [en; languages]
- (2) Стихотворение на юбилей бабушке [ru; speeches] · Skrive dikt til 17. mai [no; oneoff:may17-poem]
- (2) (no title) [en; oneoff:prime] · Help with a crossword clue [en; oneoff:crossword]
- (alone) Ord for "hygge" på engelsk [no; languages]

### Theme (5; no/en/ru) — main theme label `home` 1/5
- (4) Gave til sjefen som slutter [no; oneoff:boss-gift] · Bursdagsleken til 6-åring [no; oneoff:party-games] · Gift for a 10 year old who has everything [en; oneoff:gift-kid] · Что подарить коллеге на 50 лет [ru; oneoff:colleague-gift]
- (alone) Organisere boden [no; organising, organising]

### Theme (4; en/no/ru) — main theme label `garden` 1/4
- (2) Raised bed soil mix [en; vegetables] · Calculate tile quantity [en; renovation]
- (2) Fakta om elg [no; oneoff:moose] · Сколько стоит содержание лошади [ru; oneoff:horse]

### Theme (3; no) — main theme label `fitness` 1/3
- (2) Sykkel med el-motor til jobb [no; cycling] · Bil som ikke starter i kulda [no; oneoff:car-cold]
- (alone) Pusse opp kjøkken på budsjett [no; renovation]

### Theme (3; en/no) — main theme label `creative` 2/3
- (2) Knitting a first sweater [en; crafts] · Sewing machine for beginners [en; crafts]
- (alone) Pakke for flytting til hybel [no; moving]

### Theme (2; en) — main theme label `code` 2/2
- (2) Component library or build our own? [en; frontend] · Branching strategy for a small team [en; git-devops]

### Theme (2; ru/no) — main theme label `learning` 1/2
- (alone) Как выучить английские времена [ru; languages]
- (alone) Hva betyr "ad hoc" [no; oneoff:adhoc]

### Theme (2; en) — main theme label `learning` 1/2
- (alone) Citation manager recommendation [en; thesis]
- (alone) Which e-reader [en; devices]

### Not in any theme (1): The Monty Hall problem [oneoff:monty-hall]

## 4. Extended grid for the label-free rule, all [det] (exploratory)

| t | groups | largest | unsorted | topic B³ F | stability |
|---|---|---|---|---|---|
| 0.55 | 61 | 2% | 66% | 0.38 | 0.944 |
| 0.6 | 96 | 2% | 43% | 0.42 | 0.899 |
| 0.65 | 99 | 3% | 28% | 0.49 | 0.893 |
| 0.7 | 98 | 5% | 16% | 0.53 | 0.871 |
| 0.75 | 83 | 6% | 7% | 0.54 | 0.847 |
| 0.8 | 63 | 8% | 2% | 0.52 | 0.846 |
| 0.85 | 38 | 16% | 1% | 0.45 | 0.790 |
