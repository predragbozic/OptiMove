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
