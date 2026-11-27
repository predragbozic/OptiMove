# v104 — kopiranje Dashboard strane

Osnova probe je M-3c bridge iz commita `6b6ddf29a27799b09a47eee4c48829add9568fee`. Preflight proverava da je potvrđeni v103 poslednja migracija i da povučeni v100 nije primenjen.

Proverite ciljni host, port i ime baze. Izvršite `dashboard-page-copy-v104-preflight.sql` i proverite da su svi rezultati `true`. Posle odobrenja primenite v104 zvaničnim migration runner-om. Proverite oba rezultata iz `dashboard-page-copy-v104-postcheck.sql` pre otvaranja UI funkcije korisnicima.

Za povratak prvo vratite aplikaciju na build bez copy rute i sačekajte gašenje svih prethodnih instanci. `dashboard-page-copy-v104-rollback.sql` uklanja samo novu funkciju i zapis migracije. Kopirane strane i potvrde ostaju. SQL odbija povratak dok migration runner drži zaključavanje, ako je registrovana kasnija migracija ili je v104 izmenjen.

Lokalna proba koristi PostgreSQL 17 na loopback adresi i privremenu bazu iz test fixture-a. Pokrenite `node --test backend/tests/dashboard-pages-access.test.mjs` sa `DATABASE_URL` koji upućuje na izolovani test klaster. Završni test proverava postcheck, uklanjanje funkcije bez brisanja kopije, preflight posle povratka i ponovnu primenu zvaničnim runner-om. Ista proba obuhvata odbijanje tuđeg izvora, read-only korisnika, zastarelih revizija i prekinut upis posle nastanka strane, widgeta i serije.
