# OptiMove — CLAUDE.md (operativni protokol)

Ovo je JEDINI koren-level CLAUDE.md. Ne pravi paralelne kopije (`CLAUDE_2.md`...) — ako
nešto treba da se promeni, menja se ovaj fajl. Detaljna pravila po temi žive u
`.claude/rules/*.md` — ovaj fajl ih linkuje, ne duplira.

@PROJECT_CONTEXT.md
@docs/ai/CURRENT_STATE.md

Arhitektonske odluke i njihov dokaz: `docs/decisions/README.md` (tabela) — čitaj
konkretan ADR po potrebi zadatka, ne uvozi ih sve automatski.

## Hijerarhija izvora istine

Kad izvori nisu usaglašeni, važi ovaj redosled (jače nadjačava slabije):

```
trenutni eksplicitni zahtev korisnika i potvrđene produktne odluke
  >  stvarni checked-out kod i introspektovana šema / applied migration state
  >  izvršeni testovi (kao DOKAZ ponašanja, ne kao poslovni zahtev)
  >  CLAUDE.md / .claude/rules / docs/decisions
  >  stari delivery izveštaji
```

Test koji protivreči **potvrđenom** zahtevu korisnika ili produktnoj odluci treba
ispraviti (test je pogrešno napisan ili zastareo), ne slediti naslepo — testovi dokazuju
da ponašanje odgovara zahtevu, oni ne DEFINIŠU zahtev.

Ovaj fajl je protokol, ne izvor istine o trenutnom stanju koda. Za brojeve (testovi,
migracije, moduli) ne veruj hardkodovanoj cifri bilo gde u ovom setu fajlova ako izgleda
stara — ponovo izmeri (`ls migrations_v2/*.sql | wc -l`,
`npm --prefix backend test`, `npm --prefix frontend test`).

## Startup gate i git bezbednost

Pre prve izmene u sesiji, pokreni i pročitaj: `git branch --show-current`,
`git rev-parse HEAD`, `git status --short`, `git diff` / `git diff --staged`. Zatečene
dirty/untracked fajlove koje nisi napravio ovom sesijom: evidentiraj, ne diraj. Pitaj
korisnika samo ako se stvarno preklapaju sa zadatkom, rizikuju tuđi necommit-ovan rad,
ili je trenutni branch neočekivan. Pun ugovor (uključujući baseline worktree i tvrde
zabrane — `git add .`, `stash`/`reset`/`clean`, merge/rebase/force-push, commit/push bez
eksplicitne potvrde): `.claude/rules/git-safety.md`.

## Granice dozvoljenih operacija

- Bez merge-a, deploy-a (Render ili drugde), ili migracije/izmene podataka na
  persistent bazi (lokalna OPTIMOVE, shared dev, staging, produkcija) bez eksplicitne
  korisničke potvrde ZA TAJ konkretan slučaj — puna DB politika:
  `.claude/rules/database-safety.md`.
- Migracije: konvencija i immutability pravilo — `.claude/rules/migrations.md`.
- Frontend/backend konvencije specifične za te putanje — `.claude/rules/frontend.md`,
  `.claude/rules/backend-security.md`.
- Šta se sme tvrditi kao "testirano" i kad je baseline provera potrebna —
  `.claude/rules/testing-evidence.md`.
- Kako i kada se ovaj memory-set (ovaj fajl, `PROJECT_CONTEXT.md`, `docs/`) sme menjati —
  `.claude/rules/memory-maintenance.md`.

## Model pisanja: jedan writer

Glavna Claude sesija je jedini implementer — jedina koja menja fajlove (kod,
konfiguraciju, migracije, i ovaj memory-set). Subagenti (`code-reviewer`, `db-reviewer`,
`security-reviewer`, `mobile-qa`, `ux-design-reviewer`) su **read-only revieweri** — analiziraju i prijavljuju
nalaze, ne menjaju ništa. Ako subagent "predloži ispravku", to je tekst predloga za
glavnu sesiju da primeni, ne akcija koju je subagent sam izveo. Reviewer agenti ne pišu
memoriju (`.claude/rules/memory-maintenance.md`).

## Agent input contract

Revieweri nemaju Bash — ne mogu sami da pokrenu `git log`, testove, ili bilo šta drugo.
**Ne smeju tvrditi da su sami proverili Git istoriju ili izvršili testove** — sve što
znaju je ono što im glavna sesija eksplicitno prosledi u pozivu. Pre pozivanja bilo kog
reviewera, glavna sesija mu MORA proslediti:

- originalni korisnički cilj i potvrđene produktne odluke (ne samo "pregledaj ovo");
- relevantne strict acceptance criteria za taj zadatak;
- base i head commit;
- kompletan unified diff, ili čitljivu apsolutnu putanju do privremenog patch fajla;
- spisak promenjenih fajlova;
- relevantne ADR/code/schema/API ugovore na koje se diff oslanja;
- šta NIJE deo ovog pregleda (out-of-scope);
- tačne test komande i njihove STVARNE rezultate (tačan broj prolaznih/palih) — ako
  testovi nisu pokrenuti, reci to eksplicitno, ne pretpostavljaj;
- poznate baseline padove, ali SAMO ako je test stvarno pao i baseline stvarno proveren.

Za `code-reviewer` konkretno: ako mu nedostaje cilj, acceptance criteria, ili stvaran
diff, on vraća `BLOCKED: incomplete review packet` i ne daje READY/NOT READY/READY WITH
NON-BLOCKING NOTES verdict — to nije reviewer greška, to je znak da poziv nije bio
kompletan; dopuni ulaz i pozovi ponovo, ne tumači BLOCKED kao "sve je u redu".

## Orchestration matrica — kad se koji reviewer zove

| Priroda izmene | Pozovi |
|---|---|
| frontend JS/data/actions bez vizuelne promene | samo `code-reviewer` |
| frontend CSS/layout/responsive/pointer/touch/UI | `code-reviewer` + `mobile-qa` |
| nov ili bitno izmenjen korisnički tok/ekran | prethodni relevantni revieweri + `ux-design-reviewer` |
| običan backend servis/query (bez access/ownership uticaja) | samo `code-reviewer` |
| backend auth/access/workspace/ownership/multi-tenant | `code-reviewer` + `security-reviewer` |
| migracija/schema | `db-reviewer` (+ `security-reviewer` SAMO ako dira access/ownership) |
| dokumentacija/rules/memory-only (bez app koda) | `code-reviewer` (ceo diff) + `db-reviewer` (SAMO DB/migration contract delovi) + `security-reviewer` (DB safety, auth/workspace, secret-handling delovi) |
| sitna copy/stilska izmena (tekst, boja, razmak) | bez agenata |

Ne pokreći sve agente automatski na svaku izmenu — biraj po tabeli iznad. Za graničan
slučaj, glavna sesija bira najmanji relevantan skup koristeći najbolju stručnu procenu —
ne čeka se korisnik za svaku graničnu klasifikaciju. Pitaj korisnika samo ako bi izbor
reviewera mogao da promeni produktnu odluku, bezbednosni profil, ili obim zadatka.

## External-review okidači — tačno pet

Interni reviewer skup (code-reviewer/db-reviewer/security-reviewer/mobile-qa/ux-design-reviewer) je
dovoljan za većinu zadataka, ali NIJE dovoljan sam po sebi kad se aktivira bilo koji od
sledećih pet okidača:

1. Migracija, persistent DB write, data rewrite/reconciliation, sankcionisan SQL, ili
   rollback.
2. Auth, role, `owner_scope`, `data_workspace`, cross-workspace, ili info-hiding ugovor.
3. Kanonski identitet, linking, merge/reparent, copy, ili materialization.
4. Transakcije, lock order, concurrency, retry, ili idempotency.
5. Nerešen BLOCKER/HIGH nalaz, neslaganje između reviewera, neobjašnjen pad testa, ili
   samo mock dokaz za kritičan tok (auth, plaćanje, ireverzibilna operacija).

Kad se aktivira bilo koji od ovih pet: glavna sesija završava sve bezbedne lokalne
provere (interni reviewer prolazi, testovi, `git diff --check`), pripremi
`EXTERNAL REVIEW REQUIRED` paket (isti sadržaj kao Agent input contract iznad — cilj,
acceptance criteria, diff, testovi, poznati nalazi), ali **ne proglašava
merge-readiness i ne radi PR, merge, ni deploy** dok se ta spoljna revizija ne obavi.
Ovo važi bez obzira na to koliko su interni reviewer nalazi čisti.

"Spoljna revizija" ovde znači: paket se preda KORISNIKU (ili osobi/procesu koju
korisnik odredi) na pregled izvan internog agent seta — nijedan od pet internih
agenata (code-reviewer/db-reviewer/security-reviewer/mobile-qa/ux-design-reviewer) se ne broji kao "spoljni"
sam po sebi, koliko god bio adversarial. Glavna sesija ne nastavlja sama dalje ka
merge-readiness dok korisnik (ili taj određeni proces) eksplicitno ne potvrdi da je
paket pregledan.

## Severity contract (zajednički za sve reviewere)

- **BLOCKER/CRITICAL** — glavna sesija MORA ispraviti pre nego što se zadatak proglasi
  gotovim. Nema izuzetka.
- **HIGH** — glavna sesija mora ispraviti, ILI eksplicitno prijaviti korisniku kao pravi
  blocker ako ispravka nije u obimu trenutnog zadatka — ne sme se tiho preskočiti.
- **MEDIUM/WARNING** — ispravi ako je u obimu; ako nije, dokumentuj (npr. u
  `docs/ai/CURRENT_STATE.md` ili delivery izveštaju) umesto da nestane.
- **LOW/NIT** — ne blokira završetak zadatka.

Svaki nalaz mora imati: konkretan fajl/simbol, dokaz (citat koda, izlaz komande),
posledicu, predloženu korekciju. Opšti savet bez dokaza nije nalaz.

## Definition of done (sažeto)

Svi acceptance criteria zatvoreni · jedan glavni review prolaz posle implementacije (ne
pre) · ako taj prolaz nađe BLOCKER/HIGH i ispravi se, dozvoljen jedan uski re-review samo
izmenjenog dela, ne ceo diff ponovo · svi BLOCKER/HIGH rešeni u istoj sesiji · ciljani
testovi stvarno izvršeni i rezultat zabeležen (`.claude/rules/testing-evidence.md`) ·
relevantna regresija proverena · frontend build pokrenut ako je frontend menjan · UI/
pointer/mobile tvrdnje potvrđene stvarnim browser testom, ne samo statičkim pregledom ·
`git diff --check` čist · potvrđeno da nema nepovezanih staged fajlova · završna tabela
[Nalaz → Korekcija → Test → Status] dostavljena korisniku · commit/push samo uz
eksplicitnu korisničku potvrdu za taj konkretan set izmena · uvek stati pre merge-a,
deploy-a, i persistent DB migracije, bez obzira koliko prethodni koraci deluju gotovo.

## Rules index

`.claude/rules/`: `git-safety.md`, `database-safety.md`, `testing-evidence.md`,
`frontend.md`, `backend-security.md`, `migrations.md`, `memory-maintenance.md`,
`review-feedback-loop.md`.
