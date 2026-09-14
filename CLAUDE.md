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
`security-reviewer`, `mobile-qa`) su **read-only revieweri** — analiziraju i prijavljuju
nalaze, ne menjaju ništa. Ako subagent "predloži ispravku", to je tekst predloga za
glavnu sesiju da primeni, ne akcija koju je subagent sam izveo. Reviewer agenti ne pišu
memoriju (`.claude/rules/memory-maintenance.md`).

## Agent input contract

Revieweri nemaju Bash — ne mogu sami da pokrenu `git log`, testove, ili bilo šta drugo.
**Ne smeju tvrditi da su sami proverili Git istoriju ili izvršili testove** — sve što
znaju je ono što im glavna sesija eksplicitno prosledi u pozivu. Pre pozivanja bilo kog
reviewera, glavna sesija mu prosleđuje: cilj zadatka, relevantne strict acceptance
criteria, tačan diff range ili listu konkretnih promena, relevantne fajlove/simbole,
šta NIJE deo ovog pregleda, i već izvršene testove sa STVARNIM rezultatima (tačna
komanda + tačan broj) — ako testovi nisu pokrenuti, reci to eksplicitno.

## Orchestration matrica — kad se koji reviewer zove

| Priroda izmene | Pozovi |
|---|---|
| frontend JS/data/actions bez vizuelne promene | samo `code-reviewer` |
| frontend CSS/layout/responsive/pointer/touch/UI | `code-reviewer` + `mobile-qa` |
| običan backend servis/query (bez access/ownership uticaja) | samo `code-reviewer` |
| backend auth/access/workspace/ownership/multi-tenant | `code-reviewer` + `security-reviewer` |
| migracija/schema | `db-reviewer` (+ `security-reviewer` SAMO ako dira access/ownership) |
| dokumentacija/rules/memory-only (bez app koda) | `code-reviewer` (ceo diff) + `db-reviewer` (SAMO DB/migration contract delovi) + `security-reviewer` (DB safety, auth/workspace, secret-handling delovi) |
| sitna copy/stilska izmena (tekst, boja, razmak) | bez agenata |

Ne pokreći sve agente automatski na svaku izmenu — biraj po tabeli iznad. Za graničan
slučaj, glavna sesija bira najmanji relevantan skup koristeći najbolju stručnu procenu —
ne čeka se korisnik za svaku graničnu klasifikaciju. Pitaj korisnika samo ako bi izbor
reviewera mogao da promeni produktnu odluku, bezbednosni profil, ili obim zadatka.

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
`frontend.md`, `backend-security.md`, `migrations.md`, `memory-maintenance.md`.
