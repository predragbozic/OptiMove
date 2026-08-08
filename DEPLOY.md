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
  ci` (instalacija backend zavisnosti) pa `npm --prefix frontend ci`
  (instalacija frontend/Vite zavisnosti) pa `npm --prefix frontend run
  build` (produkcioni Vite build u `frontend/dist/`, hash-ovan i
  minifikovan).
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
