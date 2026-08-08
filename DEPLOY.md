# OptiMove deploy

Najjednostavniji prvi deploy je jedan Node Web Service koji servira i backend i frontend.

## Render setup

1. Napravi GitHub repo i pushuj ceo `ProgramAPp` folder.
2. Na Render-u napravi novi **Web Service** iz tog repo-a.
3. Podesi:
   - Build command: `npm run build`
   - Start command: `npm start`
   - Environment: `Node`
4. U Environment variables dodaj:
   - `DATABASE_URL` = Supabase pooler connection string
   - `PORT` ne mora rucno, hosting ga obicno sam postavlja
5. Deploy.

### perf/frontend-production-build: sta rade `npm run build` / `npm start`

Vrednosti Build/Start command-i u Render-u se NE menjaju (i dalje `npm run
build` / `npm start`) - promenjen je samo sadrzaj tih root `package.json`
skripti:

- **Build** (`npm run build`, root `package.json`): `npm --prefix backend
  ci` (instalacija backend zavisnosti) pa `npm --prefix frontend ci
  --include=dev` (instalacija frontend zavisnosti, ukljucujuci
  devDependencies - vidi hotfix/render-vite-install ispod za zasto je
  `--include=dev` obavezan) pa `npm --prefix frontend run build`
  (produkcioni Vite build u `frontend/dist/`, hash-ovan i minifikovan).
- **Start** (`npm start`, root `package.json` -> `npm --prefix backend
  start` -> backend's own `node src/migrate.js && node src/server.js`,
  nepromenjeno): prvo migracije, pa start servera. Server u produkciji
  (`NODE_ENV=production`) servira `frontend/dist` umesto sirovog
  `frontend/` izvora, i namerno puca sa jasnom greskom pri startu ako
  `frontend/dist` ne postoji (znaci da build korak nije prosao ili nije
  pokrenut).

Nijedna migracija se ne pokrece rucno ovim PR-om, i nijedna Render
environment promenljiva se ne menja - `frontend/dist/` se generise pri
svakom deploy-u i nikad se ne commit-uje u repo.

### hotfix/render-vite-install: zasto `--include=dev` i sta Vite JESTE/NIJE

Prvi Render deploy posle Vite PR-a je pukao sa `sh: 1: vite: not found`
(exit 127). Vite je frontend **devDependency** (`frontend/package.json`) -
to je ispravno, jer je Vite alat koji radi SAMO tokom build-a (`npm run
build` u `frontend/`) i nikad ne ulazi u produkcioni runtime: Vite se ne
importuje nigde u `backend/src/**`, ne servira se kao dev server u
produkciji (server.js u produkciji servira vec-izgradjeni `frontend/dist`,
vidi gore), i nije backend zavisnost u `backend/package.json`.

Problem je bio isključivo u tome KAKO se taj devDependency instalira: `npm
ci` (bez dodatnih flagova) moze preskociti sve devDependencies kad je npm-ov
konfig "production-like" - a Render build okruzenje tipicno postavlja
`NODE_ENV=production` za ceo build/deploy, i/ili moze imati svoj
`npm_config_production`/`omit=dev` podesen nezavisno. `npm --prefix frontend
ci --include=dev` eksplicitno trazi da se devDependencies instaliraju BEZ
OBZIRA na te "production" signale - ovo je pouzdaniji, moderniji ekvivalent
starijeg `--production=false` flaga (oba postoje u npm-u, `--include=dev`
je preporuceni oblik u npm 7+, koji ovaj repo koristi - vidi npm --version
u CI/Render logu).

`npm run verify:render-build` (root `package.json`, novo u ovom hotfix-u)
dokazuje ovo tacno: pravi IZOLOVANU kopiju `frontend/` u privremenom OS
direktorijumu (nikad ne dira pravi `frontend/node_modules` ili
`frontend/dist`), pokrece `npm ci --include=dev` sa
`NODE_ENV=production` I `npm_config_production=true` I
`npm_config_omit=dev` svi eksplicitno postavljeni (najgori realni
slucaj), potvrdjuje da `vite` binarni fajl zaista postoji u
`node_modules/.bin/`, pa pokrece `npm run build` i potvrdjuje da
`dist/index.html` i `dist/athlete.html` oba nastanu. Ovo je rucna
provera (kao `test:verify-isolation` u `backend/`), ne deo `npm test` -
pokreni je posle bilo koje izmene build lanca (root `package.json`,
`frontend/package.json`, `frontend/vite.config.js`).

## Test linkovi

Kada servis dobije javni URL, npr.:

`https://optimove.onrender.com`

Coach/admin view:

`https://optimove.onrender.com/`

Athlete view:

`https://optimove.onrender.com/athlete?athlete=101`

Za drugog sportistu promeni broj:

`https://optimove.onrender.com/athlete?athlete=102`

## Vazno za kasnije

Trenutni athlete link je test link. Ko zna `athlete=101`, moze da vidi taj program. Pre stvarnog deljenja sportistima treba dodati login ili privatni token link.
