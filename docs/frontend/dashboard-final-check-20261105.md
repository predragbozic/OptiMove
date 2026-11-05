# Završna ciljana provera Dashboards — 5. novembar 2026.

## Proverena osnova

Draft lanac #368 → #370 → #371 → #374 → #376 ostaje nespojen. S5 osnova za proveru je `c4232c8cb63b72ed16b54815fcbc4c719bf5cbc3`; izabrani main snapshot je `003d1fab58ae654412d582adbe082defd5f93fcd`. Provera je izvršena u zasebnoj lokalnoj radnoj kopiji `OptiMove-final-check`, sa dodatnom ispravkom opisanom ispod. Nije izvršen GitHub merge niti deploy.

Lokalna kompozicija ima jedan tekstualni konflikt: `handleTrainingLoadBeforeUnload`. Razrešen je unijom zaštita za Page nepotvrđeni upis, Simple nacrt, import, roster, variables, source fields i novi mappings tok sa main-a. Ta integraciona korekcija je samo u lokalnoj kopiji; #376 ostaje stacked PR prema #374. Ovaj izveštaj ne pretvara #376 u PR direktno prema main-u.

## Ispravka iz nezavisne revizije

P2: zakasnela potvrda Page create/duplicate operacije mogla je da pozove refresh sa starim Page ID-jem u novom kontekstu. Handler sada hvata analysis instancu, identitet/radni prostor, dashboard i Page pre upisa. Potvrde i greške iz zastarelog konteksta se ignorišu; posle refresha ponovo se proverava aktivni kontekst pre reconcile/UI izmena. Ista zaštita obuhvata status/retry.

Dodate su trajne regresije za promenu korisnika, analysis instance, dashboarda i Page dok je upis u toku. Nezavisna ponovna provera: 24/24 memorijske reprodukcije po kopiji, uključujući promenu konteksta tokom refresha, zakasnelu grešku i redovne create/delete/recovery tokove. Nije potvrđen drugi P1/P2 u pregledanom opsegu.

Legacy presentation-writer test je prilagođen stvarnim transakcionim portovima: mock obuhvata novi export, read-only checkout, Page authorization boundary, timeout komande i povratni ID kreirane serije. Test i dalje proverava očuvanje poznatih/nepoznatih sidecar-a, parametre sanctioned writer-a i rollback cele clone operacije. Produkciona autorizacija i transakcioni kod nisu menjani radi tog testa.

## Rezultati integracione kopije

| Provera | Rezultat |
| --- | --- |
| Pages, Simple, Analysis, chart i UX ciljani frontend | 348/348 PASS |
| Backend unit, izolovani runner bez DATABASE_URL | 47/47 fajlova, 673/673 testova PASS |
| Frontend production build | PASS; postojeće upozorenje o veličini chunk-a |
| Stvarni lokalni PostgreSQL + autorizovani HTTP | 1/1 test PASS, 19 zasebno zabeleženih scenarija |
| Nezavisna ponovna provera P2 | 24/24 po kopiji PASS |

PostgreSQL provera koristi strukturu i metapodatke lokalne backup probe i isključivo sintetičke poslovne podatke. Aktuelni main DDL kroz v56 primenjen je pre seedovanja podataka, zatim Page v57/v58/v59. SQL fajlovi nisu prepisivani niti su checksum provere zaobilažene. Privatna test priprema zadržava naziv korena `migrations_v2`, potreban za identičan ledger ključ. Test baza je obrisana, server ugašen, port zatvoren i privatni cluster uklonjen — sva četiri cleanup dokaza su true.

Scenariji uključuju Page Simple preview/save i čitanje sačuvanog naslova iz novog detail odgovora; Advanced create/series izmene; zabranu stranog Page/widget/series ID-ja; lokalni layout CAS i nepromenjenu drugu Page; replay/status; rollback revizija i ledger-a; clone svih stranica i prazne stranice sa novim ID-jevima; konkurentnu promenu metric verzije; arhiviranje organizacije; izgubljenu COMMIT potvrdu; unresolved template clone i naknadnu popravku; odbijanje nedostupnog pinned izvora bez ostataka kopije.

## Širi frontend skup — ograničenje izlaska

Širi integrisani prolaz: **2900 testova, 2885 PASS, 13 FAIL, 2 cancelled/timeout**. Dvanaest padova i dva timeout-a već su potvrđeni na prethodnoj osnovi (Builder/static source assertions, media, sign-out cache i kalendar sa datumima; Training Load X5a/X5b timeout). Dodatni Drive import pad očekuje da prvi paralelni zahtev uvek pripada prvom fajlu. U paralelnom radu može prvi završiti drugi fajl; izdvojena provera prolazi i na pinovanom main-u i na integracionoj kopiji. To je zabeleženo kao nestabilan test, ne kao dokaz potpuno zelenog širokog skupa. Import kod nije menjan u ovom zadatku. Široki skup nije ponovo pokretan posle lokalnih korekcija.

Zaključak: ciljani Dashboards tokovi su provereni i otkriveni P2 je ispravljen. **Nema odobrenja za produkcioni izlazak**: pre njega ostaju razrešenje širokih testova, pregled konkretne integracione grane i posebno odobrenje merge/deploy-a. Lokalni HTTP test nije browser E2E niti dokaz produkcionog kapaciteta.

## Sledeći dogovoreni rad

Posle ove provere ide galerija grafikona, pa pragovi i reference. Za galeriju prvo proveriti podršku postojeće ECharts biblioteke i licence konkretnih primera/dodataka; ne uvoditi novu biblioteku samo radi galerije. Plan galerije mora definisati potrebne podatke i granice svakog prikaza. Pragovi/reference ostaju serverski validirane mogućnosti: ručne vrednosti, referentne tabele po poziciji/uzrastu/polu i dinamički timski/individualni proseci. Ovaj korak ih ne označava implementiranim.
