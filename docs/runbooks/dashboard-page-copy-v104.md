# v104 — kopiranje Dashboard strane

Ova proba polazi od v102. Ako M-3c uđe prvi, pre puštanja identifikujte njegov tačan commit i checksum za v103, uskladite preflight sa tim prethodnikom i ponovite probu. v100 je povučen broj, pa preflight izričito proverava da stari pisac nije primenjen.

Proverite ciljni host, port i ime baze. Izvršite `dashboard-page-copy-v104-preflight.sql` i proverite da su svi rezultati `true`. Posle odobrenja primenite v104 zvaničnim migration runner-om. Proverite oba rezultata iz `dashboard-page-copy-v104-postcheck.sql` pre otvaranja UI funkcije korisnicima.

Za povratak prvo vratite aplikaciju na build bez copy rute i sačekajte gašenje svih prethodnih instanci. `dashboard-page-copy-v104-rollback.sql` uklanja samo novu funkciju i zapis migracije. Kopirane strane i potvrde ostaju. SQL odbija povratak dok migration runner drži zaključavanje, ako je registrovana kasnija migracija ili je v104 izmenjen.

Lokalna proba koristi PostgreSQL 17 na loopback adresi i privremenu bazu iz test fixture-a. Pokrenite `node --test backend/tests/dashboard-pages-access.test.mjs` sa `DATABASE_URL` koji upućuje na izolovani test klaster. Završni test proverava postcheck, uklanjanje funkcije bez brisanja kopije, preflight posle povratka i ponovnu primenu zvaničnim runner-om. Ista proba obuhvata odbijanje tuđeg izvora, read-only korisnika, zastarelih revizija i prekinut upis posle nastanka strane, widgeta i serije.
