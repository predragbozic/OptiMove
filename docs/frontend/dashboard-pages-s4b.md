# S4b — backend osnova za stranice

Osnova je S4a Draft #368, HEAD `d78de79dc1d5e6092bebef48660161b42852d479`. S1.1 i S4a ugovor ostaju osnova. Ovaj kandidat priprema Page skladištenje, CRUD/query API i zaštitu starih klijenata. Nije završen korisnički Pages tok i nije namenjen samostalnom produkcionom rollout-u.

## Isporučeno

- Migracija `202611041500_training_load_v57_dashboard_pages.sql`: početna stranica za postojeće i nove dashboarde, stvarni Page FK widgeta, Page-scoped redosled/mobile/overlap, nezavisne sadržajne/defaults/layout/list revizije, trajni Page request ledger i sanctioned mutator.
- Postojeći widget/series ID-evi, konfiguracije, filteri i koordinate ostaju isti. Backfill ne izmišlja period. Početna stranica ima `legacyRuntime/null`; filter-only izmena ga zadržava, a samo eksplicitni periodConfig uvodi sačuvani period.
- Kreiranje, preimenovanje, defaults, kompletan reorder, duplicate i delete idu kroz jednu bounded transakciju i SQL funkciju. Actor/aktivni workspace/prava proveravaju se ponovo; telo zahteva ne određuje vlasnika. Poslednja stranica i limit32 proveravaju se pod dashboard lock-om.
- Duplicate pravi nezavisne widget/series ID-eve i zadržava konfiguraciju; nepoznati presentation sadržaj čuva se tačno. Brisanje neprazne stranice traži eksplicitni deleteWidgets. Ledger ostaje i kada je cilj obrisan, radi istog receipt-a umesto ponavljanja operacije.
- GET list/detail i Page query koriste bounded RR READ ONLY transakciju. Detalj sadrži samo widgete te stranice; query odbija strane widget ID-eve i koristi dashboard → Page → runtime → widget filter slojeve. Relative period razrešava server u zadatoj IANA zoni.
- API zahtevi ograničeni su na64KiB, stranice na32, query/detail na200 widgeta, read odgovor na4MiB. Upit do3000ms, transakcija do5000ms, ograničen checkout/COMMIT/recovery preko postojećih pregledanih lifecycle adaptera. To nije dokaz kapaciteta stvarne produkcione topologije.
- Legacy detail/query/layout/widget/series i novi Simple write bez Page konteksta odbijaju multi-page dashboard sa pagesClientRequired. DB trigger-i su backstop i za writer koji je krenuo pre paralelnog dodavanja stranice.
- Završen, identičan stari Simple zahtev zadržava read-only receipt/replay posle prelaska na multi-page, uz trenutnu autorizaciju i originalno widget članstvo. Bez tog izuzetka unknown-save klijent mogao bi ostati trajno zaključan. To ne omogućava novi legacy upis ili čitanje svih stranica.
- Flat legacy detail takođe čita autorizovan dashboard, Page guard, widgete i serije u jednom RR READ ONLY snapshot-u. Dve nevezane provere broja stranica nisu dovoljne kada se jedina stranica paralelno zameni.

SQL funkcije su SECURITY INVOKER, kao postojeći sanctioned ugovor. Nisu nova DB privilegijska granica. Interni Page marker ne zamenjuje API autorizaciju ili parent/FK proveru i ne izlaže se HTTP klijentu.

## HTTP površina

Rute iz S4a su pod `/api/training-load/dashboards/:dashboardId/pages`: list/create, detail/rename/delete, defaults, order, duplicate i query. Dodat je GET `/requests/:requestId` za proveru Page mutation ishoda. Parser radi pre globalnog JSON parsera i ograničava originalne bajtove. SQLSTATE odgovori imaju stabilne javne kodove; interni SQL, UUID-evi drugih workspace-ova i poruke driver-a ne prosleđuju se klijentu.

Struktura prati postojeći canView ugovor. Query traži odgovarajući aktivni data workspace; mutation/status/recovery proveravaju odgovarajuće trenutno pravo upravljanja i data workspace. Završen receipt može se pročitati i posle arhiviranja; novo izvršenje tada nije dozvoljeno.

## Namerno zatvoreno do narednog koraka

`pages:false` i `pageWidgetEditing:false` ostaju. Page management/query capabilities iz nove liste ne označavaju završenu frontend podršku. Pre opšte aktivacije ostaju:

1. Page-aware Simple preview/token/fingerprint/save/status port, uključujući Page defaults i page-local placement; današnji tagged Page kontekst još se kontrolisano odbija.
2. Page-aware Advanced/layout/series writer-i i dashboard/template clone svih stranica; današnji flat writer-i kontrolisano odbijaju multi-page, a Page duplicate je podržan.
3. Aktivni parent dashboard/stranica, „+ Stranica”, tabs/menus, lazy render/query, runtime period po stranici i bezbedno prebacivanje sa nacrtom/unknown save-om.
4. Kompozicija celog stack-a sa tada aktuelnim main-om, reprezentativni kapacitivni i operativni release gate. Ovaj kandidat ne menja runtime/env aktivaciju.

Zato sama migracija ili API nije isporuka dugmeta „+ Stranica”. Ne predlagati produkcioni deploy ove osnove bez tih nastavaka.

## Provere i izvori

Sedam ciljnih backend test fajlova:143/143 PASS. Obuhvataju Page contract/service/router, postojeći Simple contract, save transaction/recovery i S3a/runtime compatibility. Frontend nije menjan; nisu ponavljani frontend build ili nepovezane backend suite.

Engine harness je u `backend/tests/support/dashboard-pages-db-checks.mjs`: ne otvara bazu i ne čita env; zahteva već otvorene klijente i eksplicitno imenovanu lokalnu disposable bazu. Pruža backfill, funkcionalne i konkurentne provere. Stvarni lokalni rehearsal dodatno koristi autorizovan HTTP server, sintetičke korisnike/merne podatke i ranije izdvojenu strukturu/migration metadata iz backup-a. Poslovni redovi iz backup-a nisu restaurirani. Privatni restore/HTTP wrapper-i i rawDDL nisu deo ovog PR-a.

Provere obuhvataju: očuvanje backfill-a, parent/workspace/actor revokaciju, odvojene revizije, period prelaz, duplikat/opaque sadržaj, potvrdu brisanja/poslednju stranicu, durable replay, legacy guard-e, paralelni create/reorder/delete i limit32. HTTP proverava odgovarajuće javne odgovore i stvarni Page query. Regresija sa paralelnim duplicateP→Q i deleteP potvrđuje da legacy reader vraća konzistentni sadržaj P, umesto praznog rezultata koji nikad nije bio single-page stanje.

Pri početku rada main je bio `db7ebd557f0bbfcf3ec91f03a8e9bca051d78181` kroz v54. Tokom završne provere pojavio se `0ac2d2626da964e4026a98bfce4ec040f6ee10eb` sa v55 za club variables na team dashboardima. Slot je potom usklađen na v57 jer je main 73193fe273b7c9bc79fbd5898de85571dab9c0c8 zauzeo v56 za team import switch. Raniji dokaz važi za isto SQL telo pre promene imena; nastavak Simple porta proverava kompoziciju i sa main v56. Rehearsal uključuje te main migracije zajedno sa S2c i ovim Pages SQL-om; to nije tvrdnja da je ceo main aplikacioni stack već merge-ovan u ovu granu.

Jedan zaseban nezavisni revizor našao je P2 snapshot trku, zatvorenu RR transakcijom i ciljano ponovo pregledanu. SQL izvršilac je zasebna uloga i ne računa se kao nezavisna revizija. Rezultati stvarnog rehearsal-a, cleanup i tačan head/tree beleže se u Draft PR-u i lokalnom statusu. Ovo nije ljudsko odobrenje za merge/deploy.

Bez produkcionih upita/upisa/migracija, trajnih env promena, cloud resursa, merge-a ili deploy-a.
