# S7a — ugovor referenci, procenata i budućeg Radar prikaza

Osnova: Draft PR #397, `1230a6aa8e7d7012c79a56553629b08f8f6d2f6e`. Zahtevi: [pragovi i reference](dashboard-reference-requirements.md). Vlasnik je 6. novembra potvrdio Spider/Radar i procenat ostvarenja reference.

Ovaj korak isporučuje **izolovan ugovor i obračun**, uz pregled spremnosti podataka. Nema runtime importa, API-ja, baze, migracije, novih podešavanja, aktivacije capability-ja ili Radar renderera. Prolaz validatora znači ispravan oblik podataka, a ne dozvolu pristupa, naučnu uporedivost ili dokaz rezultata. Postojeći `backendReference` i `referencePercent` ostaju isključeni. Nijedan klijentski zahtev ne sme kasnije sam da proglasi referencu autorizovanom.

## Obračuni i prikaz

| Izbor | Obračun | Kada je merenje jednako referenci |
|---|---|---|
| Value | originalna vrednost | originalna vrednost |
| Difference | vrednost − referenca, ista jedinica | 0 jedinica |
| Relative change (`referencePercent`) | (vrednost − referenca) / abs(referenca) × 100 | 0% |
| Reference attainment (`referenceAttainment`) | vrednost / referenca × 100 | **100%** |

`signed-relative-abs-v1` ostaje postojeći S1.1 obračun odstupanja. Novi `attainment-positive-v1` je ostvarenje za Radar i kasniji prikaz ćelija. Ne preimenuje se postojeći operand i ne menja se značenje starih sačuvanih pravila.

Radar ostvarenje traži referencu > 0 i vrednost >= 0. Odstupanje dozvoljava negativnu referencu, ali ne nultu; razlika dozvoljava i nulu. Nedostatak, tekst, pogrešna jedinica, NaN, beskonačnost i prelivanje daju `unavailable` sa razlogom, nikada izmišljenu nulu. Nema automatskog pretvaranja m u km, skraćivanja na 100% ili automatskog tumačenja da je više bolje. Za negativne/signed metrike potrebna je druga izričita metodologija, van Radar v1.

## Ugovori

`backend/src/dashboardReferences/contract.js` sadrži validatore definicije, budućeg serverskog opažanja reference i konfiguracije Radar-a. `calculations.js` radi samo strogu, determinističku aritmetiku bez čitanja podataka ili mutiranja ulaza.

Definicija nosi stabilan ID/reviziju, ime, owner, binding, populaciju, datume važenja i izvor. Binding fiksira metricDefinitionId i nepromenljivu verziju metrike, jedinicu, scope, agregaciju, source/connection, role i coverage politike iz postojećeg query modela. Promena bindinga znači novu pregledanu referencu/reviziju, a ne tiho prevezivanje stare reference na sadašnju metriku. U ovom prvom ugovoru reference koriste catalog metrike; built-in reference zahtevaju zasebno proširenje.

Populacije su individual, team i position. Individual znači ličnu referencu sportiste iz konkretnog rezultata; nije dozvola za sve sportiste. Team/position nose eksplicitan teamId. Position zahteva stanje na datum merenja. Ugovor ne rešava te identitete iz sadašnjeg profila.

Izvori su odvojeni:

1. `manual`: trenerova konačna numerička vrednost, vezana za jedinicu, populaciju i interval definicije. Nula je dozvoljena definicija za razlike, ali nije validan imenilac za procenat. Ručni opsezi/pragovi čuvaju se kao pravila i intervali, ne pretvaraju se prećutno u jednu referentnu vrednost.
2. `referenceTable`: eksplicitan ID/revizija uređene tabele, dimenzije position/ageBand/sex na datum merenja. Nijedan proizvoljan SQL naziv tabele nije ugovor. Više poklapanja daje unavailable; nema uzimanja prvog reda, opšteg proseka ili tuđe pozicije. Model i čuvanje redova ove tabele još nisu implementirani.
3. `rollingMatches`: traženi/minimalni broj različitih utakmica, vidljiva politika delimičnog uzorka, timske ili utakmice u kojima je sportista učestvovao, official ili officialAndFriendly, eksplicitni minimalni minuti, težine i striktni cutoff pre merenja uz isključenje ocenjenog događaja. Normalizacija je trenutno samo none. Nema pretvaranja običnog trajanja u odigrane minute ili per-90 vrednosti. Nema automatskog izbora ovih parametara: ugovor ih zahteva.

Opažanje reference vezuje queryId, referenceId/reviziju, sportistu, bucket, binding, measurementInstant, lokalni datum/timeZone, evaluatedAt i status. Datum mora odgovarati trenutku u datoj zoni. Dostupan rezultat nosi konačnu vrednost; unavailable nosi null i razlog. Za dinamički uzorak traženi/upotrebljeni broj i različiti eventIds ostaju objašnjivi u granicama dozvola. Ovaj oblik sam po sebi ne dokazuje da su događaji zaista utakmice, raniji, dozvoljeni ili iz odgovarajuće populacije: to mora potvrditi budući serverski adapter.

Radar konfiguracija ima 3–8 različitih metric osi i 1–5 sportista, svaka osa ID/reviziju svoje reference, `attainment-positive-v1`, minimum 0 i automatski gornji opseg. Nedostajuća/nevažeća osa odbija taj poligon uz vidljiv razlog i zadržava tabelu; ne prikazuje se lažna zatvorena površina sa nulom. 100% referentni obris, legenda, tooltip stvarna vrednost/jedinica/referenca/procenat i objašnjiv klik pripadaju kasnijoj implementaciji. Ovaj ugovor ne dodaje `radar` postojećim runtime šemama niti karticu galerije.

## Proverena spremnost repozitorijuma

Ovo je ograničen pregled koda i migracija, ne pregled podataka produkcione baze.

| Potrebno | Šta postoji | Šta još nedostaje pre aktivacije |
|---|---|---|
| Tim na istorijski datum | `athlete_membership_periods` i activity roster v25 | Poznate stare archive/restore rupe ne mogu se rekonstruisati; nema tihog dopunjavanja |
| Pozicija / uzrast / pol | sport_positions i kriterijumi normi u testing podsistemu; birth_date u trenutnom profilu | Nije pronađena istorija dodele pozicije u pregledanim putanjama; testing norme su vezane za test parameters, ne Dashboard metricDefinitionId. DOB se uređuje u mestu; pol nema potvrđen istorijski tok |
| Različite utakmice | UUID aktivnosti, match activity type, datumi/zona, životni ciklus i supersession | Query sada ne bira poslednjih pet utakmica; nije pronađena official/friendly klasifikacija u pregledanoj šemi |
| Učešće i minuti | roster odluke, participant zapisi, početak/kraj i GPEXE TIME | participation_status nije dovoljan; GPEXE TIME je ukupno trajanje sesije, ne potvrđeni playing minutes |
| Import utakmica | postojeći canonical links i import mapper | Pregledani mapper prepoznaje FULL TRAINING; ne sme se tvrditi da već uvozi match aktivnosti |
| Pristup i semantika | postojeći workspace/metric/source access predikati, immutable metric versions i conflict flags | Novi adapter mora nezavisno autorizovati referencu, svaki izvorni red/događaj i populaciju, proveriti semantički binding i actual-result proof |

Dokazi u repou: `migrations_v2/202609251000_training_load_v25_activity_roster_foundation.sql`; `202608220900_tests_v42_schema.sql`; `202609071000_training_activity_v1_core_tables.sql`; `202609041400_training_load_v10_metrics_catalog.sql`; `backend/src/routes/athleteProfile.js`; `backend/src/activityRoster.js`; `backend/src/gpexeImportMapper.js`; `backend/src/trainingLoadDashboardQuery.js`; `backend/src/dashboardSimple/previewContext.js`.

## Redosled implementacije

1. **S7a, ovaj Draft:** pregledan ugovor, obračuni, inventar podataka i granice aktivacije.
2. **S7b, ručni pragovi/reference:** serversko čuvanje i validacija, evaluator nad stvarnim vraćenim rezultatima, datum važenja, jednostavna podešavanja, oznaka/tekst uz boju u tabeli i referentna linija/opseg za podržane chart prikaze. Nulta/neuporediva referenca ostaje objašnjivo nedostupna. Zasebna PG/HTTP i vizuelna provera.
3. **S7c, Spider/Radar:** koristiti istu proverenu referentnu uslugu; prvo radi sa ručnim referencama, a kasnije dobija iste izvore iz tabela/proseka. Ne računati različite fizičke jedinice na istoj apsolutnoj skali.
4. **S7d, referentne tabele:** verzionisano skladište, owner/workspace dozvole, istorijske dimenzije, strogo jedinstveno poklapanje i poreklo redova. Rešiti potvrđene nedostatke podataka pre aktivacije pojedine dimenzije.
5. **S7e, dinamičke reference:** adapter različitih utakmica, istorijski roster, eksplicitni minuti/vrste utakmica, stabilan vremenski izbor, minimalan uzorak/težine i objašnjiva porekla. Ako potrebni faktovi nisu raspoloživi, vraća unavailable; ne izmišlja se prosečna utakmica iz dnevnih bucket-a.

Širi završni integration/release pregled ostaje potreban pre odluke o deploy-u. Nema merge, deploy-a, produkcionih upisa, promene env ili provisioninga u ovom Draft-u.

## Provera ovog koraka

19 novih ciljanih testova ugovora/aritmetike: tri izvora, source/role/coverage politike, datumi/zona, sample status i jedinstveni eventIds, dve procentualne formule, 120% bez clamp-a, nula/negativno/prelivanje, nevalidan JSON i sopstveni/nasleđeni getter-i, nepromenjen ulaz i Radar granice. Ukupno 138/138 sa postojećim contract/compiler/capability proverama. Nezavisna ciljana revizija i konačni rezultat zabeleženi su u statusu zadatka. Postojeći runtime contracts/capabilities se ne aktiviraju i ne menjaju.

Nema PG ili browser probe: ovaj korak nema SQL, HTTP ili UI putanju. Njihova simulacija ovde ne bi bila dokaz aktivacije. Raniji puni baseline padovi/timeouts ostaju van ove izolovane provere.
