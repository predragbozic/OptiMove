# S6d.2 — Scatter grafikon i Advanced X/Y podešavanja

Osnova: Draft PR #394, `8c847936751bb01575a8ac363f9f222bdc12a0fc`. Scatter je deveti izbor galerije. UI je na engleskom, zajednička svetla tema ostaje; nema aktiviranja produkcije, merge-a ili deploy-a.

## Izbor i čuvanje

Na postojećem line/bar widgetu, Scatter otvara Advanced nacrt sa dve razrešene numeričke serije: primary = X, secondary = Y. Day/week određuje bucket opažanja, dok su obe grafičke ose numeričke. Trener bira metrike u postojećem picker-u; različite jedinice i source/aggregation/coverage policy ostaju odvojene. Za novu stavku prvo se kreira osnovni grafikon, pa dodaje druga metrika kroz Advanced. Simple ostaje single-series i usmerava na Advanced.

Konverzije iz Combined/Heatmap/Horizontal bar prilagođavaju tip, composition i interakcije u nacrtu. Scatter koristi automatske ose, nema datumskog zoom-a ili primene X opsega kao perioda. Dve serije su granica editora; promene u Separate plots eksplicitno uklanjaju poznatu prezentaciju. Unknown/opaque sadržaj se ne prepisuje, a title-only promene legalne prezentacije sa praznim chartInteractions koriste podrazumevanu auto osu/disabled zoom.

Čuva se postojeći `line_chart` sa `schemaVersion:1`, `chartVariant:'scatter'`, `chartComposition:'pairs-v1'`. Presentation ide poslednji posle serija, kroz postojeće revision/idempotency Advanced operacije; ovo nije nova atomska transakcija za ceo editor. Prekid čuvanja koristi postojeći recovery/rebase tok. Renderer odbija nepotpun oblik uz originalnu tabelu. SQL ne zahteva dve serije posle svakog pojedinačnog staged add/delete koraka.

## Serverski dokaz i renderer

Običan Page query automatski dodaje `widget.metricPairs` za svaki poznati v1 Scatter widget, u istom autorizovanom batch-u i read-only transakciji. X i Y se izvode iz sačuvanih primary/secondary serija, ne iz klijentskih koordinata. Prethodni opcioni top-level pairing ugovor ostaje funkcionalan. Svaki widget dobija sopstveni dokaz sa zajedničkim Page queryId i periodom; klon dobija dokaz za svoje nove ID-jeve.

Frontend koristi samo server pairs-v1. Proverava queryId, widget/series ID-jeve, period, sačuvane DB bindings, originalne row locatore, athlete/bucket, tačne vrednosti, jedinice i izvore. Bez važećeg dokaza nema ponovnog frontend uparivanja ni prikrivenog običnog line prikaza. Zastareo, izmenjen ili nepoznat dokaz odbija ceo Scatter i ostavlja tabelu.

Jedna tačka predstavlja isti pojedinačni sportista/bucket par već vraćenih agregata; ne tvrdi se ista aktivnost ili merni pokušaj. Nema regresione linije, korelacije, normalizacije, konverzije, interpolacije ili izmene vrednosti. Native point preview i tooltip daju obe metrike, jedinice, izvore i raw locatore. Sportisti su odvojene serije sa legendom/toggle kontrolama; Reset vraća vidljivost. Missing/conflict/duplicates nisu tačke; parcijalni skup prikazuje broj izostavljenih opažanja uz tabelu. Granice ostaju 20 sportista/8.000 parova i postojeći response limit.

## Migracija i uključivanje

Razvojni fajl v63 menja validatore kroz CREATE OR REPLACE, bez prepisivanja widgeta. Scatter/pairs-v1 su obavezan par, line_chart/day-week, bez fixed axes/local zoom/applyPeriod. Omitted interaction sections zadržavaju legalne podrazumevane vrednosti. Opaque future verzije ostaju prihvaćene. Novi marker `dashboard_scatter_v1()` upravlja Page/Simple capability discovery; Page upravljanje dodatno zahteva postojeće portove i prava. Legacy Simple ne nudi Scatter, a v1 preview pre v63 odbija se bez save tokena.

## Provere — 5. novembar 2026.

- **480/480 ciljnih frontend testova**, **227/227 backend testova**, build PASS uz postojeće upozorenje o veličini chunk-a. Obuhvaćeni su editor/konverzije/opaque/recovery, schema/compiler/capabilities, automatski parovi, strict proof i detalji obe metrike. Jedan zastareli test očekivao je osam galerijskih SVG ikona; usklađen je sa devet izbora i završni skup ponovo prolazi.
- Stvarni izolovani PostgreSQL/HTTP **1/1 PASS, pet scenarija**: pre-v63 gate/opaque preserve; OID/marker/Page-only/Advanced; dve serije + save/replay/detail/običan query/renderer sa `[42,1]`; Page clone sa novim ID-jevima i svežim važećim dokazom; SQL odbijanja i prazne interaction defaults. Validator OID ostaje isti. Test baza/server/cluster uklonjeni i port zatvoren. Privatni backup fixture/helperi nisu objavljeni.
- Stvarni ECharts SVG u izdvojenom sintetičkom komponentnom browser prikazu: tri sportista sa 4/3/3 tačke, dve označene omissions, value/value ose, nema datumskog zoom-a, native detalji Chris/8.okt daju 6000 m i 66 min sa različitim originalnim row indeksima. Toggle Bojan i Reset rade. Mobilni body/client 390/390, bez horizontalnog overflow-a; hideOverlap štiti numeričke tick oznake. Ovo je komponentna provera odvojena od PG dokaza, ne ceo browser+DB E2E.
- Nezavisna read-only ciljana revizija nije potvrdila P1/P2 nalaze. Provereni su source/bindings, locatori/pairing, stale context/capabilities, opaque i SQL potpisi. Reviewer nije ponavljao PG/browser/full suite; to su glavne odvojene provere.

Postojeći self-hosted ECharts 6.1.0 i licence ostaju; nema novih paketa/CDN-a niti preuzetih asseta. Nova galerijska SVG ikona je originalna. Konfiguracija prati zvanični [Basic Scatter vodič](https://echarts.apache.org/handbook/en/how-to/chart-types/scatter/basic-scatter/).

Raniji širi frontend/backend baseline release problemi ostaju otvoreni; ciljani prolaz ne predstavlja release GO. Stacked/Box zahtevaju preostale ugovore podataka, zatim slede pragovi/reference po dogovoru.
