# S3b — interaktivni grafikoni

S3b je zaseban Draft kandidat nad S3a `e1297bef9d0541e5311b81843d9a55112f892770`. Normativna osnova ostaje S1.1 `26162ae8f266eb24c88c601c8d4e8b9f1ca59be7`, posebno odeljak 5.2.

## Ponašanje

Novi Simple grafikoni koriste postojeći presentation sidecar. Za postojeći grafikon bez sidecara podrazumevano ostaje preserve; korisnik može eksplicitno izabrati interaktivni prikaz, nakon čega je obavezan novi preview pre čuvanja. Nepoznat postojeći sidecar ne zamenjuje se automatski.

Composer čita postojeći Display Model bez njegovog menjanja. Za `athletes-v1`, day/week prikaz daje zasebnu liniju/stubac svakom sportisti u kompatibilnom plotu; athlete poređenje ima zasebne athlete kategorije. DB serije, metric identiteti, jedinice, politike/podešeni izvori, prijavljeno poreklo i current/comparison faze ostaju odvojeni. Nema sabiranja, konverzije jedinica ili izbora prve duplirane vrednosti. Preko 20 sportista daje zahtev za uži izbor ili tabelu, bez odsecanja liste.

Vremenska osa je gusta i dolazi iz serverom potvrđenog perioda. Prazan dan/nedelja daje samo presentation prazninu, bez identiteta merenja i bez izmišljene nule. Problem redovi i duplikati ostaju u dostupnoj numeričkoj tabeli. Nedeljni zoom uključuje celu ponedeljak–nedelja kantu, presečenu granicama originalnog perioda.

Novi tooltip koristi punu numeričku vrednost iz postojećeg JSON transporta, osim kada sidecar eksplicitno traži formatted režim. Detalj tačke vezan je za queryId, fazu, sportistu, bucket, originalni rowIndex i isti kanonski identityKey; native izbor tačke koristi istu mapu kao klik grafikona. Legenda, lokalni zoom i Y režim ne menjaju backend filtere ili merenja. Dostupne su native kontrole za tastaturu i mobilni prikaz.

„Primeni period na dashboard” zasebno traži potvrdu u samom ekranu, sa datumima i dugmadima „Potvrdi period”/„Odustani”. Promena zoom-a poništava nepotvrđen izbor. Tek potvrda šalje jedan postojeći dashboard batch, uz proveru da upit, kontekst i widget još odgovaraju aktivnom prikazu. Preview editora ne nudi tu akciju. Nema shared defaults upisa. Query endpoint zato sada vraća neperzistirani server queryId i potvrđene konkretne granice perioda.

Lokalno stanje važi samo za isti query/kontekst/widget/presentation fingerprint, sa ograničenim cache-om. Workspace reset menja generaciju cache-a, tako da naknadni release starog elementa ne vraća staro stanje. Bez queryId nema obnove prethodnog stanja ni detalja bez identiteta. Disconnect i neuspešno delimično vezivanje uklanjaju handlere i kontrole.

## Provere i granice

Zadržani su postojeći self-hosted ECharts 6.1.0 i lossless numerička tabela. Nema nove biblioteke, CDN-a, migracije, produkcionog upisa, env promene, merge-a ili deploy-a. Runtime ostaje isključen po default-u. Lokalna provera sintetičkim podacima ne dokazuje produkcioni kapacitet.

Ručni pragovi, reference iz drugih tabela i dinamički proseci nisu izračunati u S3b. Zahtevi vlasnika i potrebni serverski korak opisani su u [zahtevima za reference](dashboard-reference-requirements.md). `backendReference`, `referencePercent` i evaluator pravila ostaju isključeni do zasebne implementacije/provere.
