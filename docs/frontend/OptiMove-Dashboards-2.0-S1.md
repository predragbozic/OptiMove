# OptiMove Dashboards 2.0 — S1

## Simple Editor Contract & Model

**29. oktobar 2026. · Predlog ugovora 1.0 · Za odobrenje naredne faze**

Konačni UX je odobren: Team Performance, Pages (Dnevni izveštaj, Nedeljni izveštaj, Igrači, Utakmice), Simple Editor u tri koraka, preview pre dodavanja, napredne opcije van osnovnog toka, interaktivni grafikoni i razumljiva pravila tabela. S1 pretvara taj pravac u tehnički ugovor; ne menja UX i ne implementira produkcione funkcije.

**Preporuka:** isti kanonski query i Display Model V1/V2; zajednički validator/kompajler za preview i atomski save; zaseban verzionisani presentation ugovor za interakcije i tabele. Backend izračunava i proverava podatke i odstupanja; frontend prikazuje proverene vrednosti i njihove oznake.

## 1. Granice i proverena osnova

Pregledan je aktuelni `main` repozitorijuma `predragbozic/OptiMove` na commitu **82fbb3ca14754442dc3a7f78a92a7e6a090393a2** (PR #255). U odnosu na S0 runtime osnovu `165998802ab6655260559da4af483c7e4e554d6d`, GitHub compare pokazuje šest dokumentacionih fajlova, bez runtime/schema/dependency izmena. Dashboard moduli su ponovo pročitani na novom punom SHA; pregledani su i relevantni testovi, katalog, workspace/auth moduli i aktuelni Metrics Core plan. Aktuelna S0 datoteka pročitana je iz sačuvanog izveštaja; kasnije eksplicitne korisničke odluke imaju prednost nad ranijim predlozima.

S1 isporuka je ovaj dokument sa modelima i matricom provera. Nisu menjani repo fajlovi, postojeća konfiguracija, prototip ili aplikacija; nije kreiran PR, pokrenut backend, test suite, migracija, merge, deploy ni produkcioni upit. Snimci šeme i source ne dokazuju trenutno primenjene migracije ili produkcionu dostupnost podataka. Test matrica predstavlja obavezu buduće implementacije, ne izvršene testove.

| Ugovor koji postoji danas | Dokaz u main-u | Posledica |
| --- | --- | --- |
| Četiri widget tipa | v18 seed, `training-load-analysis-data.js` | API ključevi ostaju `kpi`, `line_chart`, `bar_chart`, `table` |
| V1/absent/null čitanje i strog V2 | `training-load-analysis-display-config.js` | Nema dodatnih polja u V2; nepoznata verzija ostaje unsupported |
| V2 samo numberFormat/legend/valueLabels | Isti normalizer | Interakcije i formatting ne mogu se samo dopisati u V2 |
| Server proverava minimalni schemaVersion | Dashboard route `validDisplayConfig`, red 95 | Novi save mora proveravati punu novu strukturu i V2, uz preserve put za stare blobove |
| Identitet, problem stanja i lossless redovi | `training-load-analysis-display-model.js` | Nema objedinjavanja sportista, izvora ili jedinica, coercion-a ili biranja prvog KPI reda |
| ECharts jedan plot po chartGroups particiji | `training-load-analysis-echarts-options.js` | Interakcije rade unutar te particije; legend ne opravdava promenu particionisanja |
| Tooltip sada zaokružuje prema precision | `training-load-analysis-echarts.js`, mount | Za tačnu vrednost u tooltip-u potreban je kontrolisan adapter update |
| Nema dataZoom/click/legend state ugovora | Ista dva modula | Ne tvrditi da je tražena interaktivnost već završena |
| Jedan batch sačuvanih widgeta | POST `/:dashboardId/query`, `queryDashboard` | Nema query-a nesnimljenog drafta; novi preview adapter je potreban |
| Period do 400 dana, query do 200 widgeta, athleteIds do 500 | Dashboard route | Sačuvati granice; preview dodatno ograničen na jedan widget/jednu seriju |
| Default → request → widget filter | `trainingLoadDashboardQuery.js:617+` | Page sloj dodaje se pre runtime-a, bez promene inherit/clear semantike |
| Upis kroz sanctioned funkcije, klon izuzetak | ADR-003, Widgets/Catalog | Atomic Simple save dobija novu sanctioned transakciju; HTTP compensation nije atomika |
| Owner i data workspace su nezavisni | ADR-002, DashboardAccess/route | Novi endpointi moraju proveravati oba i parent članstvo |
| Katalog vraća current version i scope_capabilities | MetricsCatalog/listDefinitions | Nema paralelnog registra ili izmišljanja default agregacije |

**Dve konkretne integracione granice:** v42 je već imenovana za Claude Phase 5b zone model i ne može se rezervisati za Dashboard. Persisted KPI danas ima `max_width=4`; odobreni prototip ima i široke KPI kartice. Za verno mapiranje dve desktop kartice širine 6 potrebna je kasnija eksplicitna promena kataloškog limita do 6, uz postojeći 12-column model. Ovaj dokument predlaže taj tehnički korak za odobrenje; ne sužava odobreni UX i ne menja katalog. Mobilne dve kartice u redu su poseban responsive prikaz, bez prepisivanja sačuvanih koordinata.

## 2. Normativne odluke

„MORA” označava acceptance uslov; „predlog” je buduća projektna odluka koja se potvrđuje odobrenjem ovog ugovora. Svi novi endpointi, DTO objekti, tokeni, kolone i error kodovi opisani u nastavku su **predlog**, ne zatečeni API.

1. Simple Editor pravi ili menja jedan widget sa tačno jednom razrešenom serijom. Multi-series, unresolved/ambiguous i ostale složene konfiguracije ostaju u Advanced Editor-u.
2. Metrika → sportisti i period → prikaz ostaju jedina tri koraka. U pouzdanom slučaju trener ne bira scope, axis, coverage, source policy ili agregacionu funkciju.
3. Period pripada stranici; pojedinačni widget ima eksplicitan athlete/activity/component override, bez datuma u override-u. Promena perioda iz editora je vidljivo označena kao promena za celu stranicu.
4. Preview koristi autorizovane stvarne podatke preko postojećeg query engine-a. Nema probnog widgeta, upisa preview rezultata ili frontend računanja merenja.
5. Upis nastupa samo posle završne korisničke akcije. Preview token potvrđuje validiran draft i kontekst, ne zamrzava rezultate merenja.
6. V1/V2 ostaju isti ugovori. Novi presentation sidecar je odvojen; nema implicitnog upgrade-a ili gubitka starih polja.
7. Tooltip, legend, zoom i izbor tačke su presentation/runtime interakcije. Ne menjaju query/agregaciju/period ostalih widgeta bez posebne eksplicitne akcije.
8. Sva primena pravila tabela i računanje odstupanja imaju jedan backend evaluator posle kanonskog query-a. Raw/result `value` se ne menja.
9. Boja nikada nije jedini signal. Problem stanja imaju prednost nad pravilima; nikad se ne računaju kao nula.
10. Existing API i shared Claude autorizacija nisu dozvola ovom toku da menja podatke, izvršava migracije ili deploy.

## 3. Funkcionalna specifikacija editora

### 3.1 Metrika

Picker koristi postojeće GET `/api/training-load/metrics/definitions?state=active&search=...&limit=100` sa postojećim cursor-ima; domains/categories/structure-links služe za jasne kategorije. Built-in vrednosti dolaze iz postojećeg kataloga, sa odvojenim discriminator-om. Svaki izbor ima naziv, jedinicu ili objašnjenje da jedinica nije zadana, kategoriju i vrednosni tip. Nedostatak kategorije nije nedostupnost metrike. Pretraga mora razlikovati prazno, učitavanje, grešku i nepotpuno učitanu listu; nema prećutnog skraćivanja kataloga.

`metricRef` je tagged union: ili `kind=metric` + `metricDefinitionId`, ili `kind=builtin` + `key`; nikad oba. Jedini izvor dozvole je server. Dostupnost se proverava pri izboru, pri preview-u i ponovo u save transakciji. Neaktivna ili tuđa nova referenca daje info-hiding odbijanje, bez otkrivanja postojanja. Workspace promena briše picker cache/draft kontekst i zahteva novi izbor ili autorizovano ponovno otvaranje.

`catalogToken` je server fingerprint važeće definicije/verzije, tipa, jedinice, scope capabilities i state-a; nije token dozvole. Promena semantike između preview-a i save-a daje `catalogChanged`, bez automatskog prevezivanja verzije. Sačuvani metric_definition_id ostaje kanonski ID; vrednosti ostaju vezane za sopstvene istorijske verzije, kao danas.

### 3.2 Sportisti i period

Početno stanje je „Prati filtere stranice”, uz konkretna imena/broj i datume. Imenovani picker nudi samo vidljive sportiste u aktivnom workspace-u. API ni ovde ne prima owner/workspace da bi klijent birao tuđi podatkovni kontekst.

`inherit` ne šalje athleteIds ključ u widget override-u. `selected` zahteva 1–500 jedinstvenih UUID-ova; prazan izbor je greška u editoru. Posebna akcija „Svi dostupni” znači `allAuthorized`, koja se prevodi u eksplicitno `athleteIds:null`, uz server autorizovano ograničenje. Stari raw `athleteIds:[]` nastavlja da znači isto što i null; UI nikada ne koristi deselect-all kao tu akciju.

Activity i component ostaju Advanced opcije sa tri stanja: inherit / clear / concrete ID. Promena roditeljske aktivnosti ne sme tiho zadržati komponentu koja joj ne pripada; traži se razrešenje pre preview-a. Otvaranje starog widgeta ne prepravlja njegov filter.

Page period ima fixed ili relative definiciju sa eksplicitnom IANA zonom. Datumi su lokalni ISO datumi, uključivi; server razrešava relativni opseg i vraća konkretne granice. `this_week` znači ponedeljak–nedelja, `last_7_days` danas minus 6 do danas: različiti preset-i. Backend ima autoritativni `evaluatedAt`; UI ne koristi uređajev sat da bi drugi saradnik dobio drugi shared period. Dok Pages nisu persistirane, legacy adapter ima postojeći runtime period bez automatskog čuvanja.

Promena perioda u draftu ne menja Dashboard dok se ne pritisne završna akcija. Posle uspešnog save-a primenjuje se kao lični runtime period cele stranice, osim ako je korisnik izričito izabrao „Sačuvaj kao početne filtere”. Taj shared upis ima zaseban manage/revision guard i u istoj je save transakciji. Sam pregled stranice ne upisuje shared defaults.

Efektivan filter ostaje: dashboard default → saved Page default → runtime Page izbor → widget override → obavezna workspace autorizacija. Override je zamena po ključu, ne presek sa Page izborom. Badge i rezime ističu poseban izbor i nude „Vrati na filtere stranice”. Ta akcija briše override ključ; ne šalje null umesto inherit-a.

### 3.3 Prikaz i automatski predlog

| Izbor korisnika | API tip / grupisanje | Kada je pouzdan |
| --- | --- | --- |
| KPI | `kpi`; obično `athlete` za jednog sportistu | Tačno jedan važeći scalar u realnom preview rezultatu; nema uzimanja prvog reda |
| Trend | `line_chart`; `day` ili `week` | Numerički scalar-i, validne vremenske kante; particije ostaju odvojene |
| Poređenje | `bar_chart`; `athlete` | Numerički rezultati po sportisti u istim dozvoljenim semantičkim granicama; različite jedinice/izvori se ne spajaju |
| Tabela | `table`; dozvoljeni postojeći groupBy | Siguran izbor za više grupa, tekst, boolean, array i problem stanja |

Predlog je `reliable` samo ako katalog/capabilities i eksplicitna politika daju jednoznačan scope/agregaciju. U suprotnom je `requiresChoice`, uz jasno objašnjenje u istom koraku i odlazak u Advanced po potrebi. Nema novih vrednosti `groupBy` ili univerzalnog sum za svaku numeričku metriku. Daily aggregation metadata nije automatski dozvola da se ista funkcija primeni između sportista ili kroz ceo period.

Za built-in se koriste stvarni catalog default-i: RPE avg/session; sRPE sum/session; duration_minutes sum/session; session_count sum/day; last_session_date last/day. Built-in source policy je `not_applicable`; metric default-i i policies moraju biti validni po postojećim validatorima. Postojeći defaults `all_with_conflicts`, `standalone_and_source_rollup`, `complete_and_partial` nisu dozvola da se konflikt pretvori u zbir.

Završni preview prikazuje stvarne rezultate, tačan period, naziv, jedinicu i efektivne filtere. Validan empty/missing/conflict rezultat može se sačuvati, uz vidljivo upozorenje i korisničku potvrdu; query error ili nevalidna konfiguracija zahtevaju retry/korekciju. KPI sa više grupa ostaje bez headline-a i blokira finalno dodavanje dok se kontekst ne suzi ili ne izabere Table. Izbor jednog sportiste sam po sebi nije garancija jednog reda: odluku donosi stvarni preview, bez tihog automatskog prebacivanja na drugi tip. Nema četvrtog koraka.

### 3.4 Stanja, otkazivanje i osvežavanje

Editor ima stanja `editing`, `validating`, `previewLoading`, `previewReady`, `previewProblem`, `saving`, `outcomeUnknown`, `saved`. Jedan draftVersion raste na svaku stvarnu promenu. Promena query/presentation postavke poništava prethodni preview token i u letu zahtev; loading ima prednost nad starim rezultatima. Title-only promena može osvežiti prikaz lokalno, ali zahteva novi validirani token za finalni identičan payload.

Cancel odbacuje draft i staged period/defaults; pre prvog write-a nema compensation poziva. Zatvaranje prljavog drafta nudi ostani/odbaci. Posle nepoznatog save ishoda UI kaže „Rezultat nije potvrđen” i omogućuje proveru istog zahteva; ne nudi „Otkaži sve” kao da server sigurno nije ništa snimio. Save dugme se zaključava dok je zahtev u letu; sam disabled nije zaštita od dupliranja.

## 4. Predlog modela konfiguracije

### 4.1 Razdvojeni životni vekovi

| Deo | Životni vek / vlasnik | Sadržaj |
| --- | --- | --- |
| EditorDraft v1 | Lokalni, nesnimljeni | Koraci, metricRef, selector, query intent, title i presentation izbor |
| Compiled widget/series | Server → postojeće tabele | Postojeći metric ID, scope, aggregation, groupBy, policy i revision ugovori |
| display_config V1/V2 | Postojeće polje | Isti V1/V2 ugovor i postojeći normalizer |
| presentation_config v1 | Predlog nove nullable JSON kolone widgeta | Samo deklarativni chartInteractions i tableFormatting |
| InteractionState v1 | Lokalni, nesnimljeni | Zoom prozor, legend selected, izabrana tačka, otvoren detalj |
| RuleEvaluation v1 | Query response, bez čuvanja u metric_values | Proverena annotation, reference identitet i evaluaciono stanje |

`presentation_config` zahteva buduću aditivnu migraciju i route/clone proširenje. Ne ubacivati ova polja u display_config V2, template hints, title ili source policy. Čitanje sidecar-a null znači bez novih mogućnosti i bez upisa. Nepoznata sidecar verzija prikazuje osnovne vrednosti i upozorenje da su dodatne opcije nepodržane; Simple save ne prepisuje sidecar. Invalid sidecar takođe ne narušava postojeći validan Display Model.

### 4.2 Draft v1 — konkretan primer

```json
{
  "contractVersion": 1,
  "draftId": "11111111-1111-4111-8111-111111111111",
  "draftVersion": 3,
  "title": "sRPE po danima",
  "metricRef": {"kind": "builtin", "key": "srpe"},
  "athleteSelection": {"mode": "inherit"},
  "advancedFilter": {
    "activity": {"mode": "inherit"},
    "component": {"mode": "inherit"}
  },
  "periodIntent": {"mode": "inherit"},
  "view": {
    "type": "line_chart",
    "groupBy": "day",
    "dataScopeLevel": "session",
    "analyticalAggregation": "sum"
  },
  "display": {
    "mode": "replace",
    "value": {"schemaVersion": 2, "numberFormat": {"maximumFractionDigits": 1}}
  },
  "presentation": {
    "mode": "replace",
    "value": {
      "schemaVersion": 1,
      "chartInteractions": {
        "tooltip": {"mode": "exact"},
        "legend": {"toggle": true},
        "zoom": {"mode": "local", "applyPeriodAction": true},
        "pointSelection": {"mode": "details"},
        "yAxis": {"mode": "auto"}
      }
    }
  }
}
```

Ovo je kompletan Simple draft primer za built-in. `view` vrednosti mogu biti automatski popunjene proverеним predlogom; nisu nova obavezna tehnička polja osnovnog ekrana. Metric varijanta metricRef ima samo `kind:metric` i UUID `metricDefinitionId`, uz odvojen server catalogToken. Policies koje osnovni editor ne menja compiler preuzima iz existing widgeta ili postojećih važećih default-a. Klijent ne sme slati `resolutionStatus`, owner, workspace, SQL, formule ili proizvoljne ECharts opcije.

Za update, `display:{mode:preserve}` i `presentation:{mode:preserve}` čuvaju originalne server blobove bez njihovog slanja/normalizovanog prepisivanja. Replace je dozvoljen samo za potpuno validnu podržanu strukturu. Nema null-as-delete; brisanje sidecar-a je eksplicitno `presentation:{mode:clear}` i traži potvrdu korisnika ako uklanja postojeća pravila. New create nema preserve izvor i prihvata replace ili izostavljene sekcije sa dokumentovanim novim defaults.

`periodIntent` je union inherit ili `replacePageRuntime` sa periodConfig; opciona odvojena `savePageDefaults:true` označava eksplicitan shared upis i dozvoljena je tek uz persisted Pages capability. Bez te zastavice runtime promena nije DB upis filtera. `athleteSelection` je inherit / selected + athleteIds / allAuthorized. Activity/component su inherit / clear / selected + id. Dodatna polja u svim novim objektima su greška (`additionalProperties:false`).

### 4.3 Osnovne granice validacije

Draft UUID; draftVersion pozitivan safe integer; title trim 1–200 znakova. Tačno jedan metricRef i jedna resolved serija. Tipovi/groupBy/scope/aggregation samo postojeće enum vrednosti i kompatibilne kombinacije. Datum je stvaran kalendarski datum, opseg uključiv, dateTo ≥ dateFrom, najviše 400 dana; validna IANA zona. Athlete UUID-ovi jedinstveni, 1–500 za selected. Reference source/metric/athlete/activity/component proveravaju se na serveru u stvarnom kontekstu.

Predlog novih zaštitnih granica: preview body do 64 KiB, jedna serija, najviše 20 table pravila; label pravila do 120 znakova, lokalno renderovan escaped plain text; response limit 2 MiB bez silent truncation-a. Prevelik rezultat daje `previewTooLarge` i predlog užeg opsega, ne nepotpun „uspešan” preview. Limiti se primenjuju i na HTML fallback/table data da zaštita ne nestane ako chart nije učitan. Preview timeout predlog 10s, sa cancel/retry ponašanjem; nema produkcionog SLA dok se ne izmeri dogovoreni fixture.


### 4.4 Precizni union-i i normalizacija

| Objekat | Dozvoljene varijante / obavezna polja |
| --- | --- |
| metricRef | `{kind:metric,metricDefinitionId:UUID}` ili `{kind:builtin,key:activeBuiltinKey}` |
| athleteSelection | `{mode:inherit}`, `{mode:allAuthorized}` ili `{mode:selected,athleteIds:UUID[1..500]}` |
| activity/component | `{mode:inherit}`, `{mode:clear}` ili `{mode:selected,id:UUID}` |
| periodIntent | `{mode:inherit}` ili `{mode:replacePageRuntime,periodConfig:PeriodConfigV1,savePageDefaults:boolean}` |
| PeriodConfigV1 | `{schemaVersion:1,mode:fixed,dateFrom:ISODate,dateTo:ISODate,timeZone:IANA}` ili `{schemaVersion:1,mode:relative,preset:Preset,timeZone:IANA}` |
| Preset v1 | `today`, `last_7_days`, `last_28_days`, `this_week`; drugi preset zahteva eksplicitno proširenje capability-ja |
| display | Za create: izostavljeno ili `{mode:replace,value:ValidDisplayV2}`. Za update: preserve ili eksplicitni replace podržane verzije; legacy V1 se prenosi samo preserve putem |
| presentation | Create: izostavljeno ili replace sa PresentationV1. Update: preserve / replace / clear; polja se ne kombinuju između varijanti |
| view | type, groupBy, dataScopeLevel, analyticalAggregation; obavezna validna proverena kombinacija pre query-a, makar popunjena compiler predlogom |
| yAxis | `{mode:auto}` ili `{mode:fixed,min:finiteNumber,max:finiteNumber}` |
| rule reference | `{kind:constant,value:finiteNumber,unit:stringOrNull}` ili `{kind:backendReference,id:opaqueId,semanticsVersion:nonemptyString}` |

Nijedan union ne prihvata polja druge varijante. Novi objekti odbijaju unknown keys; izostavljene opcione sekcije dobijaju samo dokumentovane defaults. `view` bez validnih parametara može proći inicijalni editing state, ali ne preview/save. Jedina nullable polja su eksplicitno navedena; null nije opšti način resetovanja.

`context.period` je obavezan za legacy adapter. Za Page može biti izostavljen (server koristi Page saved/default period) ili predstavljati lični konkretan runtime opseg; server ga proverava. `periodIntent:replacePageRuntime` ima prednost nad tim kontekstom. `savePageDefaults` je polje samo replace varijante i eksplicitno false po početnom izboru; true se nudi samo manager-u sa persisted Pages capability-jem.

IdentityHash za annotation koristi SHA-256 nad UTF-8 kanonskim JSON-om tačno iste `identity` strukture koju gradi postojeći Display Model: seriesId, metricDefinitionId, builtInSeriesKey, athleteId, bucketKey, unit, groupBy, source(policy/configuredConnectionId/reported). Object keys su leksikografski sortirani rekurzivno, redosled nizova se čuva, izostavljeno prijavljeno source polje se ne pretvara u izmišljenu null činjenicu. Server i frontend fixture-i moraju dokazati identičnu serializaciju. Numerička vrednost nije deo identiteta, ali queryId/fingerprint vezuje annotation za konkretni rezultat. Nema sortiranja raw redova pre izračunavanja rowIndex-a.

## 5. ECharts interakcioni ugovor

### 5.1 Deklarativna struktura v1

`chartInteractions` važi samo za line_chart/bar_chart. Dozvoljeni su tooltip.mode=`exact|formatted`; legend.toggle boolean; zoom.mode=`disabled|local`; zoom.applyPeriodAction boolean; pointSelection.mode=`disabled|details`; yAxis union auto ili fixed sa min/max. Nepoznat ključ/vrednost se odbija pri novom upisu. Tooltip `formatted` koristi postojeću numberFormat prezentaciju; `exact` je default za nove Simple grafikone. Vidljivost legende i value labels ostaje u display_config, bez drugog kontradiktornog visible polja u sidecar-u.

Osnovni flow ne prikazuje ova tehnička polja. Novi Simple grafikoni dobijaju pouzdane defaults; postojeći bez sidecar-a zadržavaju sadašnje ponašanje. Ručni Y opseg je Advanced; promena X metrike ili zamena jedinice nisu axis formatting i zahtevaju novi query intent/preview.

| Interakcija | Obavezno ponašanje | ECharts adapter |
| --- | --- | --- |
| Tooltip | Pun server-transport numerički rezultat, jedinica, bucket, sportista, naziv i prijavljeni source/provenance; nula i negativni brojevi ostaju vidljivi | RichText, confine; lokalna safe formatter funkcija, nikad callback iz JSON-a |
| Legend toggle | Sakrije/prikaže samo odgovarajući prikaz serije u datoj particiji; ne filtrira backend i ne briše tabelu | `legendselectchanged`; stanje po plotKey + seriesId, ne samo po nazivu |
| Zoom | Lokalni prozor unutar već učitanih podataka; nema nove agregacije, sumiranja ili downsampling-a koji gubi redove/status | `dataZoom`, slider; inside pinch po potrebi, mouse wheel off da ne zarobi scroll stranice |
| Primeni period | Zasebna akcija sa jasnim uticajem na celu Page; posle potvrde šalje jedan novi Page batch | Mapiranje krajnjih bucket-a u validne datume; nema implicitnog query-a na svaki drag |
| Tačka/bar | Detalj tačno odabranog server reda, uključujući status i provenance; bez upisa ili automatskog sportista filtera | `click` mapiran kroz plotRows → originalni row locator; ne indeks prve sirove liste |
| Resize/mobile | Isti numerički sadržaj; prilagođene oznake/touch target, tap za detalj; bez hover-only bitne informacije | Postojeći ResizeObserver, resize/dispose i generation guard |

„Tačna vrednost” znači punu preciznost broja koji je već stigao postojećim JSON ugovorom, bez dodatnog toFixed zaokruživanja tooltip-a. Nije obećanje proizvoljne decimalne preciznosti izvan postojećeg transporta. Zabeležena server jedinica može biti null; ne izmišljati RPE/count jedinicu iz UI labela kao novu stvarnu jedinicu.

### 5.2 Ose, zoom i granice identiteta

X je postojeći groupBy/bucket, ne slobodno proizvoljno polje. Day i week su vremenski bucket-i; backend week key je datum ponedeljka (`isoWeekKey`). Primena week zoom-a uključuje celu izabranu nedeljnu kantu, presečenu postojećim query opsegom; server revalidira datume. Session/component/athlete/cohort kategoričke ose nemaju „Primeni period”; ne tumačiti UUID kao datum. Za day/week bar ili line dozvoljen local zoom; za ostale zoom disabled u v1.

Y auto zadržava postojeću ECharts value-axis semantiku, uključujući prikaz nule i negativnih vrednosti. Fixed zahteva finite min < max i istu jedinicu; ne skalira ili konvertuje meru. Vrednosti van opsega ne clamp-uju se u izmišljenu graničnu vrednost: jasno upozorenje i dostupne originalne vrednosti u tabeli; korisnik može vratiti auto. Log ose, dual-unit overlay i izmena unit labela kao konverzije nisu u ovom ugovoru.

Plot key obuhvata widget, seriju, metric/built-in identitet, sportistu, grupisanje, stvarnu jedinicu i raspoloživi prijavljeni source identitet/provenance. Konfigurisana source connection nije zamena za prijavljeni source. Kao danas, jedan chartGroups partition je jedan plot. Legend state ostaje lokalno tom plot-u; skrivanje svih serija ima vidljivo „Serija je skrivena” i reset, a ne false missing/error. Različite jedinice ili izvori ne postaju zajednička osa radi lakše legende.

`InteractionState` se ne snima u display_config i ne bump-uje revisions. Čuva se lokalno samo dok plot data/context fingerprint ostaje isti. Promena workspace-a, query perioda, widget sadržaja ili nestanak particije resetuje stanje; UI-only repaint ga ne gubi. Local zoom ne menja dostupnu numeričku tabelu; klik „Primeni period” menja runtime Page kontekst eksplicitno. Cancel editora ne primenjuje zoom kao Page filter.

Missing/conflict/error/unsupported/duplicate bucket ostaju gaps; `connectNulls:false`, bez front imputation-a ili pretvaranja false/string/array u broj. Numerička tabela omogućuje pregled svih problem redova koje null chart tačka ne može da klikne. Event handler za dataIndex mora koristiti istu sortiranu listu koju je adapter poslao u plot; dupli bucket ne bira „prvu” meru.

Chart mount/disconnect uklanja instance, ResizeObserver i sve `on/off` handlere. Odloženi import ne montira chart starog drafta ili neaktivne Page. ECharts je postojeći pinned self-hosted 6.1.0, bez CDN-a ili druge biblioteke. Accessibility tabela ostaje dostupna kad biblioteka ne uspe da se učita; tastatura i native kontrole imaju isti put do izbora/detalja/reset-a.

## 6. Deklarativna pravila tabela

### 6.1 Model v1

Pravila se podešavaju u Advanced za Table, ne dodaju novi obavezni korak. Mogu se pregledati iz menija tabele: naziv, šta se poredi, jedinica, pragovi, cilj, stil i objašnjenje. UI rečenica mora odgovarati serijalizovanom pravilu, npr. „sRPE veći od 2.000 AU → oznaka Iznad praga”.

```json
{
  "schemaVersion": 1,
  "tableFormatting": {
    "evaluationVersion": 1,
    "rules": [
      {
        "id": "review-high-load",
        "priority": 10,
        "enabled": true,
        "name": "Opterećenje iznad izabranog praga",
        "target": {
          "series": "main",
          "phase": "current",
          "cell": "value",
          "athletes": {"mode": "allReturned"}
        },
        "operand": "value",
        "operator": "gt",
        "threshold": {"value": 2000, "unit": "AU"},
        "style": {
          "tone": "caution",
          "marker": "up",
          "label": "Iznad izabranog praga"
        }
      }
    ]
  }
}
```

Ovaj objekat je sidecar presentation_config za Table; nema chartInteractions sekcije. `series:main` je logički slot jedine Simple serije, koji compiler u preview-u mapira na draft series ID, a pri save-u na persisted ID. Kada se postojeći widget pretvori u multi-series Advanced konfiguraciju, dodatna pravila moraju imati eksplicitne ciljeve; `main` ne sme neprimetno početi da znači drugu metriku. Promena metrike/jedinice sa pravilima traži njihovu ponovnu validaciju i novi preview, ne automatsko prenošenje pragova.

### 6.2 Polja, operatori i jedinice

| Polje | Normativni ugovor |
| --- | --- |
| id / priority | Stabilan lokalni ID do 64 znaka; jedinstveni pozitivan priority; manji broj je ranije pravilo |
| target | Samo value ćelija navedenog series slot-a, phase=current u v1; allReturned ili eksplicitni athleteIds u dozvoljenom skupu |
| operand | `value`, `referenceDifference` ili `referencePercent`; poslednja dva zahtevaju reference objekat |
| operator | `gt`, `gte`, `lt`, `lte`, `between`, `outside` |
| threshold | Za jednovrednosni operator finite value i tačna jedinica; null jedinica znači zaista unitless, ne wildcard |
| range | Za between/outside: finite lower/upper, lower ≤ upper, lowerInclusive/upperInclusive booleans, unit |
| reference | `constant` sa finite value/unit ili `backendReference` sa autorizovanim opaque ID i eksplicitnim semanticsVersion |
| formulaVersion | Obavezno i tačno `signed-relative-abs-v1` samo za operand referencePercent; u ostalim operandima izostavljeno |
| style | tone=`neutral|positive|caution|negative`; marker=`none|up|down|check|alert|star1|star2|star3`; obavezan smislen plain-text label |

Value threshold jedinica mora biti ista kao stvarna output jedinica i vezana semantika metrike. Za referenceDifference threshold je u jedinici metrike; za referencePercent prag je u `%`, dok reference mora biti u originalnoj jedinici metrike. Nema jedinica m↔km konverzije u evaluatoru ili frontend-u. Precision prikaza ne utiče na granice: 1999,96 se poredi pre formatiranja na 2000. Equality se ne dodaje preko proizvoljnog epsilon-a.

Za gt/gte/lt/lte obavezan je threshold i zabranjen range; za between/outside obavezan je range i zabranjen threshold. Za operand=value nema reference/formulaVersion; za referenceDifference obavezna je reference, bez formulaVersion; za referencePercent obavezni su reference i imenovana formulaVersion. Unitless se piše kao JSON null, nikada kao prazna proizvoljna wildcard jedinica.

Za between, oba testa krajeva moraju proći sa zadatim inclusivity. Outside je tačan komplement tako definisanog intervala, ali samo na eligible konačnim numeričkim vrednostima. Jednake donja/gornja granica dozvoljene su samo kada su oba kraja uključiva; ostale prazne intervale odbiti kao grešku konfiguracije. Nije dozvoljena arbitrana formula, regex, HTML, CSS boja, JS callback, URL slike ili korisnički SVG.

### 6.3 Reference i odstupanja

`constant` je vrednost koju je korisnik svesno uneo kao prag/referencu za izlaznu agregiranu ćeliju. Ne postaje nova kanonska metrika ili istorijsko merenje. `backendReference` nije naziv za sada nepostojeći reference endpoint: omogućava se tek kada postoji imenovan, autorizovan resolver u backendu. Capability mora biti false do tada; ne uzimati „prosek ekipe” u frontend-u niti proglasiti trenutni katalog dovoljnim dokazom referentne vrednosti.

Resolver vraća jednu referencu odgovarajućeg athlete/cohort/grain/period/unit/source/metric semantic konteksta, njenu verziju i provenance. Ako nedostaje, ima više kandidata, različitu jedinicu, nepoznatu semantiku ili source konflikt, pravilo je notApplicable sa razlogom, bez povoljne boje. Kod agregiranih output ćelija referenca mora eksplicitno važiti za tu agregaciju i opseg. Nema poređenja daily reference sa weekly sum-om samo zato što oba nose AU.

Za `referenceDifference` definicija v1 je **value − reference**. Za opcioni `referencePercent` predlaže se jedina imenovana formula **signed-relative-abs-v1: 100 × (value − reference) / abs(reference)**. Potrebni su finite scalar-i, kompatibilan kontekst, reference ≠ 0 i finite rezultat. Nulta referenca daje `undefinedReferenceZero`; nema infinity, nule, epsilon denominator-a ili deljenja frontend-a. Formula koristi abs denominator da znak znači numerički rast/pad i kod negativne reference; ne znači automatski sportsko poboljšanje. Negativne reference dozvoliti samo ako metrika/referenca takav domen validno podržavaju.

Primer za proveru: value=1250 AU, reference=1000 AU → difference=250 AU, referencePercent=25%; pravilo `gt 20 %` daje odgovarajuću oznaku. value=0, reference=1000 → −100%; value=−80, reference=−100 → +20% samo ako je takav domen dozvoljen. Ovo je **predlog eksplicitne formule za odobrenje**, ne novi već postojeći backend obračun. Capability za percent ostaje false dok zasebna implementacija formule i njeni fixture testovi nisu odobreni i prošli.

Derived annotation se vraća u query response, nikada ne prepisuje value/rawValue/rawCount, ne ide u metric_values i ne menja aggregationRole/source politika. Percent/delta badge ima navedenu referencu i verziju formule; nijedan tooltip ne prikazuje ga kao izmerenu metričku vrednost.

### 6.4 Redosled evaluacije i vizuelna primena

Prvo proveriti status originalne ćelije. Samo `value` + finite numeric scalar + kompatibilna jedinica/semantika je eligible. Missing, konflikt bilo kog tipa, error, unsupported, string, boolean, array, non-finite i nedovoljno jasan identitet ne ulaze u poređenje. Problem status se prikazuje nezavisno; nema „uspešnog” check mark-a. Dupli identiteti/bucket-i ostaju dostupni kao redovi, ali ne dobijaju izmišljenu jedinstvenu referencu ili automatsku ocenu.

Pravila se proveravaju po priority; prvo enabled eligible podudaranje daje **jedan** style. Ne mešati pozadine i strelice iz više različitih pravila. Ako se intervali preklapaju, editor pokazuje upozorenje i jasno koji ima prioritet; rezultat je determinističan. Bez match-a vrednost je neutralna, bez oznake. Disabled pravilo ne učestvuje.

Vizuelna strelica je indikator eksplicitnog pravila, ne dokaz temporalnog trenda. Za vremensku promenu mora postojati kompatibilna backend referenca prethodnog perioda. Pozitivni rast ne dobija automatski pozitivnu boju. Zvezdice su proizvoljna korisnička klasifikacija sa vidljivom legendom, nikad implicitna statistička značajnost ili medicinski rizik. Tone je semantički design token prilagođen light/dark temi; label i dostupno objašnjenje ostaju i bez boje. Missing/error se ne prekrivaju formatting stilom.

### 6.5 Ugovor evaluacionog odgovora

Evaluator radi jednom posle kanonskog query-a, zajednički za preview i saved query. Frontend ne ponavlja logiku pragova niti računa reference. Pored postojećih widget/series/current/comparison struktura server vraća sidecar `presentationAnnotations`.

```json
{
  "queryId": "22222222-2222-4222-8222-222222222222",
  "presentationAnnotations": {
    "evaluationVersion": 1,
    "entries": [
      {
        "target": {
          "widgetId": "11111111-1111-4111-8111-111111111111",
          "seriesId": "33333333-3333-4333-8333-333333333333",
          "phase": "current",
          "rowIndex": 0,
          "identityHash": "opaque-row-identity-hash"
        },
        "state": "matched",
        "ruleId": "review-high-load",
        "style": {"tone": "caution", "marker": "up", "label": "Iznad izabranog praga"},
        "explanationCode": "valueAboveThreshold",
        "evaluatedValue": 2180,
        "threshold": {"value": 2000, "unit": "AU"}
      }
    ]
  }
}
```

Target je query-local: queryId + widget/series/phase/rowIndex + kanonizovani identitet (metric/built-in, athlete, bucket, unit, grouping, prijavljeni source). To nije index vidljivo sortirane HTML tabele. Adapter koristi postojeći Display Model rowIndex i detached identity; ne menja sam model. Nepodudaranje queryId/identiteta, duplikat annotation target-a ili foreign ID odbacuje annotation i pokazuje bezbedan neutralan prikaz uz grešku dekoracije; raw rezultat ostaje vidljiv. Nema annotations-only cache-a odvojenog od odgovora kojem pripadaju.

Evaluation stanja su `matched`, `unmatched`, `ineligible`, `referenceUnavailable`, `referenceIncompatible`, `undefinedReferenceZero`, `error`. Greška pravila ne obara postojeću validnu brojčanu vrednost, ali uklanja ocenu i pokazuje da pravilo nije primenjeno. Neprosleđivanje annotation-a u response-u kad je evaluator capability=false nije uspešna primena pravila. Nova konfiguracija koja traži unsupported capability odbija se već u validaciji.

## 7. Preview, validacija i API predlog

### 7.1 Rute i capabilities

Base je postojeći `/api/training-load/dashboards/:dashboardId`. Nove rute su ispod `simple-editor` da se ne promene stare body šeme.

| Ruta | Namena i pristup |
| --- | --- |
| GET `/simple-editor/capabilities` | Read-only podržane ugovorne verzije, widget tipovi/bounds, policy/default metadata iz postojećeg kataloga, Pages/presentation/rule/reference/percent capabilities; nije drugi metric registry |
| POST `/simple-editor/validate` | Read-only validacija/kompajliranje drafta, issue code/path i reliable suggestion; ne vraća preview token i ne poziva query nepotrebno |
| POST `/simple-editor/preview` | Read-only validate + autorizovani query + annotations + previewToken |
| POST `/simple-editor/widgets` | Atomski create jedne serije/widgeta sa finalnim potvrđenim draftom |
| PUT `/simple-editor/widgets/:widgetId` | Atomski update Simple podobnog widgeta; nepotpuni implicitni replace nije dozvoljen |
| POST `/simple-editor/requests/status` | Read-only provera konkretnog client requestId bez query string izlaganja; samo inicijator i isti autorizovani kontekst |

POST preview/status ne znači upis. Preview nema dashboard/Page/selection/preference/metric writes. Postojeći `resolveActiveWorkspace` ume da upiše fallback preference, zato se za novi read-only put MORA koristiti side-effect-free rezolucija istim autorizacionim pravilima. Ako saved preference više nije validna, odgovor je `workspaceSelectionRequired`, bez silent prebacivanja ili upisa. Očitavanje auth sesije u `authMiddleware` je read-only u pregledanom kodu; ne uvoditi novi audit table write za preview. Operativni server log/metrics nisu upis poslovnih podataka i ne smeju sadržati kompletan osetljiv payload.

Preview izvodi metadata i fact čitanja kroz isti klijentski READ ONLY REPEATABLE READ kontekst. Postojeći query engine trenutno uvozi globalni db query; potreban je uski dependency injection query runner-a da sve njegove čitanje koriste isti klijent. To je planirana adapter promena, ne novi obračun. Ne koristiti SELECT FOR UPDATE u preview-u. Za saved query i dalje ostaje postojeća semantika; eventualno preuzimanje snapshot adaptera je zasebno proverena promena.

### 7.2 Request envelope

```json
{
  "contractVersion": 1,
  "context": {
    "kind": "legacyDashboard",
    "expectedDashboardRevision": 12,
    "runtimeFilter": {
      "athleteIds": [
        "44444444-4444-4444-8444-444444444444"
      ]
    },
    "period": {
      "dateFrom": "2026-10-22",
      "dateTo": "2026-10-28",
      "timeZone": "Europe/Belgrade"
    }
  },
  "draftRef": {
    "draftId": "11111111-1111-4111-8111-111111111111",
    "draftVersion": 3
  },
  "draft": {
    "contractVersion": 1,
    "draftId": "11111111-1111-4111-8111-111111111111",
    "draftVersion": 3,
    "title": "sRPE po danima",
    "metricRef": {
      "kind": "builtin",
      "key": "srpe"
    },
    "athleteSelection": {
      "mode": "inherit"
    },
    "advancedFilter": {
      "activity": {
        "mode": "inherit"
      },
      "component": {
        "mode": "inherit"
      }
    },
    "periodIntent": {
      "mode": "inherit"
    },
    "view": {
      "type": "line_chart",
      "groupBy": "day",
      "dataScopeLevel": "session",
      "analyticalAggregation": "sum"
    },
    "display": {
      "mode": "replace",
      "value": {
        "schemaVersion": 2,
        "numberFormat": {
          "maximumFractionDigits": 1
        }
      }
    },
    "presentation": {
      "mode": "replace",
      "value": {
        "schemaVersion": 1,
        "chartInteractions": {
          "tooltip": {
            "mode": "exact"
          },
          "legend": {
            "toggle": true
          },
          "zoom": {
            "mode": "local",
            "applyPeriodAction": true
          },
          "pointSelection": {
            "mode": "details"
          },
          "yAxis": {
            "mode": "auto"
          }
        }
      }
    }
  },
  "editTarget": null
}
```

Primer prikazuje stvarni shape objekta. `draft` je EditorDraft v1 objekat; draftRef MORA odgovarati njegovim ID/version. `expectedCatalogToken` je opciona envelope vrednost: izostavljena pri prvom izboru, a posle validacije/preview-a vraćeni fingerprint služi za otkrivanje promene metapodataka pre novog preview-a. Update šalje `editTarget:{widgetId,expectedWidgetRevision}`; novi draft ga ima null. Server proverava widget parent članstvo pre čitanja specifičnih detalja.

Persisted Pages kontekst je tagged union `kind=page`, sa pageId i expectedPageRevision, pored dashboard revision. Legacy nema pageId i prihvata se samo dok je dashboard logički jedna stranica. Nema izmišljenog virtual Page UUID-a koji bi neko kasnije pokušao da sačuva. Putanje su iste; context union uklanja potrebu da editor dva puta menja ugovor kada S4 uvede Pages. Na multi-page dashboardu legacy zahtev daje `pagesClientRequired`.

Validate vraća `status:valid|invalid|advancedRequired`, `issues:[{code,path,severity}]`, `suggestion:{type,confidence,reasonCode}`, server-normalized compiled query i capabilities. Sam validate nije dokaz da query daje scalar KPI. Primedbe na strane reference su generičke i ne otkrivaju tuđe ID-ove/nazive.

### 7.3 Preview response i token

Preview response obavezno sadrži contractVersion, queryId, draftId/draftVersion, draftHash, contextFingerprint, evaluatedAt, resolvedPeriod, effectiveFilterSummary, dashboardRevision i Page/widget revisions kada postoje, catalogToken, `normalizedWidget` u postojećem snake_case obliku, `widgetResult:{widgetId,series}` u postojećem batch obliku, presentationAnnotations, warnings i previewToken/expiresAt. Postojeći Display Model prima normalizedWidget i samo njegov widgetResult, ne ceo envelope.

Draft widget/series imaju deterministične privremene UUID-ove unutar drafta i status `resolved` samo ako ih je server validirao. Oni nisu DB redovi. Save response vraća mapping privremenih na stvarne ID-ove; nema čuvanja klijentskog lažnog `resolutionStatus`. Client acceptance: draftVersion, selected workspace/dashboard/Page, revisions i fingerprint moraju biti aktuelni; stariji odgovor se odbacuje i kada je HTTP 200.

Preview token je opaque, potpisan, bez server persistence-a, važi 10 minuta po server satu. Vezuje autentifikovanog korisnika, workspace, parent kontekst, očekivane revizije, compiled draftHash i catalogToken; ne predstavlja autorizacionu dozvolu i ne preskače revalidaciju. Ne vezuje metriku za latest podatke kao istorijski snapshot, ne sadrži tajne ili kompletne merne rezultate. Promena finalnog drafta, konfiguracije, metapodataka ili isteka zahteva novi preview. Predlog zahteva potvrđen aktuelni preview pre finalnog Simple save-a, i kad je rezultat validno prazan.

Normalni novi podaci između preview-a i save-a ne menjaju metric binding. UI označava vreme pregleda; posle save-a radi se običan fresh Page batch. Catalog/semantic ili kontekstualna promena se odbija kontrolisano, umesto da se tiho snimi druga konfiguracija. Cancel ne poziva create/delete, a preview token sam po sebi ništa ne čuva.

### 7.4 Atomski save i update

Save šalje isti envelope, previewToken i identifikaciju zahteva:

```json
{
  "requestId": "55555555-5555-4555-8555-555555555555",
  "requestIssuedAt": "2026-10-29T08:00:00Z",
  "previewToken": "opaque-signed-preview-token",
  "input": {
    "contractVersion": 1,
    "context": {
      "kind": "legacyDashboard",
      "expectedDashboardRevision": 12,
      "runtimeFilter": {
        "athleteIds": [
          "44444444-4444-4444-8444-444444444444"
        ]
      },
      "period": {
        "dateFrom": "2026-10-22",
        "dateTo": "2026-10-28",
        "timeZone": "Europe/Belgrade"
      }
    },
    "draftRef": {
      "draftId": "11111111-1111-4111-8111-111111111111",
      "draftVersion": 3
    },
    "draft": {
      "contractVersion": 1,
      "draftId": "11111111-1111-4111-8111-111111111111",
      "draftVersion": 3,
      "title": "sRPE po danima",
      "metricRef": {
        "kind": "builtin",
        "key": "srpe"
      },
      "athleteSelection": {
        "mode": "inherit"
      },
      "advancedFilter": {
        "activity": {
          "mode": "inherit"
        },
        "component": {
          "mode": "inherit"
        }
      },
      "periodIntent": {
        "mode": "inherit"
      },
      "view": {
        "type": "line_chart",
        "groupBy": "day",
        "dataScopeLevel": "session",
        "analyticalAggregation": "sum"
      },
      "display": {
        "mode": "replace",
        "value": {
          "schemaVersion": 2,
          "numberFormat": {
            "maximumFractionDigits": 1
          }
        }
      },
      "presentation": {
        "mode": "replace",
        "value": {
          "schemaVersion": 1,
          "chartInteractions": {
            "tooltip": {
              "mode": "exact"
            },
            "legend": {
              "toggle": true
            },
            "zoom": {
              "mode": "local",
              "applyPeriodAction": true
            },
            "pointSelection": {
              "mode": "details"
            },
            "yAxis": {
              "mode": "auto"
            }
          }
        }
      }
    },
    "editTarget": null
  }
}
```

Save `input` MORA biti isti envelope objekat koji je validiran preview-om; string ili skraćena verzija nisu prihvaćeni. Zahtev ne prihvata klijentski claims o ownership-u, manage pravu ili output izračunatim vrednostima. Datumi/UUID-ovi/token u primeru su ilustracije ugovora, ne važeći zahtev prema postojećem API-ju.

Server revalidira auth/visibility, workspace, parent, status i Simple eligibility; zatim u jednoj transakciji proverava request idempotency, lock-uje dashboard → Page ako postoji → widget → series i sve očekivane revizije. Privremeni request ledger lock je prvi i zasebne je hijerarhije; isti redosled važi za sve nove save/status adaptere. Metadata/catalog čitanja za binding štite se kompatibilnim lock-om kao postojeći writer, uz proveru da ne obrću postojeći lock redosled.

Nova sanctioned kompozitna funkcija pravi widget i tačno jednu seriju ili menja postojeći widget/seriju i presentation config. Koristi iste DB validatore, limits, visibility i archive guards; raw multitable write iz HTTP rute nije dozvoljen. Type promena koja bi ranije zahtevala više koraka izvršava se u istoj transakciji u trigger-kompatibilnom redosledu. Ako je potreban novi series ID, obavezno se vraća mapping i prevode rule target-i. Svaki problem rollback-uje ceo zahtev, uključujući staged Page defaults i idempotency success receipt. Nema stanja „widget dodat, metrika nije”.

Position/order za create određuje server iz slobodnog prostora aktivne Page, u postojećoj 12-column mreži i kataloškim granicama. Nema optimistic proizvoljnog overlap položaja. Save ne snima drag/layout draft druge operacije. Existing ID/config/filter/series polja koje Simple ne menja ostaju isti. Ako widget nije potpuno predstavljiv Simple modelom, vraća `advancedRequired`, bez destruktivnog svođenja. Advanced stari writer nastavlja sa svojim postojećim poštenim partial-save ugovorom; ovaj PR ga ne proglašava atomskim.

Save response vraća requestId, operation=`created|updated|unchanged`, widgetId/seriesId mapping, nove revisions i konkretan period/runtime update koji frontend primenjuje samo ako je originalni kontekst još aktivan. Uspeh koji stigne posle promene workspace-a ne vraća korisnika na stari Dashboard; invalidira se odgovarajući cache. Fresh result i annotations dolaze običnim query-em, ne iz starih preview brojeva.

Za odobreni novi KPI širine 6, predlog je proširiti samo catalog max_width na 6 u S2c; postojeći catalog default_width=3 i stari saved layout-i ostaju isti. Novi Simple create može eksplicitno postaviti 6 kada feature capability to potvrđuje. Novi frontend layout limit mora odgovarati katalogu. Pre prvog takvog upisa server uvodi legacy layout guard za dashboard koji sadrži KPI širi od 4: stari flat layout writer bez novog contract capability-ja dobija `editorClientRequired`, jer stari otvoreni tab clamp-uje KPI na 4 i može ga nenamerno suziti. Staro čitanje i bezbedni metadata-only upisi ostaju kompatibilni. Novi layout zahtev nosi `X-OptiMove-Dashboard-Contract: simple-editor-1`; server ga prepoznaje samo kao compatibility signal, nikada kao autorizaciju, i i dalje proverava pun layout/reviziju/prava. Stari tab bez tog signala dobija kontrolisanu poruku da osveži aplikaciju. Ovaj guard je odvojen od kasnijeg multi-page guard-a i oba se moraju testirati. Ako proširenje nije odobreno, implementacija ne menja UX samostalno nego ostaje na ovom otvorenom tehničkom gate-u.

### 7.5 Idempotency i nepoznat ishod

Predlog ledger-a: unique (initiatorUserId, requestId), uz vezani workspace/dashboard/Page/widget, operation, canonical payload hash, requestIssuedAt, status i minimalni receipt. Isti ključ ne može biti upotrebljen za drugi target čak ni kada isti korisnik upravlja oba. Ne skladištiti merne rezultate u ledger-u.

Canonical hash uključuje finalni sadržaj, target i očekivane revizije, unit-aware pravila i intent perioda; object keys deterministični, set-like athlete ID-ovi sortirani, pravila sortirana po eksplicitnom priority. Isključiti transport-only previewToken, trace ID i vreme ponovnog slanja. `requestIssuedAt` je isti za sve pokušaje; vrednosti i njihove tipove ne zaokruživati. Preview token se validira pre prvog izvršenja; autorizovani replay završenog identičnog zahteva vraća receipt i kad je token istekao ili originalna revision sada stale. Token za novi promenjeni payload zahteva novi requestId.

Prvi concurrent zahtev dobija ledger lock i commit-uje success receipt u istoj transakciji kao widget. Drugi identičan zahtev čeka u ograničenom roku, zatim vidi isti receipt ili `requestInProgress`; različit hash daje `idempotencyConflict`. Ne postoji commit poslovnog upisa bez receipt-a. Pre-commit pad rollback-uje oba; retry istog zahteva je dozvoljen. Posle commit-a izgubljen odgovor ima isti requestId/status put, bez drugog widgeta. Status koji ne vidi receipt može reći `notRecorded`, ali to nije dokaz da prvi zahtev sigurno neće commit-ovati; bezbedan sledeći korak je isti idempotentni zahtev.

Predlog retention-a je 7 dana, uz najmanje dodatnih 10 minuta zaštitnog retention-a za clock skew. Prvo izvršenje prihvata requestIssuedAt najviše 7 dana star i najviše 5 minuta u budućnosti; istovetan retry ga nikada ne osvežava. Po isteku originalnog request prozora nema automatskog resubmit-a pod novim ključem: `requestExpired` i read-only provera targeta pre nove korisničke akcije. Time uklanjanje starog ledger reda ne pretvara stari legitiman retry u novi create. Tačan cleanup job se posebno implementira/testira i ne proširuje ovaj S1 scope.

Svaki replay/status ponovo proverava trenutnu autentifikaciju, inicijatora, workspace i pristup targetu. Opozvana prava daju generički denial, ne receipt sa starim podacima. Idempotency ne zamenjuje revision concurrency: drugi requestId sa starom revizijom dobija staleRevision. Bez automatskog rebase-a preko tuđeg metric/layout/rule izbora.

### 7.6 Error ugovor

Novi endpointi koriste stabilni `error` code i opcione `issues` sa path/code, bez SQLSTATE poruke, constraint naziva, stack-a ili tuđih ID-ova. Stare rute zadržavaju postojeći ugovor; ne raditi globalni rewrite grešaka.

| Status | Kodovi / ponašanje |
| --- | --- |
| 400 | invalidRequest, invalidDraft, unsupportedContractVersion; tačan path za korisničku konfiguraciju |
| 401 | unauthenticated; bez preview vrednosti |
| 403 | forbidden kada je parent već dozvoljeno vidljiv, ali nema manage prava; ne otkriva skriveni parent |
| 404 | notFound za nepostojeći/tuđi parent/widget/metric/source; isti info-hiding oblik |
| 409 | staleRevision, catalogChanged, workspaceSelectionRequired, dashboardArchived, templateRequiresClone, pagesClientRequired, editorClientRequired, advancedRequired, previewRequired, idempotencyConflict, requestExpired |
| 413 / 422 | payloadTooLarge / previewTooLarge ili unsupportedCapability; kontrolisano, bez partial podataka |
| 429 / 503 / 504 | bounded throttling / requestInProgress ili serviceUnavailable / previewTimeout; Retry-After kada postoji pouzdan rok |

Per-series query error unutar 200 odgovora ostaje error u Display Model-u i blokira finalni „preview potvrđen” status; ne tumači se kao empty. Konfiguraciono validan missing ili source conflict ostaje eksplicitni rezultat, bez skrivanja problema. Network/timeout pri save-u uvek može biti outcomeUnknown; proverava se isti requestId, ne nasumično ponavlja create.

## 8. Kompatibilnost i Pages zavisnosti

### 8.1 Matrica čitanja i uređivanja

| Postojeći slučaj | Obavezno ponašanje |
| --- | --- |
| Null/absent/V1 | Isti sadašnji normalizer defaults; bez pisanja pri otvaranju. Title/filter izmena preserve-uje originalni display blob |
| V1 sa extra fields | Extra polja ne dobijaju novo značenje; nema automatskog čišćenja. Replace display-a zahteva eksplicitnu konverziju i prikaz promene |
| Validan V2 | Isti precision/legend/valueLabels; sidecar se obrađuje odvojeno |
| Invalid V2 / unknown display version | Postojeće invalid/unsupported stanje; Simple ne popravlja ili downgrade-uje; otvaranje u Advanced ili read-only pomoć |
| Jedna serija sa naprednim policies | Preserve može zadržati tačno ista polja samo ako compiler dokazuje round-trip; inače AdvancedRequired |
| Više serija / unresolved / ambiguous | Advanced; nema uklanjanja viška, automatskog resolve-a ili prvog kandidata |
| Sidecar null | Osnovni stari prikaz; bez novih formatting/zoom defaults pri čitanju |
| Unknown sidecar version | Vrednosti ostaju, jasna unsupported decoration oznaka; bez sidecar rewrite-a |
| Template / archived | Struktura po postojećim pravima; bez preview query-a za workspace-less template i bez mutation/query-a arhiviranog dashboarda |
| Athlete workspace | Obavezno suženje na konkretnog athlete-a; override ne širi opseg |

Postojeći layout, active_dashboard pointer, revisions, owner i data workspace ostaju isti. Query rezultat sa novim annotations je aditivan; stari Display Model mora nastaviti da prihvata iste redove. New saved presentation config mora biti kopiran u template clone, page duplicate i dashboard clone putanjama, sa prevodom series reference-a; eksplicitne SQL liste kolona ne smeju ga tiho izgubiti. Stari Advanced PATCH koji ne navodi sidecar ga čuva. Promena tipa Table→Chart sa table pravilima zahteva rešavanje ili očuvanje uz jasnu neprimenljivost; ne brisati automatski.

### 8.2 Šta ne čeka Pages, a šta čeka

S2 može realizovati validator, compiler, chart presentation ugovor, preview i atomic Simple save na legacy single-page adapteru. Ne mora da čeka novu Page tabelu da bi ugovor bio proverljiv. Taj adapter nema trajne page defaults/period i nema multi-page upis.

Persisted Page kontekst, pageRevision, shared default filteri, page-local layout i clone/delete/reorder implementiraju se u Pages fazi. S1 prihvata njihov tačan minimalni port: resolveContext → authorize → read defaults/period → revision fingerprint → compile widget → query → annotations. Period mutation pogađa samo aktivnu Page; ne postoji dashboard-wide runtime period koji prećutno menja sve stranice.

Legacy guard za multi-page dashboard MORA stići pre prvog multi-page upisa: stari flat detail/query/layout/widget writer bez Page konteksta kontrolisano odbija operaciju. Nova Page članstva, UNIQUE order/mobile constraints i overlap trigger scope moraju biti usklađeni; jedna nova tabela nije dovoljno. Očuvati dashboard → Page → widget → series lock redosled i pod istim dashboard lock-om proveravati Page članstvo/revizije.

S4 backfill će samo pridružiti postojeće widgete početnoj Page uz iste ID-ove/config/filter/layout bindinge. Nove kolone/null sidecar defaults ne menjaju metričke podatke. S1 ne rezerviše migracioni broj i ne proizvodi izvršiv SQL. V42 je Claude zona ugovor; novi broj/filename rezerviše se koordinisano tek u odobrenoj implementaciji.

### 8.3 Metrics Core paralelni tok

Metrics Core ostaje jedini registry; Dashboard ne uvodi formule, unit conversions, zone definicije, importer izuzetke ili novu source precedence politiku. Source conflict/historical semantic version pravila ostaju postojeća. Novi procentualni rule evaluator nije derived canonical variable i ne koristi se da zameni buduću Claude derived-metrics fazu.

Od Claude toka potrebni su stabilni katalog metadata/capability ugovori i eventualno imenovan reference resolver. U nedostatku resolver-a podržani su static threshold/constant reference modeli, a backendReference i percent su eksplicitno capability-gated. Pages, osnovni Simple Editor i interaktivni chartovi ne čekaju zone/import/derived pipeline.

Shared hot spots su DashboardQuery (query runner injection), shared app/state/styles, migrations namespace i budući icon library renderer. Dashboard PR menja samo bounded query adapter delove uz review diff-a; ne preuzima Claude source-mapping/zone/import rad. Dokumentaciona standing merge autorizacija Claude plana se ne prenosi na S tok.

## 9. Test matrica i acceptance

Ovo su planirani testovi. **Nijedan naveden test nije izvršen u S1.** Postojeće suite nazive koristiti kao regression oslonac, ali dodati nezavisne fixture slučajeve koji dokazuju poslovne ugovore, ne samo kopiraju implementation.

| ID | Scenario / nivo | Očekivani dokaz |
| --- | --- | --- |
| M01 | Catalog search/pagination/labels/unit/category | Postojeći vidljivi katalog, svi cursor-i, bez duplog registry-a ili silent truncation-a |
| M02 | Foreign/inactive metric, stale catalogToken | Info-hiding denial / catalogChanged; nema query-a ni upisa preko starog izbora |
| M03 | Workspace switch i kasni odgovor | Stari picker/preview nikad ne prepišu novi kontekst |
| M04 | Built-in pet tipova | Stvarni fixed scope/default/source policy; RPE null unit ostaje null |
| M05 | Nepouzdan scope/agregacija | RequiresChoice/AdvancedRequired, bez izmišljenog sum-a |
| F01 | Inherit, selected, allAuthorized, [] legacy | Tačna razlika absent/null/[]; prazni picker ne proširuje skup |
| F02 | Page izbor promenjen, widget fiksiran | Widget ostaje fiksiran sa badge-om; reset uklanja ključ |
| F03 | Athlete workspace i drugi UUID u override-u | Rezultat ne izlazi iz autorizovanog athlete opsega |
| F04 | Activity/component mismatch i clear | Vidljiva korekcija; nema tihog reparent-a ili pogrešne komponente |
| F05 | DST, this_week, last_7_days, različiti browser satovi | Server zona i uključivi datumi; Monday week ≠ rolling 7d |
| F06 | Cancel staged period/defaults | Nijedan postojeći filter/default ne promenjen |
| V01 | KPI jedan scalar / više grupa / array | Scalar prikaz; multi-group ne bira prvi; array usmerava na Table |
| V02 | Numeric/text/boolean/array view suggestion | Reliable samo gde dokazivo; bez coercion-a u chart |
| V03 | Missing/conflict/query error | Različita stanja; problem nije nula; query error nije validan empty preview |
| V04 | Obavezna tri koraka desktop/mobile | Ista odluka i povratak, bez dodatnog obaveznog tehničkog koraka |
| P01 | Isti fixture preview i saved query | Isti redovi, vrednosti, statusi i identiteti uz isti snapshot; razlike samo u prevedenim ID-ovima |
| P02 | Preview read-only uključujući fallback workspace | Nula poslovnih/preference/selection/idempotency upisa; READ ONLY tx; bez probnih widgeta |
| P03 | Metadata/facts čitanje na različitim konekcijama | Test odbija regresiju: isti klijent/snapshot kroz query injection |
| P04 | Brz draft edit / 200 stariji odgovor | Samo najnoviji draftVersion/context ulazi u prikaz; late load ne montira stari chart |
| P05 | Empty/conflict preview potvrda | Može sačuvati samo uz vidljivo upozorenje; invalid/timeout blokira |
| P06 | Preview token expiry/tampering/context reuse | Odbijen; drugi korisnik/workspace/izmenjen draft nije replay dozvola |
| P07 | 64 KiB/2 MiB/400 dana granice | Kontrolisana greška, bez nepotpunog uspešnog preview-a |
| C01 | Tooltip decimal precision, zero/negative | Pun transport broj, ispravna jedinica/identitet; chart label precision ne skraćuje exact tooltip |
| C02 | Dva identična naziva iz različitih izvora | Odvojene particije i lokalni legend state; bez name-key kolizije |
| C03 | Legend hide/show/all hidden | Nema query-a, revision promene ili nestanka osnovne tabele; jasan reset |
| C04 | Day/week zoom | Lokalna promena prozora, bez agregacije; explicit apply šalje jedan Page batch |
| C05 | Kategorički bucket UUID + zoom | Ne nudi vremenski apply; nema tumačenja UUID-a kao datuma |
| C06 | Zoom week partial bounds | Ispravni Monday-based bucket-i i server period validacija |
| C07 | Klik sortirane tačke/bar-a | Tačan originalni row locator; ne prvi raw row ili druga source particija |
| C08 | Duplicate/missing bucket i gap | Bez tačke/redukcije; svi problem redovi u tabeli; connectNulls false |
| C09 | Y fixed, min≥max, negative, van bounds | Invalid bounds odbijeni; out-of-range upozorenje, originalne vrednosti očuvane |
| C10 | Resize, 20 Page switch-eva, import failure | Broj instanci/observera/handlera ne raste; fallback ostaje čitljiv |
| C11 | Touch pinch/scroll/tap, tastatura | Scroll nije zarobljen; detalji dostupni bez hover-a; ista funkcionalnost |
| T01 | gt/gte/lt/lte granice | -1,0,1 i tačna threshold vrednost daju očekivane match-eve |
| T02 | Between/outside, sva 4 inclusivity para | Tačne granice/komplement; prazan interval konfiguraciona greška |
| T03 | Raw decimal naspram prikaza | 1999,96 prikazano 2000 ne prolazi gt 2000 |
| T04 | Jedinica/semantika mismatch | Nema konverzije, style-a ili numeričke ocene; jasan razlog |
| T05 | Null/false/empty string/array/NaN/error/conflict | Nijedan nije nula; postojeća vrednost/status ostaju lossless |
| T06 | Overlapping pravila / priorities | First-match determinističan; dupli priority odbijen; warning objašnjava prioritet |
| T07 | Ref missing/multiple/foreign/source mismatch | Generic denial ili notApplicable, nikad automatski timski prosek |
| T08 | Percent 1250/1000, 0/1000, -80/-100, ref 0 | 25%, −100%, +20% ako domen dozvoljen; undefinedReferenceZero za nultu referencu |
| T09 | Overflow/non-finite/ref sem version | Evaluator error bez stilizovane ocene; osnovni rezultat ostaje |
| T10 | Fake HTML/style/callback/URL | Striktan schema reject i escaping; nema korisničkog koda u ECharts |
| T11 | Query/row annotation mismatch/duplikat | Bezbedan neutralan prikaz i decoration error; ne boji pogrešan red |
| T12 | Sorting/filter prikaza tabele | Annotation prati originalni rowIndex/identity, ne vizuelni index |
| T13 | Arrow/star bez boje i čitač ekrana | Vidljiv smislen label, jedinica/prag/referenca dostupni; nema implicitne značajnosti |
| S01 | Widget+series create, svaki failure injection | Potpun rollback; nema praznog widgeta ili success receipt-a |
| S02 | Type/metric update sa unit/cap/pravilo konfliktom | Ili cela validna izmena ili nula; očuvani originali |
| S03 | Isti request dvaput/concurrent/lost response | Jedan widget i jedan receipt; identičan replay bez stale false-negative |
| S04 | Isti requestId, drugi payload/target | IdempotencyConflict; bez drugog upisa |
| S05 | Različit requestId, stale revision | StaleRevision; bez lost update-a ili auto-rebase-a |
| S06 | Server crash pre/posle commit-a | Pre: rollback oba. Posle: receipt proverljiv, bez duplikata |
| S07 | Ledger TTL/clock skew i stari retry | Original issuedAt se ne osvežava; istekao pokušaj ne postaje novi create |
| S08 | Revoked rights pre replay/status | Nema receipt disclosure-a, čak i ako prethodni write jeste uspeo |
| S09 | Shared Page default + widget save failure | Rollback oba; runtime UI se ne primenjuje pre potvrđenog uspeha |
| B01 | V1/extra fields/null/V2 round-trip | Otvaranje nema write; preserve čuva originalne blobove i nepoznata polja |
| B02 | Unsupported/invalid display/sidecar | Eksplicitno stanje; nema downgrade-a ili vraćanja default-a kao validnog save-a |
| B03 | Multi-series Advanced i source policies | Nema uklanjanja bindinga/policy-a; Simple odbija nepredstavljiv slučaj |
| B05 | Single-page KPI width=6 i stari layout tab | Staro čitanje radi; stari writer se odbija pre clamp/rewrite-a; novi writer poštuje 6, stari saved 3/4 ostaju isti |
| B04 | Template clone/Page duplicate | Sidecar i pravila očuvani, ID mapping tačan, unresolved nije prvi kandidat |
| G01 | Single-page legacy / multi-page guard | Isti stari rezultat na legacy; flat multi-page writer kontrolisano odbijen |
| G02 | Foreign Page/widget, dve sesije menadžera | Članstvo i owner/data-workspace provere nezavisne; info-hiding |
| G03 | Page A query kasni posle Page B | A ne menja B, njene annotations, filtere ili legend state |
| U01 | 360/375/390px, 768px, 1440px, 200% zoom | Bez document overflow-a; input≥16px i dodir≥44px; osnovne opcije ostaju razumljive |
| U02 | Tastatura/reader/reduced-motion/chart failure | Fokus i objašnjenja dostupni; boja i hover nisu jedini signal |

Obavezni regression oslonci: `training-load-analysis-display-model.test.mjs`, display-view, echarts, analysis.actions, dashboards.actions/editor/H4/UX; backend `training-load-dashboard.test.mjs` i relevantne visibility/scope capability suite. Novi read-only i atomic save testovi moraju imati realne disposable DB/API dokaze pre readiness-a, ne samo mocked HTTP. To zahteva buduće posebno odobreno okruženje i izvršenje migracija; S1 ih ne pokreće.

Za vizuelne izmene izvršiti stvarni browser QA i Vite production build sa vendor notices. Full-suite baseline dug evidentirati po tadašnjem main-u i stvarnim potpisima; ne prenositi istorijske S0 brojeve kao novi rezultat i ne uklanjati testove radi zelenog statusa. Contract fixtures proveravaju originalne vrednosti/identitete/status, ne samo snapshot CSS-a.

## 10. Rizici i odluke koje slede iz ugovora

| Prioritet | Rizik / posledica | Predložena kontrola |
| --- | --- | --- |
| Visok | Novi ključevi u display_config V2 postaju invalid | Sidecar v1 i strogi novi validator; postojeći normalizer netaknut |
| Visok | Preview put preko workspace resolver-a potajno upisuje preference | Side-effect-free resolver i READ ONLY client; negativni DB test P02 |
| Visok | Reuse query-a van istog snapshot-a ili promena backend matematike | Bounded query-runner injection, identični fixture rezultati i Claude diff review |
| Visok | Retry pravi dupli widget ili lost update | Atomic receipt + payload hash + revision guards; bounded status/replay |
| Visok | Reference/percent daju lažnu ocenu | Explicit resolver/formula capability i testovi; bez fallback proseka/nule |
| Visok | Stari flat client menja drugu Page | Server legacy guard pre multi-page capability |
| Srednji | Široke KPI kartice iz UX-a nisu dozvoljene sadašnjim katalogom | Predlog max_width=6 u S2c, stari default=3 i saved koordinate nepromenjeni; legacy layout guard pre prvog width=6 upisa |
| Srednji | Tooltip ili click pogrešno pripišu vrednost drugom izvoru | Plot/row identity mapping; ne koristiti nazive ili sortirani HTML index kao ID |
| Srednji | Pravilo na jednoj jedinici preneto na drugu metriku | Revalidate/remap uz novi preview; nikakav silent threshold conversion |
| Srednji | Legend/zoom nestaje na svakom app repaint-u | Lokalni InteractionState po context fingerprint-u, dispose bez leak-a |
| Srednji | Previše kontrola vrati tehnički builder | Tri koraka, defaults kada pouzdani, Advanced za rules/axis; bez novih obaveznih polja |
| Srednji | Claude v42/zone rad konfliktuje sa Dashboard migracijom | Bez rezervacije v42, odvojene grane i unapred dogovoren migration slot |

Predlog `referencePercent` formule, sidecar storage, idempotency retention i KPI max_width=6 su konkretne tehničke odluke za odobrenje zajedno sa S1. BackendReference ostaje zaključan dok resolver ne postoji. Ovo su dopune tehničkog ugovora, bez izmene odobrenog trokoraka, tabova ili vizuelne hijerarhije. Ako neka od njih nije prihvaćena, menja se taj deo ugovora pre implementacije; nema potrebe ponavljati celo UX projektovanje.

## 11. Predlog PR-ova i redosleda rada

Ovaj plan razlaže S2–S6 u pregledive PR-ove jer je S1 sada, po eksplicitnom zahtevu, isključivo contract/model dokument. S1 ne sadrži produkcioni model modul, čak ni pod oznakom „čista funkcija”. Ako se kasnije želi docs PR za ovaj ugovor, to je odvojena odobrena repo izmena; trenutno je isporučen izveštaj.

| PR / redosled | Konkretna isporuka | Zavisnosti i gate |
| --- | --- | --- |
| S2a — shared contract/model | Draft/presentation/validation modeli, capability adapter i test fixture-i; striktni V2 novi write validator uz preserve podršku | Odobren S1. Bez UI redesign-a; code review |
| S2b — read-only preview | Novi validate/preview/capabilities adapter, read-only workspace path, query client injection, snapshot/identity response i preview token | S2a; security/query review. Stvarna read-only DB/API provera na odobrenoj disposable bazi |
| S2c — atomic Simple save | Sanctioned composite create/update, nullable presentation storage, idempotency ledger/receipt i novi endpointi; odobren KPI max_width=6 i legacy layout guard pre aktivacije; podrška single-page legacy | S2a/b; novi dogovoreni migration slot, DB/security/concurrency spoljni review. Izvršenje migracije zasebno odobrenje |
| S3a — Simple Editor UI | Tri koraka, postojeći catalogue pickeri, page inheritance, live preview, save/retry/outcomeUnknown i Advanced bridge | S2a–c; mobile/UX/code review; browser/build, bez novih default metrika |
| S3b — ECharts interactions | Lossless tooltip, legend state, local zoom/apply period, row detail, axis advanced i lifecycle cleanup | S2a i S3a context port; bez query matematike. C01–C11 i stvarni desktop/touch/browser QA |
| S3c — table rule evaluator/presentation | Static thresholds, intervali, constant reference i lossless annotations; pravila u Advanced; razumljiv badge/legend | S2a–c; evaluator backend + frontend display adapter, T01–T13. Percent/reference backend capability ostaje false dok njegov poseban gate nije zatvoren |
| S3d — opcioni reference/percent capability | Imenovan backend resolver ako postoji, formula signed-relative-abs-v1 i validacija domenskog konteksta | S3c i zasebno prihvaćena formula/resolver zavisnost; Metrics Core vlasnik ugovora, spoljni review; nije blocker za osnovni editor |
| S4 — Pages backend/compatibility | Page tabela/backfill, parent FK, page-scoped constraints/overlap/functions, API i multi-page legacy guard; očuvanje prethodno uvedenog KPI bounds/guard ugovora | Posebno odobren Pages ugovor i migracioni slot; server guard pre multi-page upisa; DB/security/concurrency review |
| S5 — Pages UX/templates | Četiri odobrena Page primera, CRUD/reorder/duplicate, lazy query/render, page filters/runtime i saved defaults | S4; S3 editor context ostaje isti. Match metrics samo kada stvarno dostupne; bez novog importera |
| S6 — integration/release packet | Full compatibility matrix, usability, performance, accessibility, actual-main drift review i rollout/rollback plan | S2–S5; rezultati i baseline transparentni; kraj na kandidatu za review, bez automatskog merge/deploy-a |

Redosled S3b i S3c može biti paralelan po razdvojenim fajlovima kada S2 ugovor i write/query port budu stabilni; ovaj dokument ne pokreće paralelne agente. S4 ne zahteva da percent/reference funkcija bude gotova. S5 osnovni reporti mogu koristiti built-in podatke i postojeće kanonske metrike bez čekanja na Claude future zone/derived tok.

Svaki budući PR nosi originalni cilj, acceptance, tačan base/head, diff, stvarne test rezultate i poznati baseline. Auth/ownership, sanctioned SQL/migration, concurrency i nova identity materializacija imaju spoljni review gate prema repo protokolu. Ovaj contract izveštaj ne predstavlja takvu closing reviziju ili merge-readiness dokaz.

## 12. Završetak S1 i sledeća odluka

S1 priprema svih šest traženih isporuka: funkcionalnu specifikaciju, konfiguracioni/API model, validaciju i kompatibilnost, test matricu, rizike/Pages zavisnosti i redosled PR-ova. Odobreni UX je očuvan. Ograničenja sadašnjeg runtime-a su eksplicitno označena, naročito V2 extension granica, read-only workspace rezolucija, nepostojanje reference resolver ugovora i KPI širina.

**S1 status: ugovor spreman za tvoj pregled. Naredna implementaciona faza nije započeta.** Predlog sledećeg koraka, nakon odobrenja, jeste S2a. Odobrenje tog rada ne predstavlja odobrenje izvršenja migracija, merge-a, deploy-a ili produkcionih upisa.

## 13. Izvori i simboli za proveru

- [Aktuelni pinovani main](https://github.com/predragbozic/OptiMove/tree/82fbb3ca14754442dc3a7f78a92a7e6a090393a2) i [source delta prema S0 osnovi](https://github.com/predragbozic/OptiMove/compare/165998802ab6655260559da4af483c7e4e554d6d...82fbb3ca14754442dc3a7f78a92a7e6a090393a2).
- [Display normalizer](https://github.com/predragbozic/OptiMove/blob/82fbb3ca14754442dc3a7f78a92a7e6a090393a2/frontend/training-load-analysis-display-config.js), [Display Model](https://github.com/predragbozic/OptiMove/blob/82fbb3ca14754442dc3a7f78a92a7e6a090393a2/frontend/training-load-analysis-display-model.js): normalizeRow, chartGroups, buildDashboardWidgetDisplayModel.
- [ECharts options](https://github.com/predragbozic/OptiMove/blob/82fbb3ca14754442dc3a7f78a92a7e6a090393a2/frontend/training-load-analysis-echarts-options.js) i [mount/lifecycle](https://github.com/predragbozic/OptiMove/blob/82fbb3ca14754442dc3a7f78a92a7e6a090393a2/frontend/training-load-analysis-echarts.js): dashboardChartPlots, mount, release, disconnectedCallback.
- [Dashboard route](https://github.com/predragbozic/OptiMove/blob/82fbb3ca14754442dc3a7f78a92a7e6a090393a2/backend/src/routes/trainingLoadDashboard.js), [query engine](https://github.com/predragbozic/OptiMove/blob/82fbb3ca14754442dc3a7f78a92a7e6a090393a2/backend/src/trainingLoadDashboardQuery.js), Access/Catalog/Widgets moduli u istom backend/src direktorijumu.
- [Workspace resolver](https://github.com/predragbozic/OptiMove/blob/82fbb3ca14754442dc3a7f78a92a7e6a090393a2/backend/src/workspace.js), auth.js, trainingLoadMetricsCatalog.js/listDefinitions i routes/trainingLoadMetrics.js za postojeće read/authorization/capability granice.
- [v18 seed/bounds/defaults](https://github.com/predragbozic/OptiMove/blob/82fbb3ca14754442dc3a7f78a92a7e6a090393a2/migrations_v2/202609101200_training_load_v18_dashboard_catalog_seed.sql); v15–v17 i v19 za postojeće tables/constraints/sanctioned writes.
- [Metrics Core plan](https://github.com/predragbozic/OptiMove/blob/82fbb3ca14754442dc3a7f78a92a7e6a090393a2/docs/ai/metrics-core-plan.md), [Phase 5 zone contract](https://github.com/predragbozic/OptiMove/blob/82fbb3ca14754442dc3a7f78a92a7e6a090393a2/docs/ai/phase5-zone-model-contract.md), ADR-002/003/007 i docs/frontend/dashboard-display-model.md.
- Postojeći frontend display-model/display-view/echarts testovi pročitani su kao izvor slučajeva; nisu pokrenuti. S0 i odobreni prototip su dizajn reference, ne dokaz već implementiranog preview/API/Pages ugovora.
