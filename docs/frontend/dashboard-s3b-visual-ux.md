# S3b — vizuelna i UX dorada

Osnova je S3b Draft PR #355, HEAD `60a77aa7ef5af7cc9064e38b7979399467f7ed5e`.
Vlasnik je kao vizuelnu referencu dostavio `optimove-dashboard-demo.html`, uz istorijski PR #220 HEAD `b7d1127a11edb1debb5d1c222bd1db442ade724c`. Ta referenca ne predstavlja novo odobrenje za merge.

## Primenjeno

- Zelena akcentna boja `#157b70`, meka zelena podloga `#e5f3ef`, linije `#dbe5e6`, zaobljene kartice i mirnija tipografija prema maketi.
- Tri postojeća koraka Simple editora ostaju isti. Editor je sada imenovani region unutar stranice iznad kartica, bez prekrivanja ekrana i modalne Tab petlje. Na desktopu su podešavanja i preview jedan pored drugog; na telefonu idu vertikalno. Izabrani korak i tip prikaza imaju jasan okvir, a osnovna završna akcija vizuelni prioritet.
- Napredne opcije su sklopljene van osnovnog toka; otvoreno stanje ostaje sačuvano tokom osvežavanja istog nacrta. Postojeće vraćanje fokusa, potvrda odbacivanja i unknown-save zaštita ostaju aktivni.
- Dok je editor otvoren, dashboard ostaje vidljiv i čitljiv, ali su njegove forme onemogućene kroz native disabled fieldset. Filteri su u sklopivom pregledu sa nazivom dashboarda i datumima. Popoveri se zatvaraju pre prvog prikaza editora; drag/resize putanja eksplicitno odbija rad tokom Simple editora.
- Direktno dugme „Podesi” postoji na karticama u običnom prikazu. Tokom uređivanja rasporeda koristi se postojeći meni da se ne preklopi sa drag ručicom. KPI naslov, broj i jedinica staju u malu karticu bez promene sačuvanih dimenzija. Mobilni filteri raspoređuju datume jedan uz drugi.
- Kontrole interaktivnog grafikona dostupne su kroz tastaturom pristupačan native disclosure. Početno su sklopljene. U otvorenom panelu period, vidljive serije, izbor tačke i vraćanje prikaza imaju zasebne nazive grupa.
- Prikaz/sakrivanje serije ima `aria-pressed`, usklađen sa stvarnim legend stanjem. Boja nije jedini signal.
- Lokalni zoom i promena perioda dashboarda ostaju odvojene radnje. Potvrda promene perioda ostaje eksplicitna.
- Čitljivije tabele, tabularne cifre i zasebno horizontalno pomeranje. Duga preview tabela ima ograničenu visinu sa tastaturom dostupnim skrolom, bez izbacivanja redova. Sve originalne vrednosti i problem stanja ostaju dostupni; tabela grafikona ostaje početno otvorena.
- Grafička paleta potiče iz makete; oker nijansa je tamnija radi kontrasta. Boja ostaje stabilna prema identitetu sportiste. Nema zaglađivanja, dopunjavanja praznina ili ponovnog računanja vrednosti.
- Legenda koristi ime bez tehničkog ID-a kada je jedinstveno u plotu. Istoimeni sportisti imaju ID oznaku, a kolizije konačnih naziva razrešavaju se jednoznačnim parom ime/ID. Originalni identitet redova i stabilni series.id ostaju isti.

## Granice

Ovo je dorada postojećih renderera. Ne implementira Pages, drugu DB seriju, pravila bojenja tabela, pragove ili dinamičke reference iz narednih faza. Sintetičke agregacije i skladištenje stanja iz HTML demonstracije nisu preneti u aplikaciju.

Ne menjaju se backend, autorizacija, šema, sačuvane koordinate, KPI limit širine, display ugovori ili sačuvane konfiguracije. Legacy grafikoni koriste prethodni composer; nova paleta odnosi se na postojeći opt-in interaktivni composer.

Kartice na desktopu poštuju sačuvanu visinu i zadržavaju unutrašnje pomeranje za duge tabele i otvorene kontrole. Na telefonu se sadržaj raspoređuje vertikalno. Potpuno preslikavanje demo shell-a i Pages navigacije pripada kasnijem odobrenom opsegu.

Pozadina ostaje svetla i koristi postojeće aplikacione surface/text promenljive. Ne uvodi se zaseban birač teme, color-scheme ili sistem tema za Dashboard. Buduće teme treba rešavati za celu aplikaciju.

## Provera

- Devet ciljanih frontend test fajlova: **174/174 PASS**, uključujući postojeće UX/Advanced tokove i regresije inline editora, popovera, pointer blokade i naziva legendi.
- Poslednja dva izmenjena test fajla: **49/49 PASS**, uključujući dodatnu proveru očuvanja otvorenog Advanced prikaza i fokusa. To je pretežno podskup prethodne grupe, ne 49 dodatnih različitih testova.
- Lokalni browser koristi stvarni renderer i akcije editora, uz isključivo sintetičke podatke i simulirane odgovore: desktop/telefon, SVG, tri koraka, preview, disabled dashboard kontrole, čitljivi KPI brojevi i merenje da se dugmad ne preklapaju. Ovo nije nova HTTP/DB provera niti produkcioni test; browser fixture ne izvršava stvarni save.
- Završni build i nezavisna revizija evidentiraju se u opisu Draft PR-a.

Bez merge-a, deploy-a, produkcionih operacija i prelaska na S3c/S3d.
