# Pragovi i referentne vrednosti — zahtevi vlasnika

4. novembar 2026. Dopuna zahteva uz S3b. Ovo je specifikacija za sledeće korake, a ne implementirana mogućnost ili odobrenje migracije. Zahtev proširuje buduću referentnu podršku iz S1.1; `backendReference` i `referencePercent` ostaju isključeni dok odgovarajući serverski ugovor ne bude završen.

## Tri izvora reference

1. **Ručna vrednost ili opseg:** trener unosi prag za konkretnu metriku, sa istom jedinicom i jasnim datumom važenja. Referentna linija/opseg na grafikonu ne menja izvorno merenje.
2. **Uređena referentna tabela:** vrednost po metric definiciji i odgovarajućoj kombinaciji kriterijuma, npr. pozicija u timu, uzrast i pol. Referenca može biti timska, klupska ili druga eksplicitno dozvoljena. Dvosmisleno poklapanje više redova nije izbor prvog reda.
3. **Dinamička referenca:** proseci poslednjih N odgovarajućih utakmica, pojedinačno ili po eksplicitno definisanoj grupi. Lični prosek i prosek pozicije su različite reference i moraju imati različite identitete i objašnjenja.

Primer: tabela treninga ima Total distance, HMLD i Speed distance. Svaka ćelija dobija sopstvenu referencu utakmice za tu metriku i sportistu/grupu. Prikazuju se izmerena vrednost, referenca, odnos/odstupanje i razlog oznake boje. Boja nije jedini signal. Ne sabiraju se različite metrike ili jedinice.

## Obavezan identitet i poreklo

Referenca mora imati stabilan ID/verziju, metricDefinitionId, semantiku/agregaciju, jedinicu, populaciju, period/pravilo izbora, datum važenja i serverski evaluatedAt. Izvorne utakmice i broj uključenih merenja moraju biti objašnjivi u okviru dozvola korisnika. Sama činjenica da se broj nalazi u nekoj tabeli nije dozvola za njegovo korišćenje u drugom workspace-u.

Pozicija, uzrast i pripadnost timu mogu se menjati. Za istorijski rezultat mora biti definisano da li se koristi stanje na datum merenja ili drugo izričito izabrano stanje. Nedostajući kriterijum nije dozvola da se tiho upotrebi tuđa pozicija ili opšti prosek.

## Pravila dinamičkog proseka koja treba zaključiti pre implementacije

- Poslednjih pet **različitih utakmica**, prema vremenu i uslovima izbora, a ne pet redova/bucket-a. Razlikovati poslednjih pet timskih utakmica od poslednjih pet utakmica u kojima je taj igrač učestvovao.
- Referenca za istorijski trening ne uključuje kasnije utakmice niti sam rezultat koji se ocenjuje.
- Jasno definisati koje utakmice ulaze: status, učešće, minimalni minuti, prijateljske/zvanične utakmice i eventualna normalizacija na 90 minuta. Sirova vrednost i vrednost po 90 minuta nisu iste metrike i ne menjaju se prećutno.
- Prosek po poziciji može značiti prosek svih player-match merenja ili prosek ličnih proseka. Težine i način grupisanja moraju biti izričiti.
- Navesti minimalan uzorak i ponašanje kada postoje samo dve od traženih pet utakmica: delimična referenca sa vidljivim brojem ili nedostupna referenca. Nedostatak nije nula.
- Procenat traži uporedivu jedinicu i definisan, važeći imenilac. Nulta, nedostajuća ili semantički neodgovarajuća referenca daje objašnjivo stanje, bez izmišljenog procenta.

Ova pitanja se rešavaju u ciljanoj specifikaciji serverskih referenci. S3b ne uvodi proizvoljne podrazumevane izbore umesto trenera.

## Promene referentnih opsega kroz vreme

Grafikon mora moći kasnije da prikaže referentnu liniju ili opseg koji važi za svaki datum, umesto jedne konstante preko celog perioda. Promena reference ima verziju i datum važenja. Istorijski prikaz mora jasno razlikovati tada važeću referencu od naknadne ponovne procene po novom modelu.

Značajna promena, varijacija i slične oznake zahtevaju eksplicitnu metodologiju: osnovni period, minimalni uzorak, metodu, parametre i značenje praga za konkretnu metriku. Ne uvoditi univerzalni procenat, standardnu devijaciju ili automatsku ocenu rizika kao podrazumevanu činjenicu.

## Redosled rada

### Dopuna vlasnika — 6. novembar 2026.

Galerija uključuje i budući **Spider/Radar**. Vlasnik je potvrdio procenat reference: **100% znači dostignutu referencu**, 80% ostvarenje 80% reference. To nije postojeći `referencePercent` iz S1.1, gde jednakost daje 0% odstupanja. Novi obračun `referenceAttainment` / `attainment-positive-v1` računa `value / reference * 100`, zahteva pozitivnu referencu i nenegativnu količinu, ne pretvara nedostatak u nulu i ne ograničava 120% na 100%. Boja ili veći procenat sami po sebi ne znače bolji rezultat.

S7a uvodi izolovan ugovor i čist obračun; ne aktivira novu karticu galerije, upis referenci ili capability. [Plan i granice aktivacije](dashboard-references-s7a.md).

S3b čuva identitet sportiste/metrike, vremenski bucket, jedinicu, izvor i originalni red, prikazuje ih u detaljima i ne menja merenja. S3c uvodi ugovor pravila tabela. Pre referenci iz tabela, dinamičkih proseka i procenata potreban je prošireni serverski korak referenci, ranije označen kao S3d; ovaj zahtev ga čini potrebnim za opisani krajnji scenario. Frontend ne računa te reference samostalno. Šema, dozvole, izbor uzorka i verzionisanje prvo se pregledaju i odobravaju kao zasebna celina.
