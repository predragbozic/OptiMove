# Pages — S4a ugovor i validacija

Osnova: vizuelni Draft #363, HEAD `2ffd642f0abb16bbc2320c4d4db11b6b30b3579f`; normativni S1.1 `26162ae8f266eb24c88c601c8d4e8b9f1ca59be7`, posebno §7.2 i §8.2. Vlasnik je prihvatio svetli vizuelni pravac i zatim tražio dodavanje stranica. Pages zato dolaze pre S3c/S3d; te dve faze ostaju zasebne i nisu ukinute.

Ovaj kandidat uvodi izolovan ugovor zahteva i njegove testove. Ne registruje HTTP rute, ne uvodi SQL, ne menja `pages:false` capabilities i ne prikazuje nefunkcionalno dugme „+ Stranica”. S4b je čuvanje/kompatibilnost; S5 je stvarni interfejs. Nema merge-a ili deploy-a.

## Ponašanje za trenera

1. Ispod naziva dashboarda nalaze se kartice stranica i „+ Stranica”. Klik otvara mali formular za naziv. Nova stranica je prazna; widgeti se dodaju kroz postojeći Simple editor.
2. Promena stranice učitava samo njene widgete i rezultate. „Podesi”, preview i save uvek nose njen stvarni ID. Stranica koja nema widgete dobija poziv „Dodaj prvu metriku”.
3. Svaka stranica ima svoj raspored i sačuvane početne filtere/period. Lični runtime filter/zoom jedne stranice ne menja drugu. Posebna potvrda „Sačuvaj kao početne filtere stranice” jedina menja shared defaults.
4. Preimenovanje, pomeranje, dupliranje i brisanje nalaze se u meniju stranice. Dupliranje pravi nove widget/series ID-ove i remap-uje podržane presentation reference. Nema deljenih promenljivih konfiguracija.
5. Poslednja stranica ne može se obrisati. Brisanje neprazne stranice traži potvrdu sa brojem widgeta i eksplicitno `deleteWidgets:true`. Ovaj ugovor nije odobrenje izvršavanja takvog brisanja na produkciji.
6. Otvoren nacrt, nepoznat ishod save-a ili neprihvaćena promena rasporeda sprečavaju tiho prebacivanje. Ostaju postojeće potvrde odbacivanja i isti identitet retry zahteva.

Svetla pozadina i aplikacione surface/text promenljive ostaju. Nema zasebnog Dashboard sistema tema. Četiri buduća primera iz S1.1 (Dnevni izveštaj, Nedeljni izveštaj, Igrači, Utakmice) nisu automatski sadržaj svake nove stranice; ne dodavati lažne metrike ili rezultate kada podaci nisu dostupni.

## Model za naredni korak

`Dashboard → Page → Widget → Series`. Page pripada tačno jednom dashboardu; widget istovremeno nosi postojeći dashboard ID i stvarni page ID. Kompozitni FK mora sprečiti da page i widget pripadaju različitim dashboardima.

Predložena Page projekcija: `id`, `dashboardId`, `name`, `position`, `revision`, `defaultsRevision`, `layoutRevision`, `defaultFilter`, `periodConfig`, `periodOrigin`. Odgovor kolekcije dodatno nosi `pagesRevision`. UUID generiše server u transakciji. Validacija oblika nije dokaz autorizacije ili postojanja reda.

- `pagesRevision`: promena članstva/redosleda; zaseban dashboard brojač.
- `revision`: sadržaj stranice; raste pri preimenovanju, promeni defaults-a, članstva ili sadržaja widgeta/serija. Brisanje i dupliranje tako prepoznaju da je sadržaj promenjen posle prikazane potvrde. Layout ima zaseban brojač. Običan Simple save ne zavisi od jednakosti ove agregatne revizije.
- `defaultsRevision`: samo shared filter/period sadržaj. Layout/rename je ne podižu i ne poništavaju nepovezani widget preview.
- `layoutRevision`: raspored widgeta samo te stranice; ne postaje opšti uslov Simple widget save-a.
- Početni inženjerski limit: **32 stranice po dashboardu**, naziv 1–200 znakova, zahtev do 64 KiB. DB i servis moraju primeniti isti limit pod dashboard lock-om, uključujući paralelna kreiranja i clone. To je zaštitni izbor ovog predloga, ne limit preuzet iz HTML demonstracije.

Nazivi su običan tekst. Validator proverava trimmed nepraznost i zabranjuje kontrolne znakove, ali ne menja ulaz. Servis mora jednom kanonizovati naziv i case UUID-ova pre hash-a/idempotency zapisa; UI i dalje mora escape-ovati naziv. Nema čitanja owner/workspace polja iz tela zahteva.

### Nasleđivanje i period

Redosled je dashboard defaults → Page defaults → lični Page runtime → widget override. Ne menjati postojeću inherit/clear semantiku: odsutno polje nije isto što i eksplicitni `null`/prazna selekcija. Athlete workspace ostaje sužen na ovlašćenog sportistu na serveru.

Nove stranice zahtevaju eksplicitni `periodConfig` po postojećem ugovoru: fixed ili relative, IANA zona, najviše 400 uključivih dana. `this_week` je ponedeljak–nedelja, nije isto što i `last_7_days`. Server razrešava relativni period i vraća konkretne datume/evaluatedAt. UI ne koristi svoj sat kao shared izvor istine.

Postojeći dashboard nema sačuvanu period definiciju. Zato backfill ne sme iz trenutnog pregleda, datuma migracije ili zone DB servera izmisliti shared period. Predlog za početnu stranicu: `periodOrigin:legacyRuntime`, `periodConfig:null`; query/preview zahteva konkretan, validiran runtime period kao danas. Defaults zahtev samo sa `defaultFilter` menja isključivo filtere i zadržava postojeći periodOrigin/periodConfig, uključujući legacyRuntime/null. Prelaz na `periodOrigin:configured` nastupa tek eksplicitnim slanjem validnog fixed/relative `periodConfig`, bez uzimanja tekućeg runtime perioda kao zamene. `null` je dozvoljen samo kao ovaj read/migration status; validator novih create/defaults zahteva ga ne prihvata.

## Predložene HTTP putanje (nisu aktivirane)

Sve su pod `/api/training-load/dashboards/:dashboardId`. Server razrešava aktivni data workspace jednom za zahtev i proverava dashboard pravo, Page parent članstvo i widget članstvo u istom snapshot-u.

| Putanja | Zahtev i guard |
| --- | --- |
| GET `/pages` | autorizovana lista, stabilan redosled i pagesRevision; bez upisa pri čitanju |
| POST `/pages` | create: name, periodConfig, defaultFilter, expectedPagesRevision |
| GET `/pages/:pageId` | Page, defaults/layout revizije i samo njeni widgeti; ne svi dashboard widgeti |
| PATCH `/pages/:pageId` | rename: name, expectedPageRevision |
| PATCH `/pages/:pageId/defaults` | defaults: expectedPageDefaultsRevision i najmanje jedno od periodConfig/defaultFilter |
| PUT `/pages/order` | reorder: pageIds i expectedPagesRevision; kompletna permutacija svih pripadajućih stranica |
| POST `/pages/:pageId/duplicate` | duplicate: name, expectedPageRevision, expectedPagesRevision |
| DELETE `/pages/:pageId` | delete: expectedPageRevision, expectedPagesRevision, deleteWidgets |
| POST `/pages/:pageId/query` | postojeći query engine sa članstvom/periodom samo ove Page |

Svaki navedeni write ima `contractVersion:1` i UUID `requestId`. Route parametri se validiraju odvojeno; telo ne prihvata dashboard/page/owner/workspace ID-eve. Unknown keys, nebezbedni brojači, ne-JSON vrednosti, duplikati ID-eva i nevažeći periodi odbijaju se pre rada servisa. `validatePageRequest` ne tvrdi da su ID-evi ovlašćeni ili da reorder sadrži sve članove.

S4b mora definisati sanctioned Page operacije i idempotency zapis u istoj transakciji. Isti request ID i kanonizovan sadržaj daju isti receipt; druga operacija/sadržaj daju konflikt. Posle nepoznatog COMMIT-a ne praviti novi request ID. Prvo izdanje ne predviđa brisanje trajnog replay dokaza; eventualni retention zahteva zaseban protokol koji sprečava ponovno izvršavanje starog zahteva. Postojeći Simple ledger/preview token nije prećutno Page ledger. Status read/replay proverava trenutni pristup dashboardu i originalni cilj; brisanje cilja nije dozvola za novo izvršenje.

Očekivani servisni odgovori: `notFound` za neovlašćeno/nepostojeće parent/child članstvo, `invalidRequest`, `stalePageRevision`, `stalePagesRevision`, `stalePageDefaultsRevision`, `lastPageRequired`, `pageNotEmpty`, `pageLimitReached`, `idempotencyConflict`, `outcomeUnknown`, `pagesClientRequired`. Uslov se proverava pod odgovarajućim lock-om; ne otkrivati nazive ili ID-eve tuđih stranica kroz specifičniju grešku.

## S4b — obavezna kompatibilnost pre drugog Page reda

Backfill pridružuje postojeće widgete početnoj stranici uz iste widget/series ID-eve, vrednosti, konfiguracije, filtere i koordinate. Ne menja Metrics Core ili merne podatke. Migracioni slot još nije rezervisan; proveriti tada aktuelni main i paralelne migracije pre pisanja SQL-a. Izvršenje na produkciji nije autorizovano.

Pre prvog multi-page upisa moraju biti obuhvaćeni:

- flat detail/query i novi legacy Simple preview/save: samo single-page adapter može bez pageId. Na multi-page kontekstu odbiti sa pagesClientRequired pre čitanja celog sadržaja ili promene. Završen identičan legacy zahtev sme vratiti samo originalni autorizovani receipt/status, radi oporavka unknown save-a, bez novog upisa ili čitanja celog sadržaja;
- layout replace, pojedinačni layout/content/widget create/delete i svi series writer-i: Page članstvo i scope pod dashboard → Page → widget → series lock redosledom;
- UNIQUE order/mobile pravila i overlap trigger-i: Page scope, uz nepromenjene widget bounds;
- dashboard/template clone i Page duplicate: sve stranice i konfiguracije se kopiraju, podržane reference remap-uju, unknown sidecar čuva bez evaluacije; unresolved nije potvrđeno validan metric binding;
- dashboard archive/delete, active selection i selection cleanup: očuvanje parent prava; prvi korak ne uvodi novi per-user selection DB upis samo zbog otvaranja kartice;
- Simple tagged `context.kind:page` koristi postojeći pageId port, ne virtualni UUID. Token/fingerprint uključuje stvarnu stranicu i efektivne defaults; običan save ne zahteva jednakost layoutRevision;
- guard-i i sanctioned DB funkcije stižu zajedno sa šemom i API-jem. Sama nova tabela ili route nije kompletna Pages implementacija.

`pages` capability ostaje false dok sve write/read/query/clone putanje ne budu povezane. S4a ne menja postojeća false ponašanja i postojeći legacy adapter ostaje aktivan.

## Prihvatanje i redosled

S4a: ugovor/validator → jedna nezavisna ciljana revizija. S4b: DB/service/API, guard-i i izolovani PostgreSQL/HTTP dokazi. S5: „+ Stranica”, tabs, CRUD/order/duplicate, lazy render/query i Simple/Advanced kontekst, desktop/mobile QA. Posle toga dolaze preostale S3c/S3d mogućnosti i S6 integracija; nema automatskog merge-a/deploy-a.

Obavezni naredni dokazi: početni backfill bez mutacije bindinga/config-a; filter-only defaults ne izmišlja period i zadržava legacyRuntime/null; tek eksplicitni periodConfig prelazi na configured; cross-dashboard/workspace napadi bez čitanja/upisa; dva paralelna create/reorder/delete zahteva; poslednja stranica; rollback i unknown COMMIT/replay; isti layout na različitim stranicama bez konflikta; Page/default/layout revizije nezavisne; legacy zahtev na multi-page; clone/remap; switching sa starim odgovorima i nacrtom; runtime period ne prelazi na drugu stranicu; missing/conflict ne postaju nula. Ne ponavljati pune suites bez promene rizika.
