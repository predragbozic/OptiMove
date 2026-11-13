# S6c — heatmap sportista × datum

Osnova: Draft PR #392, `956dfdfd23d204afb17ae3138e89afe6a623a6f9`. Heatmap je osmi izbor galerije. Ovaj korak ne aktivira pragove/reference i ne predstavlja odobrenje za merge ili deploy.

## Prikaz i izbor

Heatmap prikazuje jednu numeričku metriku, sportiste po redovima i dane ili nedelje po kolonama. Koristi postojeći `bar_chart` DB tip sa `schemaVersion:1`, `chartVariant:'heatmap'`, `chartComposition:'matrix-v1'` i postojećim interakcijama. Nije dodat proizvoljan ECharts options ulaz. Simple podržava nov i sačuvan widget kroz stvarni preview i atomski single-series save. Kartica je dostupna tek uz DB marker, numeričku metriku i day/week grupisanje.

Prelazak na drugi prikaz eksplicitno prilagođava composition, a ulazak u heatmap postavlja automatske ose. Promena između day/week čuva poznate opcije. Druga grupisanja se odbijaju jasnom porukom. Advanced čuva naslov i postojeće podržane opcije uz tačno jednu razrešenu numeričku seriju; za dodavanje druge prvo se menja display. Opaque future presentation ostaje nepromenjen i ne dobija v1 ograničenja.

## Tačnost ćelija

- Svaka ćelija zadržava originalni identitet serije/metrike, sportiste, bucket-a, jedinice i izvora, kao i rowIndex/queryId/raw podatke. Klik/native point preview koristi isti dataIndex kao ECharts.
- Gusta vremenska osa ne izmišlja merenja. Missing, konflikt i duplikat ostaju prazni; zero je prava nula i učestvuje u skali. Kod duplikata se ne bira prvi red; originalni redovi ostaju u tabeli i evidenciji ćelije.
- Različite stvarne jedinice unutar rezultata, tekstualne vrednosti, nepotpuna serija, poređenje perioda i nevažeći bucket odbijaju heatmap. Granica je 20 sportista; ništa se tiho ne skraćuje. Whole group ostaje posebna kategorija.
- Skala je automatski minimum/maksimum pouzdanih vrednosti u izabranom rezultatu. Ne računa se prosek, zbir, procenat, prag ili referentna vrednost. Promena izabranih podataka može promeniti skalu; to piše uz grafikon. Zato ista nijansa na dva različita upita ne označava nužno istu vrednost.
- Boja koristi jednu sekvencijalnu paletu, bez oznaka uspeha/neuspeha. Legenda prikazuje krajeve skale, caption jedinicu; tooltip daje tačnu vrednost. Fiksna numerička Y osa nije primenljiva na kategorijsku matricu.

Postojeći lokalni zoom utiče na datumsku X osu. Primena perioda zahteva postojeću eksplicitnu potvrdu. Reset, uključivanje/isključivanje serije, čitljivi nazivi, pristupačne kontrole i tačni detalji ostaju. Visina raste sa brojem sportista, do 730 px za 20 redova; na malom ekranu ostaju dostupni lokalni zoom i tabelarne vrednosti.

## Ugovor i DB

Razvojna migracija `202611051400_training_load_v62_heatmap.sql` koristi CREATE OR REPLACE za postojeći validator i kompatibilnost, čuvajući OID. Ne prepisuje widget redove. Strogo uparuje heatmap/matrix-v1, bar_chart/day-week i automatske ose, zadržavajući Area/Horizontal bar/Combined i opaque future verzije. Marker `dashboard_heatmap_v1()` omogućava capability discovery; ručno sastavljen preview se odbija pre v62.

Jedna serija je granica Simple ugovora. Advanced zadržava postojeći staged API; SQL ne nameće broj serija posle svakog pojedinačnog add/delete koraka, ali UI ne čuva nepodržan konačni oblik, a renderer odbija nepotpunu matricu uz tabelu.

## Biblioteka i provere

Završni ciljani skup 5. novembra 2026: **452/452 frontend**, **206/206 backend**, Vite build PASS uz postojeće upozorenje o veličini chunk-a. Nezavisna revizija našla je P2 title-only blokadu legalnog sidecara sa `chartInteractions:{}` bez eksplicitnog yAxis. Advanced sada koristi efektivnu podrazumevanu auto osu; originalni repro i regresija prolaze, uz neizmenjen sidecar. Završni recheck nema drugih otvorenih potvrđenih P1/P2 u pregledanoj delti.

Postojeći self-hosted ECharts 6.1.0 i licence nisu menjani. Nema novog CDN-a, paketa ili preuzetog gallery asseta; ikona je originalni SVG. Upotreba treće dimenzije za boju i dve kategorijske ose prati zvaničnu [Visual Mapping dokumentaciju](https://echarts.apache.org/handbook/en/concepts/visual-map/) i [heatmap izvorni kod](https://github.com/apache/echarts/blob/6.1.0/src/chart/heatmap/HeatmapView.ts).

Stvarni izolovani PostgreSQL/HTTP dokaz pokriva šest scenarija: kapiju pre v62 i opaque title-only preview, marker/isti OID, day i week preview/save/replay/detail/query, Page duplicate sa novim identitetima i SQL negativne provere. Posle probe test baza/server/cluster su uklonjeni, port zatvoren. Privatni backup fixture/test helperi nisu deo PR-a.

Komponentni browser pregled koristi stvarni vendored ECharts SVG i sintetičke podatke. Missing i konflikt su prazni, nula ostaje vrednost, konflikt 999 ne menja prikazanu skalu 0–330. Provereni su prelazak Area ↔ Heatmap, tačna nulta ćelija/identitet, zoom/reset i uski prikaz bez horizontalnog prelivanja. To nije ceo browser + DB E2E.

Raniji širi release problemi ostaju otvoreni; ciljani prolaz ove delte ne zamenjuje završnu proveru celog release-a. Stacked/Scatter/Box plot zahtevaju preostale ugovore podataka; zatim slede pragovi i reference prema dogovoru.
