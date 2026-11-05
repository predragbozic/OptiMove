# S5 — stranice u Dashboards interfejsu

Osnova: Draft PR #374, commit `f45a4351984d5df0a2c71e5108e57352a41611a1`. S5 ne uvodi migraciju. Zavisi od Pages v57, Page Simple v58 i Page Advanced v59; svi prethodni PR-ovi ostaju zasebni i nisu spojeni ovim radom.

## Ponašanje

- Kartice prikazuju stranice iz autorizovanog Pages lista. `+ Stranica` otvara obrazac sa nazivom i početnim rasponom. Nova stranica dobija sopstveni prazan sadržaj.
- Meni aktivne stranice omogućava preimenovanje, dupliranje sadržaja, pomeranje levo/desno, eksplicitno čuvanje početnog raspona/filtera i potvrđeno brisanje. Poslednja stranica ne može da se obriše; limit je 32 stranice.
- Učitava se sadržaj samo aktivne stranice. Zakasneli odgovori prethodne stranice ili radnog prostora ne mogu da prepišu aktivni sadržaj.
- Lični period i filteri pamte se u memoriji odvojeno po stranici. Konfigurisane početne periode razrešava server. Promena perioda u Simple editoru postaje lični period i ne menja zajednička početna podešavanja.
- Simple, Advanced, raspored i upiti koriste Page rute. Nepotvrđeni upis zadržava isti request ID i telo zahteva; status ili ponavljanje služe za oporavak. Dok ishod nije poznat, novi i kompenzacioni upisi su blokirani. Potvrđeni Advanced receipt povezuje tačno kreiranu seriju sa originalnim nacrtom, uključujući rani reload pre COMMIT-a.
- Pre napuštanja nesačuvanog editora traži se potvrda. Tokom čuvanja prebacivanje je blokirano. Obrasci čuvaju revizije viđene pri otvaranju, tako da novije stanje ne pretvara staru potvrdu u odobrenje za nov sadržaj.
- Bela tema nasleđuje postojeće promenljive aplikacije. Na uskom ekranu kartice imaju sopstveni horizontalni skrol, a alati se slažu ispod njih. Arrow Left/Right, Home/End pomeraju fokus; Enter/Space biraju karticu.

## Spremnost i kompatibilnost

Lista dashboarda koristi `to_jsonb` za opcioni `pages_revision`, pa čitanje ostaje kompatibilno sa šemom bez tog polja. Pages lista vraća već autorizovan roditeljski header. `pages` spremnost zahteva obe Page Simple/Advanced funkcije u bazi; upravljanje dodatno zahteva prava za upravljanje i upite. Legacy Simple kontekst zadržava `pages: false`.

## Provere 5. novembra 2026.

- Frontend ciljano: **290/290 PASS** (Pages podaci/prikaz/tastatura, Simple, Analysis i grafikoni).
- Backend ciljano: **42/42 PASS**. Frontend production build: PASS, uz postojeće upozorenje o veličini bundle-a.
- Lokalna stvarna PostgreSQL/HTTP provera: **1/1 PASS**, migracije kroz postojeći main DDL v56 i Pages v57–v59. To je provera kompozicije DDL-a, ne integracija celog novijeg main aplikacionog koda. Korišćeni su struktura/metapodaci i sintetički podaci; nije korišćena produkciona konekcija.
- U stvarnom interfejsu na 1280×900 potvrđeni su create, rename, prebacivanje, duplicate sa vidžetima i reorder. Na 390×844 provereni su prikaz i obrazac: body width 375 px, tablist 355 px sa sopstvenim skrolom 778 px. Otvaranje Simple editora i upozorenje pri napuštanju potvrđeni su; ugrađeni pregledač je zastao na native confirm dijalogu, pa ručno odbijanje prelaska nije potvrđeno. Automatizovani testovi pokrivaju taj tok. Tastatura je proverena DOM testovima, bez završene ručne provere u pregledaču.
- Nezavisna ciljana revizija pronašla je dva P2: gubitak ličnog perioda posle Simple čuvanja i mogući dupli Advanced add posle nepoznatog ishoda. Oba su ispravljena i imaju regresione testove; Advanced ispravka je zasebno ponovo proverena sa sedam reprodukcija u memoriji. Simple ispravka potvrđena je ciljanim testom, bez drugog nezavisnog prolaza.

## Ograničenja šire provere i izlaska

Dorada preglednosti posle vizuelnog pregleda: uklonjeni su ponovljeni ulazi za Settings, Advanced i Edit layout iz menija vidžeta, kao i Edit layout iz menija dashboarda. Jedno „Podesi” na kartici otvara postojeći Simple editor ili kompatibilni osnovni editor; svaki zadržava ulaz u napredna podešavanja. Simple i Advanced nisu ista funkcija i njihovi handleri nisu brisani. „Uredi raspored” je sada vidljivo pored „Dodaj metriku” na aktivnoj stranici sa vidžetima. Režim rasporeda ima srpske nazive, uputstvo za prevlačenje/veličinu i posebno za redosled na telefonu. Ciljani postojeći testovi ažurirani za novi raspored kontrola: **245/245 PASS**, build PASS. U izdvojenom lokalnom pregledu stvarnog view/action koda potvrđeno je prevlačenje (y 0 → 3), mobilno pomeranje (redosled prve dve kartice zamenjen) i otkazivanje nacrta. Ovaj pregled nije koristio bazu i ne predstavlja novu proveru trajnog čuvanja rasporeda. Ranije navedene šire baseline greške ostaju otvorene.

Šira frontend provera na osnovnom #374: 2429 testova, 2415 PASS, 12 FAIL, 2 cancelled zbog timeout-a. S5 široki prolaz: 2496 testova, 2479 PASS, 15 FAIL, ista 2 timeout-a. Dvanaest padova poklapa se sa osnovom (Builder/static source guards, media, sign-out cache i kalendar sa datumima). Tri dodatna pada bila su usled starih DOM stubova koji vraćaju widget čak i za selektor tablista; stubovi su ispravljeni da poštuju selektor. Sva tri testa i ukupni ciljani skup 290/290 zatim prolaze. Ceo široki skup nije ponavljan posle korekcije stubova, niti se tvrdi da je zelen.

Pre produkcije ostaju pregled izgleda od strane korisnika, integracija celog Draft lanca sa izabranim main commitom, završna provera migracija i upisa na izolovanoj kopiji i posebno odobrenje za merge/deploy. S5 ne podrazumeva merge, deploy, produkcione migracije ili promenu produkcionih env vrednosti.
