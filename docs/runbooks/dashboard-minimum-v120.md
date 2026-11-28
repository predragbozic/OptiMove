# Dashboard Minimum v120

Migracija dozvoljava `min` u analitičkoj agregaciji dashboard serije. I dalje važe postojeća pravila za tekst, da/ne i izračunate odnose. Nema prepisivanja postojećih serija.

## Priprema i primena

1. Potvrdite ciljni host, port, ime baze i Git stanje. Prethodnik je `2cd4d6da`, sa v119 `202612211000_training_load_v119_sources_provider_team_pointer_generations.sql` i SHA-256 `55178f2f8ed4cdb7a738431383997532b15d4b03f7001b76004e1119029df99d`. Očekivani v120 je `202612221000_training_load_v120_dashboard_minimum.sql` sa SHA-256 `9ef591f0ed43fb776f6eecb1a820087b78792d755c85eb219333ce1a5a7010b7`.
2. Pokrenite `psql -X -v ON_ERROR_STOP=1 -f docs/runbooks/dashboard-minimum-v120-preflight.sql` preko potvrđene veze ka bazi. Nastavite kada skripta vrati `v120_preflight_ok = t`.
3. Primenite migraciju projektnim runner-om. On koristi istu migracionu bravu koju proverava rollback. Migracija čeka zaključavanje do pet sekundi. Ako ne dobije bravu, utvrdite zbog čega je zadržana pre ponovnog pokušaja.
4. Pokrenite `psql -X -v ON_ERROR_STOP=1 -f docs/runbooks/dashboard-minimum-v120-postcheck.sql`. Očekuje se `v120_postcheck_ok = t`. U aplikaciji proverite Minimum za postojeću numeričku metriku. Na istom periodu i filterima Preview i sačuvana tabela treba da vrate iste vrednosti.

## Povratak

Prvo zaustavite nove dashboard upise i sačekajte gašenje svih instanci koje mogu da sačuvaju Minimum. Dok su upisi zaustavljeni, pokrenite `psql -X -v ON_ERROR_STOP=1 -f docs/runbooks/dashboard-minimum-v120-rollback.sql`. Uspešan povratak vraća prethodno CHECK ograničenje i uklanja samo tačan v120 zapis iz registra. Ponovite preflight pre nastavka sa prethodnom verzijom aplikacije.

Ako postoji i jedna sačuvana Minimum serija, transakcija se prekida i v120 ostaje primenjen. Zadržite izdanje koje ume da čita te serije i dogovorite dalji postupak sa rukovodiocem. Skripta ne briše niti prepisuje korisničku konfiguraciju. Povratak se prekida i ako je migration runner aktivan, registrovana je druga migracija od v120 prefiksa nadalje ili se SHA-256 odnosno provere šeme ne podudaraju.

## Lokalna provera

Ponovite preflight, primenu kroz runner i postcheck na izolovanom PostgreSQL 17 sa tačnim v119 prethodnikom. Dokažite rollback sa sačuvanom Minimum serijom i proverite da su konfiguracija i v120 zapis ostali prisutni. U zasebnom stanju bez Minimum serija proverite uspešan rollback, ponovni preflight i ponovnu primenu kroz runner. Proverite i odbijanje kada je migration runner zaključan ili je registrovana kasnija migracija.
