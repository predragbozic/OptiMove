# Stranice — Advanced editor i kopiranje dashboarda

Osnova je Draft #371, HEAD `fce078d20ef7d411c606cbe39231bbd755a762b3`. Ovaj korak povezuje backend operacije; još ne prikazuje tabove ili „+ Stranica”. `pages:false` i `pageWidgetEditing:false` ostaju do interfejsa i završne integracije. Nema zasebnog menjanja teme.

## Advanced API

Rute su pod `/api/training-load/dashboards/:dashboardId/pages/:pageId/advanced`:

| Metod i putanja | Operacija |
| --- | --- |
| PUT `/layout` | Batch raspored samo ciljnih Page widgeta |
| POST `/widgets` | Novi widget na konkretnoj stranici |
| PATCH `/widgets/:widgetId/layout` | Položaj/veličina/mobile redosled |
| PATCH `/widgets/:widgetId` | Sadržaj/prikaz/filter/presentation |
| DELETE `/widgets/:widgetId` | Brisanje widgeta |
| POST `/widgets/:widgetId/series` | Nova serija |
| PATCH/DELETE `/widgets/:widgetId/series/:seriesId` | Izmena/brisanje serije |
| PUT `/widgets/:widgetId/series/reorder` | Kompletan redosled serija tog widgeta |
| POST `/widgets/:widgetId/series/:seriesId/resolve` | Popravka nerazrešenog bindinga |
| GET `/requests/:requestId` | Provera poznatog ishoda |

Svaki write nosi `contractVersion:1`, UUID `requestId` i specifične podatke kao postojeći Advanced API. Create koristi `expectedPageRevision`, a batch layout `expectedPageLayoutRevision`; ostale akcije koriste `expectedWidgetRevision`. Globalna dashboard revizija se ne pretvara u uslov za nepovezanu stranicu. Stabilni konflikt rasporeda je `stalePageLayoutRevision`. Zahtev je najviše 64 KiB, layout najviše 200 widgeta, reorder najviše 200 serija. Numeričke koordinate i enum vrednosti ne koerciraju se iz stringova; unknown polja i nebezbedan JSON odbijaju se.

Widget/serija/layout članstvo proverava se u transakciji pod parent lock-om. Aktuelni korisnik/session, role, workspace i pravo upravljanja proveravaju se sveže; aktivni club/team redovi zaključavaju se i proveravaju pre nastavka. Katalog i filter reference proveravaju se bez otkrivanja tuđih podataka. Table pravila ostaju van ove faze. Budući/opaque presentation sadržaj može se sačuvati kroz postojeće preserve pravilo, uz postojeće granice semantičke izmene.

V59 uvodi `dashboard_page_advanced_requests` i zasebni `mutate_dashboard_page_advanced`. Dvanaest Page varijanti postojećih SQL writer-a nastaje strogo proverenim kopiranjem tela/potpisa/sidara; neočekivana baza prekida migraciju. Legacy writer-i ostaju zatvoreni na multi-page dashboardu, čak i uz interni marker. Marker je scope trigger-a, nije DB privilegijska granica; funkcije su SECURITY INVOKER kao dosadašnji ugovor.

Redosled je request advisory → actor/prava/workspace → dashboard → Page → widget/serije. Receipt i sve promene čuvaju se atomski. Ledger je append-only, bez FK ili purge-a. Identičan autorizovan replay prethodi arhivi i zastarelim revizijama; radi i posle brisanja izvorne Page/widgeta/serije, dok živi parent dashboard ostaje dostupan. Ne rekonstruiše se obrisani cilj. Drugi sadržaj/operacija/cilj sa istim actor/request ID-em je konflikt. Posle nepoznatog COMMIT-a status/retry koristi isti request ID i telo, bez ponovnog upisa.

## Kopiranje svih stranica

Postojeći `POST /dashboards/:dashboardId/clone` kopira sve stranice, uključujući prazne. Čuva naziv/redosled, shared filter/period i `legacyRuntime` sa stvarnim SQL NULL periodom. Widgeti i serije dobijaju nezavisne ID-eve; položaj i mobile order ostaju lokalni za svaku stranicu. Podržane presentation reference remap-uju se pomoću postojećeg Page remap helper-a; nepoznati sidecar čuva se bez evaluacije.

Template clone zadržava `cloned_from_dashboard_id` FK i postojeću snapshot semantiku. U migriranom Pages modelu dozvoljena je i kopija običnog dashboarda kojim korisnik upravlja. Ta kopija ima `cloned_from_dashboard_id:null`, jer postojeći FK označava isključivo template poreklo; odgovor ima informativni `copiedFromDashboardId`. On nije trajni provenance zapis. Izvor se ne pretvara u template. Pre Pages šeme ostaje prethodni template-only ugovor.

Clone prvo zaključava actor/role/preference redove, zatim relevantne Teams pa Clubs u stabilnom ID redosledu, ponavlja autorizaciju i tek potom zaključava izvorni dashboard FOR SHARE. Time se zamrzava njegov sadržaj i organizacioni kontekst. Izmena workspace-a od prvog HTTP snapshot-a kontrolisano prekida zahtev; ne menja mu cilj. Izvorni sadržaj ne zaključava se tek posle čitanja.

Bindings template-a ponovo se razrešavaju u ciljnom workspace-u. Kod modernih Page kopija server dopunjava hintove i za stare metric-backed serije bez hintova kada je potrebno ponovno razrešavanje. Nedostupna metrika ostaje `unresolved`/`ambiguous` uz očuvan prikaz, radi naknadne popravke; nije potvrđeno validan binding i ne pretvara se u nulu. Postojeća aktivna i vidljiva obična veza kopira se bez promene. Pinned source connection se ne zamenjuje drugom politikom: ako nije aktivna i vidljiva, cela kopija se poništava.

Definition lock se uzima bez version JOIN-a, a trenutna verzija čita se novim SQL statement-om posle čekanja. To važi i za fallback metadata i za batch hint rezoluciju; izbegava se lažno `unresolved` pri promeni `current_version_id`. Bez lock opcije stari batch resolver zadržava dve set-based provere; clone dodaje set-based definition lock pre njih.

Kompozitni clone ostaje dokumentovani izuzetak od pojedinačnih sanctioned writer-a. Nova transakcijska granica posmatra `error/end` konekcije, ograničava checkout, upit i ukupno vreme, vraća rollback ili uništava neizvesnu konekciju. Posle izgubljene COMMIT potvrde proverava tačan server-generisani destination ID i trenutni pristup, bez drugog kopiranja. Clone nema novi trajni request ledger: pri `outcomeUnknown` ne raditi automatski ponovni clone; prvo osvežiti listu dashboarda. To nije isto što i Advanced ledger protokol. Limiti su 32 stranice, 200 widgeta po stranici i 6400 ukupno; reprezentativan kapacitet ostaje release uslov.

## Dokazi i nastavak

Ciljane unit/contract/router/lifecycle provere i stvarni izolovani PostgreSQL/HTTP scenariji dokumentuju se u Draft PR-u. Privatni restore/HTTP wrapper-i koriste strukturu i migration metadata iz backup-a i isključivo sintetičke poslovne redove; ne objavljuju se. Prenosivi SQL harness jeste deo PR-a. Jedan zaseban nezavisni revizor pregledao je Page granice, replay, kopiranje i concurrency rizike; nije sam izvršavao DB suite.

Slede tabovi i „+ Stranica”, Page-aware Simple/Advanced frontend, lazy query/render, bezbedno prebacivanje sa nacrtom/unknown save-om i desktop/mobile vizuelna provera. Zatim kompozicija celog stack-a sa aktuelnim main-om i operativni uslovi. Bez samostalnog deploy-a ove osnove, merge-a, produkcionih migracija/upisa ili trajnih env promena.

Završne provere: 198/198 ciljnih testova PASS; jedan stvarni PostgreSQL/HTTP integracioni test PASS sa 18 scenarija, uključujući pre-Pages template kompatibilnost, Advanced SQL/HTTP, sve stranice, konkurentnu promenu verzije/arhivu tima, izgubljenu clone COMMIT potvrdu, unresolved popravku i foreign pinned rollback. DDL main73193fe273b7c9bc79fbd5898de85571dab9c0c8 kroz v56 + stackv57/v58 + v59. To nije merge aktuelnog aplikacionog main-a. Finalni databasesDropped/serverStopped/portClosed/clusterRemoved svi true.
