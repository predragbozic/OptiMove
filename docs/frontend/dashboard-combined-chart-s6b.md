# S6b — kombinovani Bar + line grafikon

Osnova: Draft PR #391, `c16dcefd0d8703f8e28e66ef2baad969f8527e6e`. Ovaj korak dodaje sedmi galerijski izbor; nije odobrenje za merge/deploy. Interfejs je na engleskom, postojeća svetla tema ostaje zajednička sa aplikacijom.

## Ponašanje

- Na sačuvanom linijskom ili stubičastom grafikonu sa grupisanjem po danu/nedelji, izbor **Bar + line** otvara Advanced nacrt. Postojeća potvrda odbacivanja Simple izmena i zaštite konteksta ostaju aktivne. Sam izbor ne upisuje podatke.
- Advanced koristi tačno dve razrešene numeričke serije: primary = stubci/leva osa; secondary = linija/desna osa. Druga metrika može da se promeni u postojećem biraču. Svaka zadržava svoju jedinicu, izvor, agregaciju i pravila pokrivenosti.
- Ako se prelazi sa jedne serije, nacrt dodaje RPE kao početni izbor druge metrike; trener može da ga zameni pre Save. Za nov widget prvo se napravi osnovni grafikon, pa doda druga metrika kroz Advanced. Simple ostaje editor jedne serije i ne prikazuje lažno funkcionalan dvometrijski Save.
- Prikaz koristi poseban grafikon po sportisti, do 20 sportista. Whole group redovi ostaju odvojeni. Nedostajuće ili duplirane tačke su praznine; svi originalni redovi ostaju u tabeli. Nema sabiranja, konverzije jedinica niti normalizacije u pregledaču.
- Obe numeričke ose su automatske. Poređenje perioda, jedan zajednički fiksni opseg i druga grupisanja nisu deo ovog koraka. Promena stvarne jedinice unutar jedne serije ili nevažeća kanta odbija kombinovani prikaz uz tabelu podataka.
- Tooltip, uključivanje/isključivanje serija, lokalni zoom, Reset view i tačni detalji tačke rade za obe metrike. Izbor tačke navodi metriku i jedinicu. Primena perioda zadržava postojeću eksplicitnu potvrdu.

## Ugovor i čuvanje

Ne uvodi se novi DB widget tip. Čuva se `line_chart` sa `schemaVersion:1`, `chartVariant:'combined'`, `chartComposition:'metrics-v1'` i `chartInteractions`. Kompozicija metrics-v1 i combined varijanta su obavezan par; fiksne ose nisu dozvoljene. Simple compiler vraća `advancedRequired`.

Razvojna migracija v61 menja postojeći SQL validator i proveru kompatibilnosti sa istim OID-om i dodaje marker `dashboard_combined_chart_v1()`. Ne prepisuje widget redove. Page UI i Simple capabilities dozvoljavaju konverziju tek kada postoje marker i Page portovi; Page upravljanje zahteva odgovarajuća prava. Nepoznate buduće verzije ostaju opaque; naslov može da se promeni uz očuvanje nepoznate konfiguracije.

Advanced čuvanje i dalje koristi postojeći niz revision-checked, idempotentnih operacija, a ne novu atomsku transakciju za ceo editor. Presentation PATCH ide poslednji, posle pripreme serija. Prekid može ostaviti delimično primenjene serije; postojeći status/recovery/rebase tok mora da se završi. Renderer odbija nepotpun kombinovani raspored i čuva tabelarni prikaz. SQL namerno ne zahteva dve serije posle svakog pojedinačnog add/delete koraka tog postojećeg toka.

Prelazak iz combined u Separate plots je eksplicitno uklanjanje poznate prezentacije u Advanced. Simple ne prepisuje kombinovani sidecar u nepotpunom sačuvanom stanju. Budući opaque sidecar se ne pretvara automatski.

## Provere — 5. novembar 2026.

- Ciljani frontend skup: **391/391 PASS**; backend skup: **195/195 PASS**; Vite build PASS. Pokriveni su galerija, editor, rebase/partial recovery, stvarne tačke obe ose, provenance, duplikati, praznine, granice i capability/autorizacione kapije.
- Izolovani PostgreSQL/HTTP: **1/1 PASS, šest scenarija**: pre-v61 kapije, marker/OID i legacy granica, Simple Advanced-required, dve serije + presentation save/replay/detail/query, dupliranje Page sa novim ID-jevima, SQL odbijanja i opaque očuvanje. Privremeni DB/server/cluster uklonjeni, port zatvoren. Privatni fixture/backup helperi nisu deo PR-a.
- Stvarni ECharts SVG pregledan u izdvojenom sintetičkom komponentnom prikazu na širokom i uskom ekranu; obe ose, detalji druge metrike, zoom i reset rade. Nema fallback greške ni horizontalnog prelivanja u uskom prikazu. Ovo nije ceo browser + DB E2E.
- Nezavisna revizija našla je blokiranje title-only izmene opaque v99 sadržaja sa `chartVariant:'combined'`. Ograničenja se sada primenjuju samo na podržanu v1 prezentaciju; dodat je regresioni test.

Širi release problemi sa prethodne osnove ostaju otvoreni: prethodno evidentirani frontend padovi/timeouts i backend Builder baseline pad. Puni skupovi nisu ponavljani u ovom koraku; ovaj izveštaj nije tvrdnja da je ceo release spreman.

Nema novih biblioteka, CDN-a, preuzetih galerijskih asseta ni promene ECharts vendora. Sledi odvojena procena ugovora i podataka za stacked/heatmap/scatter/box; pragovi i reference dolaze posle galerije, prema dogovoru.
