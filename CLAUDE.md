# OptiMove — CLAUDE.md (operativni protokol)

Ovo je JEDINI koren-level CLAUDE.md. Ne pravi paralelne kopije (`CLAUDE_2.md`,
`CLAUDE_3.md`...) — ako nešto treba da se promeni, menja se ovaj fajl.

## Hijerarhija izvora istine

Kad izvori nisu usaglašeni, važi ovaj redosled (jače nadjačava slabije):

```
trenutni eksplicitni zahtev korisnika i potvrđene produktne odluke
  >  stvarni checked-out kod i introspektovana šema / applied migration state
  >  izvršeni testovi (kao DOKAZ ponašanja, ne kao poslovni zahtev)
  >  CLAUDE.md
  >  stari delivery izveštaji
```

Test koji protivreči **potvrđenom** zahtevu korisnika ili produktnoj odluci treba
ispraviti (test je pogrešno napisan ili zastareo), ne slediti naslepo kao da je test sam
po sebi cilj — testovi dokazuju da ponašanje odgovara zahtevu, oni ne DEFINIŠU zahtev.

Ovaj fajl (CLAUDE.md) je opis namere i protokola, ne izvor istine o trenutnom stanju koda.
Brojevi (broj testova, broj modula, broj migracija) se menjaju iz nedelje u nedelju — ne
veruj hardkodovanoj cifri u ovom fajlu ako je stara; ponovo izmeri (vidi komande ispod).

```bash
# broj frontend modula / linija
find frontend -maxdepth 1 -name "*.js" | wc -l
wc -l frontend/app.js

# broj migracija
ls migrations_v2/*.sql | wc -l

# broj testova (stvaran, ne memorisan)
npm --prefix backend test 2>&1 | tail -20
npm --prefix frontend test 2>&1 | tail -20
```

## Startup gate — obavezno pre bilo kakvog rada

Pre prve izmene u sesiji, uvek izvrši i pročitaj rezultat:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff            # ako ima necommit-ovanih izmena
git diff --staged   # ako ima staged izmena
```

- Ako `git status --short` pokaže dirty ili untracked fajlove koje TI nisi napravio u ovoj
  sesiji: **evidentiraj ih, ne diraj, ne briši, ne stage-uj, ne resetuj.**
- Ako se ti fajlovi NE preklapaju sa onim što je potrebno za trenutni zadatak, nastavi
  samostalno — sam nalaz nepovezanih dirty/untracked fajlova nije blocker.
- Pitaj korisnika SAMO ako postoji jedno od: (a) stvarno preklapanje sa fajlovima koje
  zadatak menja, (b) rizik gubitka nečijeg necommit-ovanog rada tvojom akcijom, (c) posao
  se ne može bezbedno izolovati od tog zatečenog stanja.
- Ako je trenutni branch neočekivan (npr. `main` kad se očekuje feature grana, ili obrnuto),
  stani i pitaj pre nego što praviš izmene.

## Tvrde zabrane (bez izričite dozvole korisnika u toj konkretnoj sesiji)

- `git add .` (ili bilo koji ekvivalent koji stage-uje sve) — stage-uj eksplicitno, fajl po
  fajl, da se zatečeni tuđi/nepovezani fajlovi ne povuku slučajno
- `git clean`, `git reset --hard`, bilo šta što briše necommit-ovan rad
- `git merge`, `git rebase` preko postojeće istorije, `git push --force`
- Deploy bilo koje vrste (Render ili drugde)
- Pokretanje migracija ili bilo koje izmene podataka/šeme na persistent bazi (lokalna
  OPTIMOVE, shared dev, staging, produkcija) bez potvrde — vidi pun **DB safety contract**
  ispod, koji definiše šta se sme automatski a šta zahteva eksplicitnu dozvolu
- Commit i push bez izričite potvrde korisnika za TAJ konkretan set izmena — čak i kad je
  posao gotov, stani i pitaj pre commit/push, ne pretpostavljaj saglasnost od ranije.

## DB safety contract

- **Automatski (bez pitanja) sme da se kreira/menja/briše SAMO jednokratna, jedinstveno
  imenovana disposable test baza** (napravljena i uništena unutar iste sesije, nigde
  drugde referencirana).
- **Lokalna persistent OPTIMOVE baza, shared dev, staging i produkcija zahtevaju
  eksplicitnu korisničku potvrdu** pre BILO KOJE operacije koja menja podatke ili šemu —
  bez izuzetka, bez obzira koliko izmena deluje bezopasno.
- Pre svake DOZVOLJENE operacije nad persistent bazom, ispiši i proveri **host, port i
  database name** iz stvarne konekcije koja će se koristiti — ne pretpostavljaj na osnovu
  imena env varijable.
- **Nikad ne koristi `DATABASE_URL` naslepo** — uvek prvo potvrdi na koju bazu tačno
  pokazuje (parsiraj host/port/dbname iz stringa i prikaži pre izvršavanja).
- Produkcija **nikad** nije obuhvaćena opštom dozvolom za migracije, čak i ako je
  korisnik ranije odobrio migracije uopšteno — svaka produkciona migracija traži novu,
  eksplicitnu potvrdu za taj konkretan slučaj.

## Model pisanja: jedan writer

- **Glavna Claude sesija je jedini implementer** — jedina koja menja fajlove (kod,
  konfiguraciju, migracije).
- **Subagenti (`code-reviewer`, `db-reviewer`, `security-reviewer`, `mobile-qa`) su
  read-only revieweri** — analiziraju i prijavljuju nalaze, ne menjaju ništa. Ako
  subagent "predloži ispravku", to je tekst predloga za glavnu sesiju da primeni, ne
  akcija koju je subagent sam izveo.
- Nikad ne pokreći dva agenta da paralelno menjaju iste fajlove — kod revieware ovo nije
  ni relevantno (read-only), ali ako se u budućnosti doda bilo koji pisući proces, pravilo
  ostaje: jedan writer po fajlu u datom trenutku.

## Agent input contract

Revieweri nemaju Bash — ne mogu sami da pokrenu `git log`, testove, ili bilo šta drugo.
**Ne smeju tvrditi da su sami proverili Git istoriju ili izvršili testove** — sve što znaju
je ono što im glavna sesija eksplicitno prosledi u pozivu. Pre pozivanja bilo kog reviewera,
glavna sesija mu prosleđuje:

- cilj zadatka (šta se pokušava postići, ne samo "pregledaj ovo")
- relevantne strict acceptance criteria za taj zadatak (ako postoje)
- tačan diff range ili listu konkretnih promena (fajl:linije, ili sam diff tekst)
- relevantne fajlove/simbole na koje treba da se fokusira
- out-of-scope — šta NIJE deo ovog pregleda (da reviewer ne luta van zadatka)
- već izvršene testove i njihove STVARNE rezultate (tačna komanda + tačan broj
  prolaznih/palih) — ako testovi nisu pokrenuti, reci to eksplicitno umesto da reviewer
  pretpostavi da jesu

## Orchestration matrica — kad se koji reviewer zove

| Priroda izmene | Pozovi |
|---|---|
| frontend JS/data/actions bez vizuelne promene | samo `code-reviewer` |
| frontend CSS/layout/responsive/pointer/touch/UI | `code-reviewer` + `mobile-qa` |
| običan backend servis/query (bez access/ownership uticaja) | samo `code-reviewer` |
| backend auth/access/workspace/ownership/multi-tenant | `code-reviewer` + `security-reviewer` |
| migracija/schema | `db-reviewer` (+ `security-reviewer` SAMO ako izmena dira access/ownership, npr. nova tabela sa `athlete_id`/`club_id` ili izmena role tabele) |
| sitna copy/stilska izmena (tekst, boja, razmak) | bez agenata |

Ne pokreći sve agente automatski na svaku izmenu — biraj po tabeli iznad. Ako priroda
izmene ne pripada jasno nijednom redu, **glavna sesija bira najmanji relevantan skup
reviewera koristeći najbolju stručnu procenu** — ne čeka se korisnik za svaku graničnu
klasifikaciju. Korisnika pitaj SAMO ako bi izbor reviewera mogao da promeni produktnu
odluku, bezbednosni profil, ili obim zadatka.

## Severity contract (zajednički za sve reviewere)

- **BLOCKER / CRITICAL** — glavna sesija MORA ispraviti pre nego što se zadatak proglasi
  gotovim. Nema izuzetka.
- **HIGH** — glavna sesija mora ispraviti, ILI, ako to nije moguće u obimu trenutnog
  zadatka, eksplicitno prijaviti korisniku kao pravi (ne kozmetički) blocker — ne sme se
  tiho preskočiti.
- **MEDIUM / WARNING** — ispravi ako je u obimu trenutnog zadatka; ako nije, dokumentuj
  (npr. u `PROJECT_CONTEXT.md` ako postoji, ili u delivery izveštaju) umesto da nestane.
- **LOW / NIT** — ne blokira završetak zadatka.

**Svaki nalaz, bez obzira na težinu, mora imati**: konkretan fajl/simbol, dokaz (citat
koda, izlaz komande, ili drugi proverljiv trag), posledicu (šta se stvarno kvari/rizikuje),
i predloženu korekciju. **Opšti savet bez dokaza nije nalaz** — "razmisli o bezbednosti
ovde" ili "ovo bi moglo biti problem" se odbacuje, ne broji se kao review rezultat.

## Definition of done

Zadatak je završen tek kad su ispunjeni SVI od sledećih uslova koji su relevantni za taj
zadatak:

- Svi acceptance criteria za taj zadatak zatvoreni
- Jedan glavni review prolaz nakon što je implementacija završena (ne pre, ne "za svaki
  slučaj" tokom rada)
- Ako taj prolaz nađe BLOCKER/HIGH i glavna sesija ga ispravi, dozvoljen je jedan **uski
  re-review — samo izmenjenog ugovora/fajlova** koji su bili predmet ispravke, ne ceo
  diff ponovo
- Nema ponavljanja KOMPLETNOG reviewa bez novog razloga (novog BLOCKER/HIGH nalaza koji
  to opravdava)
- Svi BLOCKER/HIGH nalazi rešeni u ISTOJ radnoj sesiji
- Ciljani testovi izvršeni (ne samo napisani) i njihov stvaran rezultat zabeležen
- Relevantna regresija proverena (baseline u izolovanom worktree-u, vidi Dokazni standard)
- Ako je frontend menjan: frontend build (`npm run build` / `verify:render-build` po
  potrebi) stvarno pokrenut
- Ako postoje UI/pointer/mobile tvrdnje: stvaran browser test izvršen od strane glavne
  sesije (ne samo statički pregled reviewera)
- `git diff --check` pokrenut i čist
- Potvrđeno da nema nepovezanih staged fajlova (samo namerne izmene su stage-ovane)
- Završna tabela **[Nalaz → Korekcija → Test → Status]** dostavljena korisniku
- Commit/push izvršen SAMO ako je korisnik to eksplicitno odobrio za taj konkretan set
  izmena
- Uvek stati (ne nastavljati samostalno) pre merge-a, deploy-a, i persistent DB migracije
  — bez obzira na to koliko prethodni koraci deluju "gotovo"

## Dokazni standard — šta se sme tvrditi kao "prošlo"

- **Testovi**: navedi TAČNU komandu koja je izvršena, tačan broj prolaznih/palih testova iz
  stvarnog izlaza (ne iz sećanja/pretpostavke), i da li je eventualni failure reprodukovan
  i na `origin/main` (da se zna da li je izmena unela regresiju ili je problem
  preduslovljen). Nikad ne piši "testovi prolaze" bez da si ih stvarno pokrenuo u toj
  sesiji.
- **UI / pointer / drag / resize / mobile tvrdnje**: statički pregled koda (regex, čitanje
  fajla) NIJE dovoljan dokaz da nešto radi u browseru. Za ove kategorije obavezna je
  stvarna browser provera (ručna ili automatizovana) od strane glavne sesije pre nego što
  se nešto proglasi ispravnim. `mobile-qa` subagent je read-only statički reviewer — njegov
  nalaz "izgleda ispravno u kodu" NIJE isto što i "potvrđeno da radi na uređaju".
- **Concurrency / race condition tvrdnje**: ako je zaštita implementirana na DB nivou
  (npr. `assert_dashboard_writable()` koja zaključava red pre provere — vidi
  `trainingLoadDashboard.js`), to je autoritativna zaštita; provera na nivou rute je samo
  optimizacija za čest slučaj, NE zamena za DB-level proveru. Ne tvrdi da je race
  condition rešen samo zato što ruta ima proveru pre upita — proveri da li postoji i
  DB-level lock/constraint iza toga.
- **Cross-workspace / access tvrdnje**: proveri stvarno ponašanje (test ili browser), ne
  pretpostavku na osnovu toga da ruta "izgleda" kao da ima proveru. Pogrešan/tuđi resurs
  ID treba da vrati isti odgovor kao nepostojeći resurs (vidi Security ugovor ispod) —
  ako to nije potvrđeno testom, ne tvrdi da je cross-workspace izolacija dokazana.
- **Baseline regresija**: pokreni OVU proveru **samo kad test padne** i treba utvrditi da
  li je failure pre-postojeći (prisutan i pre tvoje izmene) ili ga je uneo tvoj rad — ne
  pokreći baseline worktree za potpuno zelene testove, to je nepotreban trošak. Kad je
  potrebna: proveri da li je isto ponašanje prisutno i na `origin/main` PRE tvoje izmene —
  razlika između "moja izmena je unela bag" i "bag je već postojao" menja prioritet i
  odgovornost.

  Privremeni baseline worktree: koristi **jedinstvenu, platform-safe putanju** (npr.
  `/tmp/baseline-<random-id>` na Linux/macOS ili OS-odgovarajući temp dir, nikad
  hardkodovan fiksan naziv koji bi mogao da se sudari sa paralelnom sesijom), napravljen
  u **detached** stanju iz tačnog `origin/main` ref-a (`git worktree add --detach
  /tmp/baseline-<id> origin/main`). Worktree se **uvek uklanja u finally/cleanup koraku**
  (`git worktree remove`) bez obzira na ishod provere — i kad test u baseline-u prođe, i
  kad padne, i kad sama provera pukne. **Nikad ne koristi `git stash`, `git reset`, ni
  `git checkout` preko postojećeg, necommit-ovanog rada korisnika** da bi se privremeno
  "sklonio s puta" radi baseline provere — to je tačno vrsta akcije koju "Tvrde zabrane"
  sekcija iznad zabranjuje; worktree pristup postoji upravo da se to izbegne.

## Poznati, namerni kompromisi — ne kopiraj ih automatski na nova mesta

- `db.js`: `ssl: { rejectUnauthorized: false }` za Supabase konekciju. Ovo je **postojeći,
  svestan kompromis** (Supabase pooler sertifikat nije u Node-ovom default trust store-u),
  NE opšti obrazac koji treba ponoviti na novoj konekciji ili novom servisu bez razmišljanja.
  Ako se dodaje nova DB konekcija (drugi servis, drugi provider), preispitaj da li isti
  razlog stvarno važi pre nego što se ista postavka kopira.
- `EMAIL_PROVIDER`: kod i `.env.example` komentar tvrde da je `gmail` "trenutni default
  produkcioni provider", ALI Render-ovo izlazno mrežno okruženje je poznato po tome da
  blokira Gmail SMTP (ESOCKET/CONN greške) — zbog toga postoji `brevo` kao HTTPS
  alternativa. Ove dve tvrdnje jedna drugu delimično poriču. **Ne pretpostavljaj koji je
  provider stvarno aktivan u produkciji na osnovu komentara u kodu** — proveri stvarnu
  `EMAIL_PROVIDER` vrednost u Render environment varijablama pre nego što daš izjavu o
  tome kako email trenutno radi u produkciji.

## Autorizacija — ključni pojmovi (proveri kod za trenutnu implementaciju, ovo su samo orijentiri)

- `authz.js` → `resolveActiveWorkspace(userId, authz)` (definisano u `workspace.js`) —
  radni prostor se razrešava JEDNOM po zahtevu, ne ponovo na svakom internom pozivu unutar
  istog zahteva.
- `role_hint` na `users` je legacy UI hint — nikad izvor istine za autorizacionu odluku.
- Obrazac za tuđ/nepostojeći resurs (vidi `trainingLoadDashboard.js`,
  `requireManageableDashboard`): i "ne postoji" i "postoji ali nemaš pristup" vraćaju
  IDENTIČAN 404 odgovor (`{error:"notFound"}`) — namerno info-hiding, ne bag. Isti obrazac
  očekuj i proveravaj i na novim rutama koje diraju tuđe resurse.
- Konflikt stanja (npr. pokušaj izmene arhivirane/zaključane stavke) vraća `409`, ne `500`
  ni tihi uspeh.
- HTTP odgovor nikad ne sme sadržati sirovu SQLSTATE vrednost, UUID iz baze bez razloga,
  ili direktnu DB poruku o grešci.

## Migracije — operativna pravila

- Nove migracije isključivo u `migrations_v2/`, flat, `YYYYMMDDHHMM_opis.sql`.
- **Već primenjene/objavljene migracije su immutable** — checksumuju se, izmena posle
  primene baca grešku. Menjaj samo NEOBJAVLJENE migracije na feature grani pre merge-a u
  main; posle merge-a, svaka izmena ide kao nova migracija.
- Migracija ne sme sadržati sopstvenu transakcionu kontrolu (BEGIN/COMMIT/ROLLBACK;
  `ROLLBACK TO SAVEPOINT` je izuzetak).
- Statički pregled migracije NIJE dokaz da je production-safe — `db-reviewer` prijavljuje
  rizike (lock order, FK/CHECK/trigger integritet, backfill, rollback/partial-failure), ali
  stvarna provera na kopiji produkcione šeme (ili ekvivalentu) je odgovornost glavne sesije
  pre nego što se migracija označi kao spremna.

## Konvencije koda (kratko — detalji u samom kodu, ne dupliraj ih ovde)

- Frontend: novi domen prati `{ime}-view.js` + `{ime}-actions.js` + `{ime}-data.js`.
- Backend: nova training-load logika prati postojeći Access/Query/Catalog/Widgets obrazac
  pre nego što se pravi novi fajl od nule.
- SQL: uvek parametrizovano (`$1, $2`), nikad string interpolacija user-input vrednosti.
- `input`/`select`/`textarea`: `font-size >= 16px` na svim breakpoint-ovima (iOS zoom bug,
  već se dešavao).
- CSS cascade u `styles.css`: kasniji, širi mobile blokovi (obično `@media
  (max-width: 760px)` sa `!important`) često nadjačavaju ranije, uže blokove. Pre zaključka
  o mobilnom ponašanju na osnovu jednog bloka, pretraži ceo fajl za isti selektor.

## Trenutno stanje i otvorene stavke

Trenutno stanje projekta i otvorene stavke za razmatranje vode se u `PROJECT_CONTEXT.md`,
ako taj fajl postoji u repo-u — proveri tamo pre nego što pretpostaviš da nešto nije
primećeno ili urađeno. (Ovaj CLAUDE.md fajl namerno ne drži živu, promenljivu listu —
protokol ovde treba da ostane stabilan, ne da se menja iz dana u dan.)
