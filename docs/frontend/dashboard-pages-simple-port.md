# Stranice — povezivanje Simple editora

Osnova je S4b Draft #370, HEAD `654707163192dd3d34089377d571706e65e060e3`. Ovo je naredni izolovani deo backend podrške. Interfejs još ne prikazuje „+ Stranica”; opšta aktivacija i `pages:false` ostaju do Advanced/clone/UI koraka.

## Ponašanje

Simple rute su dodatno dostupne pod `/api/training-load/dashboards/:dashboardId/pages/:pageId/simple`. Podržavaju capabilities, metrics, validate, preview, widgets create/update i requests/status kao postojeći Simple API. Odvojeni Page put zahteva odgovarajući tagged `context.kind:page` i identičan `context.pageId`; telo ne preusmerava cilj rute. Legacy put zadržava prethodni single-page guard i oblik tokena/receipt-a.

Autorizacija proverava svežeg korisnika/session, aktivni data workspace i pravo upravljanja dashboardom. Page parent i widget članstvo proveravaju se pre serija i rezultata. Preview čita jedan bounded RR READ ONLY snapshot. Save koristi postojeći ograničeni observed-client lifecycle, oporavak nepoznatog COMMIT ishoda i isti request identitet. V58 mora postojati pre prihvatanja Page editor zahteva; zastarela šema odbija rad sa `pagesUnavailable`.

Filteri slede dashboard → Page defaults → lični runtime → widget override, uz postojeću inherit/clear semantiku i autorizovane sportiste/aktivnosti. Period dolazi iz eksplicitnog runtime konteksta, sačuvane Page definicije razrešene serverskim vremenom ili eksplicitne `replacePageRuntime` namere. `legacyRuntime/null` bez runtime perioda vraća `pagePeriodRequired`; ne izmišlja shared period.

Token sadrži stvarni Page ID, a fingerprint vezuje Page defaults reviziju/filter/period i efektivni kontekst. Promena defaults-a poništava stari pregled i kada lični runtime maskira promenu. Preimenovanje, drugi widget i promena rasporeda nisu opšti razlog da nepovezani widget pregled postane zastareo. Izmena istog widgeta i dalje zahteva njegovu reviziju.

## Atomsko čuvanje

Migracija `202611041700_training_load_v58_page_simple_save.sql` dodaje Page članstvo Simple ledger-u i zasebnu funkciju `save_simple_page_widget`. Ne preusmerava legacy writer na osnovu internog markera. Nova funkcija izvodi pregledano S2c/v57 telo kroz strogo proverene zamene; neočekivan izvorni hash ili broj sidara prekida migraciju. Transformacija normalizuje LF/CRLF. SECURITY INVOKER i postojeće SQL provere ostaju.

Widget order, mobile order i nalaženje slobodnog položaja ograničeni su na ciljnu stranicu. Druga stranica sme koristiti iste koordinate. SQL proverava živu actor/workspace autorizaciju, dashboard i Page parent pre upisa. Interni `simpleSave` marker dozvoljava samo odgovarajuće widget/series trigger-e; legacy entry guard ostaje zatvoren.

Samo `periodIntent.mode:replacePageRuntime` uz `savePageDefaults:true` i `context.expectedPageDefaultsRevision` menja zajednički period. Promena perioda, widget, serije i receipt čuvaju se u istoj transakciji; zastarela defaults revizija vraća `stalePageDefaultsRevision`. Običan save ili lična zamena perioda ne menjaju shared defaults. Završen identičan zahtev vraća originalni receipt pre provere stare widget/defaults revizije ili arhive, ali uz trenutnu autorizaciju i stvarno widget/Page članstvo. Cross-Page promena istog request-a je konflikt; status druge stranice je `notFound`.

## Preostali uslovi za isporuku

Page-aware Advanced/layout/series writer-i, dashboard/template clone svih stranica, tabovi i „+ Stranica”, bezbedno prebacivanje sa nacrtom/nepoznatim ishodom save-a, vizuelna provera i konačna kompozicija sa main-om. Ne aktivirati ovu migraciju ili API kao samostalnu produkcionu isporuku.

Dokazi ciljanih testova, PostgreSQL/HTTP scenarija i nezavisne revizije beleže se u Draft PR-u i lokalnom statusu. Privatni backup/restore wrapper-i ne ulaze u Git. Bez merge-a, deploy-a, produkcionih operacija ili trajnih env promena.

Ciljane provere: 168/168 PASS. Stvarni PostgreSQL/HTTP integracioni test: 1/1 PASS sa 23 scenarija, uključujući dvoklijentsko čekanje/replay, defaults CAS i oporavak izgubljene COMMIT potvrde. Završna DDL kompozicija uključuje main 73193fe273b7c9bc79fbd5898de85571dab9c0c8 kroz v56, Pages v57 i Simple v58; to nije merge aktuelnog aplikacionog main-a. Sintetička baza je uklonjena, lokalni server zaustavljen, port zatvoren. Jedan nezavisni revizor je statički pregledao JS/SQL i završnu deltu redosleda zaključavanja, bez konkretnog P1/P2 nalaza; nije sam izvršavao DB provere.
