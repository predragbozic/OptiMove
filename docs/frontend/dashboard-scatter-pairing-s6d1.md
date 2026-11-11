# S6d.1 — serverski ugovor X/Y parova

Osnova: Draft PR #393, `c309933e302f7d42209ce5a4accf19f18b3490dd`. Ovaj korak implementira serversku osnovu za Scatter, a ne novi grafički prikaz. Galerija i dalje ima osam izbora. Nema novih migracija, widget tipova, sačuvanih prezentacija, UI, env podešavanja ili aktivacije.

## Zahtev i autorizacija

Postojeći POST Page query opcionalno prihvata:

```json
{
  "pairing": {
    "schemaVersion": 1,
    "widgetId": "UUID postojećeg widgeta",
    "xSeriesId": "UUID njegove prve izabrane serije",
    "ySeriesId": "UUID njegove druge izabrane serije"
  }
}
```

Ostala polja (`period`, `runtimeFilter`, `widgetIds`) zadržavaju postojeći ugovor. ID-jevi su različiti, case-insensitive UUID. Ako je naveden widgetIds, ciljni widget mora biti u njemu. Nepoznati ključevi, null, coercion, proizvoljne vrednosti X/Y ili funkcije nisu dozvoljeni. Zahtev ne može da dostavi same podatke ili tuđe definicije serija.

Page autorizacija i učlanjenost widgeta/obe serije proveravaju se pre pozivanja query engine-a. Pogrešna učlanjenost daje generički 404. Uparivanje koristi samo isti već autorizovani batch u postojećoj read-only transakciji. Filteri/period su isti za obe serije; nema dodatnog SQL-a ili upisa zbog uparivanja. Page capabilities navodi `metricPairing:'athlete-bucket-v1'` samo uz pravo query-ja; to nije capability za Scatter galerijsku karticu.

## Pojam para

Par predstavlja dve serverski vraćene vrednosti za istog pojedinačnog sportistu i isti day/week bucket. To je poređenje već vraćenih agregata po bucket-u, ne tvrdnja da dve vrednosti dolaze iz iste aktivnosti ili mernog pokušaja. Različiti podaci/izvori i agregacije ostaju eksplicitno zapisani u X/Y bindings.

Podržani su line_chart/bar_chart, dve izabrane razrešene serije bez poređenja perioda, finite numeričke vrednosti i jedna dosledna stvarna jedinica po osi. Ose mogu imati različite jedinice. Null athlete/Whole group, nenumerički ili nevažeći rezultat, bucket van perioda, nepoznato razrešenje i promena jedinice odbijaju uparivanje. Nedeljni bucket je ponedeljak koji može prethoditi početku odsečenog perioda.

Ključ je `(athleteId, bucketKey)`. Redovi se ne spajaju po indeksu ili redosledu. Missing partner/value, konflikt/unit/type/semantic problem, error i duplikati daju eksplicitne omissions sa razlozima i originalnim row indeksima. Kod više izvora u istoj ćeliji nema biranja prvog reda. Dani bez bilo kog podatka nisu veštački dodati kao parovi. Nema interpolacije, normalizacije, sabiranja, konverzije jedinica, reference, regresione linije ili korelacionog obračuna.

Granice: 20 sportista, 8.000 potencijalnih parova, 16.000 originalnih redova po osi. Prekoračenje vraća requiresChoice bez skraćivanja. Ceo odgovor, uključujući parove i omissions, ostaje pod postojećim Page response-byte limitom.

## Odgovor

Samo izričit pairing zahtev dodaje `metricPairs`. Postojeći pozivi imaju isti oblik odgovora. `metricPairs` deli isti `queryId` i `resolvedPeriod` kao Page odgovor, uz sačuvane widget/X/Y ID-jeve, server bindings (metric/builtin, scope/aggregation/source/coverage policy i unit), `pairs`, `omissions` i `limits`.

Svaka strana para sadrži `seriesId`, `rowIndex`, originalni `value`, `unit` i configured/reported source podatke. Puni originalni serijski rezultati ostaju u istom odgovoru. Izlaz ne mutira njih niti sačuvani widget.

Status je `ready` za sve pouzdane parove, `partial` kada postoje i parovi i omissions, `empty` kada nema pouzdanih parova, `unavailable` za nepodržan oblik/podatke, ili `requiresChoice` za prekoračene granice. Budući renderer mora da potvrdi isti queryId/widget/series/period i podržanu verziju; ne sme sam da rekonstruiše nedostajuće parove.

## Provera i nastavak

Završni ciljani backend skup: **56/56 PASS**. Obuhvata strogi Page query ugovor/autorizaciju/byte granicu, postojeće Page portove i čisto uparivanje. Revizija je našla P2 u klasifikaciji konfliktnih redova sa `value:null`: sada se konflikt/error označava kao problem pre provere običnog missing-a. Regresija proverava obe ose, sve konfliktne zastavice i error; običan null ostaje missing. Nije pokretan frontend build jer frontend nije menjan; raniji širi baseline problemi ostaju otvoreni.

Izolovana PostgreSQL/HTTP proba koristi stvaran metric rezultat 42 s i built-in session count 1 za istog sportistu/datum. Proverava njihove row locatore, isti queryId, ponovljeni read bez promene revizija, stari oblik odgovora bez zahteva, generički 404 za drugu widget seriju i 400 za dostavljene vrednosti/iste ose. Test baza/server/cluster uklonjeni, port zatvoren. Privatni fixture/helperi nisu deo PR-a.

Frontend nije menjan u ovom koraku. Sledeće je Scatter renderer/editor/sačuvana prezentacija koji troše ovaj potvrđeni ugovor, sa zasebnom vizuelnom i DB proverom. Stacked/Box zahtevaju preostale ugovore; pragovi/reference slede po dogovorenom redosledu. Širi release problemi iz prethodnih izveštaja i dalje su otvoreni. Nema merge-a ili deploy-a.
