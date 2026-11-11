# S6a — galerija i prve dodatne ECharts varijante

Osnova: S5 Draft PR #376, `3e768cf56229ebe96e0ebaedf023fa70327ef825`. Ovo je prvi deo proširenja galerije, ne završetak svih predloženih tipova grafikona. Pragovi i reference nisu implementirani ovim korakom.

## Izbor u editoru

Display korak Simple editora ima šest kartica sa nazivom, opisom i originalnom dekorativnom SVG ilustracijom: Table, KPI, Line chart, Vertical bar, Area i Horizontal bar. Ilustracije nisu preview rezultata. Prava preview vrednost dolazi sa postojećeg autorizovanog servera, a klik na karticu menja samo nacrt. Uklanjaju se zastareli preview/token; Save ostaje vezan za novu potvrdu rezultata.

Area koristi `line_chart`, Horizontal bar koristi `bar_chart`; osnovni DB tipovi nisu prošireni. Njihova razlika čuva se kao strogo ograničen `presentation_config.chartVariant` (`area` ili `horizontal-bar`). Ne prihvataju se sirove ECharts opcije, callbacks, proizvoljni renderer ili nepoznata varijanta.

Postojeći izbor bez stvarne promene ne resetuje presentation. Nepoznati/opaque sidecar ne zamenjuje se galerijskim izborom; za promenu se koristi Advanced. Pri promeni grupisanja poznati sačuvani sidecar se kopira u nacrt i prilagođavaju se composition/zoom, uz očuvanje varijante, tooltip-a, fixed axis i drugih podržanih postavki. Sačuvani objekat se ne mutira.

Numeric gate, aktivni widgetTypes i server capabilities određuju dostupnost uz vidljivo objašnjenje. Table ostaje prikaz za nenumeričke vrednosti. Kartice koriste native radio kontrole, pristupačne nazive/opise, tastaturu, vidljiv fokus i responzivnu mrežu. Tema i biblioteka ostaju postojeće.

## Renderer i tačnost

Area dodaje samo transparentan fill, bez smoothing-a, stacking-a ili menjanja vrednosti. Horizontal bar menja kategorijsku i numeričku osu; zoom cilja kategorijsku Y osu, a granice i Auto/Reset ciljaju numeričku X osu. Tooltip, izbor tačke, stabilni identiteti, nule/negativne vrednosti i numerička tabela ostaju. Nedostajuće, konfliktne i duplirane vrednosti ostaju praznine; ne pretvaraju se u nule. Nema nove frontend agregacije/statistike ili procenta.

## DB ugovor i uključivanje

Nova razvojna migracija je `202611051200_training_load_v60_chart_gallery_variants.sql`. Menja postojeće funkcije validacije uz isti OID (`CREATE OR REPLACE`), zadržava podršku postojećim v1/opaque konfiguracijama i dodaje strogu proveru para varijanta/tip. Ne prepisuje widgete ni podatke. Marker funkcija služi za discovery; DB shape/compatibility funkcije ostaju autoritativni backstop za upis.

Bez v60, capabilities vraća prazan `chartVariants`, nove kartice su onemogućene i ručno sastavljen v1 variant preview se odbija. V1 gate se ne primenjuje na opaque future presentation pri title-only preserve. Runtime ostaje isključen po podrazumevanom podešavanju; nisu menjani env, ključevi, aktivacija, produkcija ili migracioni ledger van izolovanih test baza.

## Provere i nezavisna revizija

- Završni ciljani frontend: **370/370 PASS**; build PASS uz postojeće upozorenje o veličini chunk-a.
- Ciljani backend contract/compiler/capabilities/preview testovi: **123/123 PASS**. Širi backend unit prolaz: **622 PASS, 1 Builder FAIL** (41/42 fajla PASS). Isti Builder test pada i na tačnoj S5 osnovi, 10 PASS + 1 FAIL; backend Builder kod nije menjan. Širi frontend skup nije ponavljan; raniji release blockeri ostaju.
- Stvarni lokalni PostgreSQL/HTTP: **1/1 PASS**, pet dokumentovanih scenarija. Obuhvaćeni su opaque preserve pre v60, nedostupnost varijanti bez DB backstop-a, preview/save/replay/fresh detail za obe varijante i SQL odbijanje nepoznatih/pogrešno uparenih konfiguracija. DDL kompozicija uključuje main v56 i Pages v57–v59, zatim v60. Nije spojeno celo main aplikaciono stablo. Test baza obrisana, server ugašen, port zatvoren i cluster uklonjen.
- Browser provera izolovanih stvarnih frontend komponenti i vendored ECharts SVG renderera: Area i Horizontal bar imaju stvaran SVG, bez fallback greške; prazan dan ostaje prazan. Šest kartica i izbor provereni na desktopu; na 390×844 prikazu body/client širina su 375 px bez horizontalnog overflow-a. To je pregled sa sintetičkim podacima, odvojen od DB save testa, ne puni browser E2E.
- Nezavisna revizija našla je dva P2 (opaque readiness gate i reopened preserve/group zoom). Oba ispravljena i originalne memorijske reprodukcije zasebno ponovljene: valid opaque preserve bez markera; valid Area/Hbar day→athlete→week uz očuvanje opcija i nemutiran original; opaque group promena ostaje Advanced. Nema drugih potvrđenih P1/P2 u pregledanoj delti.

## Biblioteka i poreklo

Koristi se postojeći self-hosted Apache ECharts 6.1.0; vendor fajlovi, notice-i i licence nisu menjani. Nema CDN zahteva ili nove biblioteke. Proverene su zvanične [ECharts 6.1.0 licence](https://github.com/apache/echarts/blob/6.1.0/LICENSE) i [licenca examples repozitorijuma](https://github.com/apache/echarts-examples/blob/gh-pages/LICENSE), obe Apache 2.0. Implementacija varijanti je naša i prati zvanične API mogućnosti: [Area](https://echarts.apache.org/handbook/en/how-to/chart-types/line/area-line/) i [Bar](https://echarts.apache.org/handbook/en/how-to/chart-types/bar/basic-bar/). Tuđ primer/asset nije kopiran u repo. Ilustracije galerije su originalni kod.

## Nastavak galerije pre pragova/referenci

| Prikaz | Potrebna naredna podrška |
| --- | --- |
| Combined bar + line, dve ose | Više metričkih serija, eksplicitna osa/jedinica svake serije, poravnanje perioda i identiteta; Simple sada ima jednu DB seriju |
| Stacked bar | Eksplicitne aditivne komponente iste jedinice i tumačenja, politika praznina; bez prećutnog sabiranja sportista ili različitih metrika |
| Heatmap | Identitet svake ćelije, izbor dimenzija i legenda skale; pragovno bojenje je kasniji evaluator |
| Scatter | Serverom potvrđeni parovi dve metrike za isti subjekt/bucket, dve jedinice i nedvosmislen tretman nedostajućih parova |
| Box plot | Autorizovana raspodela/uzorak i definisana statistika; ne izmišljati kvartile iz već agregiranih proseka |

Ove mogućnosti nisu lažno dostupne u galeriji. Sledeći korak je ugovor višestrukih serija i kombinovanog grafikona, zatim ostali odobreni prikazi prema potrebnim podacima. Tek potom pragovi/referentne tabele/dinamički proseci prema dogovorenoj specifikaciji. Merge, deploy i produkciono puštanje zahtevaju zasebno odobrenje i razrešenje ranijih release ograničenja.
