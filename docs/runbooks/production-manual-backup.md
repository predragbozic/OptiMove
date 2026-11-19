# Manual backup of the production database (Windows)

**Who:** the owner only, on the owner's own Windows computer. Nobody else runs it.

**Why:** until the project moves to Supabase Pro there are no automatic daily backups. This procedure makes a
backup file on your computer every night, checks that the file can be read, and deletes backups older than 14 days.

**What it does to production:** it only **reads**. It never changes, deletes or restores anything there.

The scripts:

| File | What it does |
|---|---|
| `scripts/backup/optimove-backup.ps1` | makes one backup file and checks it |
| `scripts/backup/optimove-restore-test.ps1` | proves a backup file can really be restored, on your own computer |

## Read this first: what has been proven, and what has NOT been tested yet

**Proven on 2026-11-19, by the owner's own first runs:** on Windows with Windows PowerShell 5.1 and the
PostgreSQL 17 tools, against production through the Supabase session pooler (port 5432), with a backup folder whose
path contains a space:

- the backup ended `OK` (245 tables), with the password read from `pgpass.conf`;
- the pooler accepted the read-only setting (no `NOTE` line);
- the restore test ended `RESTORE TEST OK`, with the same counts as production;
- the Task Scheduler task was created and ran.

**Still not tested by anyone:**

- the connection **with the Supabase certificate** (step 4, `ssl_root_cert`);
- a **real restore into a new Supabase project** (step 11);
- the fallback for a pooler that refuses the read-only setting (tested only with a stand-in).

The rule stays, for every new computer and after every change of the set-up:

> **Until the restore test (step 8) has said `RESTORE TEST OK` for a backup of production, do not consider that a
> backup exists.** A file in the folder and an `OK` from the backup script are not enough.

If a step behaves differently from what is written here, stop and report what the screen says (only the line with
`FAILED` or `refusing`, not the whole screen).

A backup file that has never been restored is only a hope. Do the restore test once after the first backup, and
then once a month (step 8).

---

## 1. Install the PostgreSQL 17 tools (once)

Production runs PostgreSQL 17.6. The backup tools must be version 17 or newer; the script refuses older ones.

1. Download the Windows installer for **PostgreSQL 17** from postgresql.org (the EDB installer).
2. Run it. Keep **PostgreSQL Server** and **Command Line Tools** ticked. The server part is your local database for
   the restore test; it does not touch production.
3. The installer asks for a password for the local user `postgres`. Choose one and keep it in your password manager.
   This is the **local** password. It is not the production password.
4. Keep the suggested port. It is normally `5432`. If another PostgreSQL is already on this computer (for example the
   development database), the installer suggests `5433`: write down which port it chose.
5. Check it. Open **Windows PowerShell** and run:

   ```
   & "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" --version
   ```

   The answer must read `pg_dump (PostgreSQL) 17.x`.

## 2. Create the backup folder (once)

Create a folder under your own user folder, for example `C:\Users\<you>\OptiMove-backups`.

The backup file holds **personal data, including data of minors** (athletes, users, results). So the folder must be:

- on a disk protected by **BitLocker** (Windows device encryption);
- **outside** OneDrive, Dropbox, Google Drive or any other synced folder. Windows often syncs Documents and Desktop to
  OneDrive, so do not put it there;
- **outside** the OptiMove code folder (the script refuses a folder inside a git checkout).

A backup file is **never** sent by email, put in a shared folder, uploaded to a chat or copied to a USB stick that
is not encrypted.

## 3. The config file (once)

The script reads the address of the database from a small text file on your computer. The file is not in the
repository and **never holds the password**.

1. In the Supabase dashboard open the project and press **Connect** at the top (in older layouts:
   **Project Settings > Database > Connection string**). Choose **Session pooler**. Read these three values from it:
   - the host, for example `aws-0-eu-central-1.pooler.supabase.com`;
   - the port: **5432**. Not 6543: that is the transaction pooler, and the script refuses it;
   - the user, in the form `postgres.<project-ref>`.

   Do not copy the password from there, and never press **Reset database password**: the deployed application would
   lose its connection to the database.
2. In PowerShell:

   ```
   mkdir "$env:APPDATA\OptiMove"
   notepad "$env:APPDATA\OptiMove\optimove-backup.local.conf"
   ```

3. Put these lines in the file, with your own values, and save:

   ```
   host = aws-0-eu-central-1.pooler.supabase.com
   port = 5432
   database = postgres
   user = postgres.<project-ref>
   backup_folder = C:\Users\<you>\OptiMove-backups
   retention_days = 14
   ```

Optional lines:

| Line | Meaning |
|---|---|
| `retention_days = 14` | how many days a backup is kept (14 when the line is missing) |
| `pg_bin = C:\Program Files\PostgreSQL\17\bin` | where the tools are, if the script does not find them by itself |
| `skip_schemas = name1, name2` | see "a schema ... which this backup does not know" in step 9. Do not add it on your own |

A line with a password in this file stops the script. If you ever typed one there, delete the line.

## 4. The Supabase certificate (once, strongly recommended)

The connection to Supabase is always encrypted. But without Supabase's certificate the script cannot check that the
server on the other end really **is** Supabase: someone who controls the network between your computer and Supabase
(a public or hotel Wi-Fi, for example) could stand in the middle and read the password and the data. With the
certificate the script checks the server every time and refuses to connect to anything else.

1. In the Supabase dashboard open the project > **Project Settings > Database > SSL Configuration** >
   **Download certificate**. You get a file named like `prod-ca-2021.crt`. It is not a secret.
2. Move it into the backup folder from step 2, for example `C:\Users\<you>\OptiMove-backups\prod-ca-2021.crt`.
3. Add this line to the config file from step 3 (`notepad "$env:APPDATA\OptiMove\optimove-backup.local.conf"`), with
   the real path and file name:

   ```
   ssl_root_cert = C:\Users\<you>\OptiMove-backups\prod-ca-2021.crt
   ```

From then on the script prints `TLS: encrypted, and the server is verified with ssl_root_cert`.

Without that line the script still works and prints
`TLS: encrypted, but the server is NOT verified. Add ssl_root_cert to the config file (runbook, step 4).`
That is acceptable for a first try on your home network. Do not leave it like that for the nightly run, and never
run it that way on a public network.

If a run with the certificate fails with `certificate verify failed` or `root certificate file ... does not exist`:
check the path in the config file, and that the file is the one downloaded from **this** project. Do not remove
the line to "make it work" without reporting it first.

## 5. The password file (once)

The PostgreSQL tools read the password from their own file, `pgpass.conf`. This way the password is never typed on
a command line, never shown on the screen and never written to a log.

The production password is the one inside the deployed application's `DATABASE_URL` (in the Render service's
environment), or the one in your password manager. If you do not know it, stop here and ask; do not reset it.

1. In PowerShell:

   ```
   mkdir "$env:APPDATA\postgresql"
   notepad "$env:APPDATA\postgresql\pgpass.conf"
   ```

2. Put these two lines in it (the first line must stay a comment line), with your own values:

   ```
   # host:port:database:user:password
   aws-0-eu-central-1.pooler.supabase.com:5432:postgres:postgres.<project-ref>:THE-PRODUCTION-PASSWORD
   ```

   Host, port and user must be written exactly as in the config file. If the password itself contains `:` or `\`,
   put a `\` in front of that character.
3. For the restore test add a third line for your local PostgreSQL (use the port from step 1):

   ```
   localhost:5432:*:postgres:THE-LOCAL-PASSWORD
   ```

4. Save and close Notepad. If you pasted a password, clear the clipboard history afterwards (Windows + V).

This file holds the passwords in plain text. It is only as safe as your Windows account and the encrypted disk.
Never copy it anywhere and never send it.

Without a line in `pgpass.conf` the script asks for the password instead, and only stars are shown while you type.
That works when you run it by hand, but not for the nightly run.

## 6. The first run

In PowerShell, from the OptiMove code folder:

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup\optimove-backup.ps1
```

The script first prints where it is going. **Read it before it continues**: the host, port and database must be the
ones you expect.

```
OptiMove backup (read only)
  host:     aws-0-eu-central-1.pooler.supabase.com
  port:     5432
  database: postgres
  folder:   C:\Users\<you>\OptiMove-backups
  keeps:    14 days
  TLS:      encrypted, and the server is verified with ssl_root_cert
```

After a few minutes it ends with one of two lines:

- `OK: optimove-2026-11-19-021500.dump, 48211234 bytes, 143 tables` — the backup is in the folder.
- `FAILED while ...` — there is **no** new backup. Go to step 9.

After an `OK` the folder holds:

| File | What it is |
|---|---|
| `optimove-YYYY-MM-DD-HHmmss.dump` | the backup |
| `optimove-YYYY-MM-DD-HHmmss.dump.sha256` | the file's fingerprint; the restore test uses it to notice a damaged file |
| `optimove-backup.log` | one line per run: time, OK or FAILED, file, size, number of tables; after a failure also the reason |
| `optimove-backup.lock` | a small empty file the script uses to make sure only one backup runs at a time. Leave it there; it is harmless |

What the script does, in order:

1. checks the config file, the folder and the tool version (the tools must not be older than the server);
   every connection to the database is opened **read only** (a second fence: a mistaken statement could not
   change anything); if the server does not accept that setting, the script says so once and goes on
   without it (see the note below);
2. checks the database's list of schemas (see step 9, "a schema ...");
3. runs `pg_dump --format=custom --no-owner --no-privileges` for the application's schemas: `calendar`, `library`,
   `media`, `plans`, `public`, `tests`, `training`, `training_load`;
4. reads the new file back with `pg_restore --list`. If that fails or lists no tables, the file is renamed to
   `.failed` and the run is `FAILED`;
5. writes the sha256 and the log line;
6. **only after all that** deletes its own backup files older than the retention. A failed run deletes nothing.

If the screen and the log show
`NOTE: Read-only setting not accepted by the server; continuing without it. The backup only reads.`, the backup is
still good: the script never writes to the database, with or without that setting. It is not a failure. Report it
once, so that it is known.

Run it at a quiet moment: not during a deploy or a migration. On a quiet database nobody notices the backup.

## 7. Every night, by itself (Task Scheduler)

1. Open **Task Scheduler** > **Create Task...** (not "Create Basic Task").
2. **General:** name `OptiMove backup`. Choose **Run only when user is logged on**.
3. **Triggers > New:** Daily, at an hour when the computer is on and nobody uses the application, for example 02:15.
4. **Actions > New:**
   - Program/script: `powershell.exe`
   - Add arguments (one line, with your own path to the code folder):

     ```
     -NoProfile -ExecutionPolicy Bypass -File "C:\Users\<you>\OptiMove\scripts\backup\optimove-backup.ps1" -NoPrompt
     ```

   `-NoPrompt` means: never wait for someone to type a password. If the password file has no matching line the run
   fails at once instead of hanging all night.
5. **Conditions** (on a laptop): untick **Start the task only if the computer is on AC power**, otherwise a
   laptop on battery makes no backup and says nothing. Tick **Wake the computer to run this task** if the laptop
   sleeps at night.
6. **Settings:** tick **Run task as soon as possible after a scheduled start is missed**, and **Stop the task if it
   runs longer than** 1 hour.
7. Test it: right click the task > **Run**, **once**, and wait a few minutes. A new line must appear in
   `optimove-backup.log`. Pressing Run a second time while the first is still working does no harm: the second one
   stops with `Another backup is already running; this one stops.`

**Look at the log once a week.** Open `optimove-backup.log`: the last line must say `OK` and carry yesterday's or
today's date. In Task Scheduler the column **Last Run Result** reads `0x0` after an OK run, `0x1` after a failed
one and `0x2` when the run stopped because another backup was already running. Under Task Scheduler there is no
window to read, so after a failure the log line itself says why (with the host, the user and the folder left out). A computer that is switched off at night makes no backup, and nothing warns you: only the log shows it.

## 8. The restore test (once now, then every month)

It restores a backup into a **new, throwaway** database on your own computer, prints a few numbers, and deletes
that database again. It works on `localhost` only and refuses any other host. It never connects to production and
never touches the `OPTIMOVE` development database.

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup\optimove-restore-test.ps1 -DumpPath "C:\Users\<you>\OptiMove-backups\optimove-2026-11-19-021500.dump"
```

Add `-Port 5433` if the installer chose that port in step 1.

What you see:

```
OptiMove restore test (this computer only)
  host:         localhost
  port:         5432
  new database: optimove_restore_test_20261119_101500 (created now, dropped at the end)
  backup file:  optimove-2026-11-19-021500.dump
  sha256:       matches
Restoring ...
  tables: 143 restored, 143 in the backup file
  rows in public.users: ...
  rows in public.clubs: ...
  rows in public.teams: ...
  rows in public.athletes: ...
  rows in library.exercises: ...
  rows in plans.plans: ...
  rows in training.activity_participants: ...
  last migration: ...
  dropped optimove_restore_test_20261119_101500
RESTORE TEST OK: the backup can be restored. Compare the numbers above with what you expect.
```

Look at the numbers: are there about as many users, athletes and exercises as you know the application has? Is the
last migration the newest one that was applied? If a number is zero or far too small, treat the backup as bad and
report it.

`RESTORE TEST FAILED ...`: that backup cannot be trusted. Make a new backup and test again. If the new one fails
too, stop and report the line after `FAILED` (not the whole screen).

If the window was closed in the middle, a database named `optimove_restore_test_...` can stay on your local
PostgreSQL. Delete it in pgAdmin: Databases > right click > Delete/Drop.

## 9. When a run says FAILED

Nothing was damaged: the script only reads. No old backup was deleted. The last line on the screen and the last
line of the log say where it stopped.

| The message says | What to do |
|---|---|
| `the config file was not found` | step 3 |
| `holds a password` | delete that line from the config file; the password belongs in `pgpass.conf` only |
| `pg_dump, pg_restore and psql were not found` | step 1, or add the `pg_bin` line (step 3) |
| `pg_dump is version 16 and the server is PostgreSQL 17` | the tools are too old: install PostgreSQL 17 (step 1) |
| `port 6543 is the transaction pooler` | use port 5432 in the config file **and** in `pgpass.conf` |
| `no line for this connection in the password file` | step 5: host, port and user in `pgpass.conf` must match the config file exactly |
| `the database could not be reached` | wrong password, host or user, or no internet. Check the line above it on the screen. Try again later. Never reset the database password |
| `a schema ... which this backup does not know` | the database has a new part the backup was not told about. **Stop and report the schema's name.** Nothing was dumped. Do not add `skip_schemas` on your own: that would leave data out of every backup from then on |
| `has no schema ...` | the config file points at the wrong database |
| `certificate verify failed` | step 4: the certificate file is wrong or the path is wrong. Do not remove the line; report it |
| a `NOTE` line about the read-only setting, and then `OK` | not a failure: see the note in step 6. Report it once |
| `pg_dump ended with exit code ...` | the connection broke, the disk is full, or a migration was running. Run it again at a quiet moment |
| `cannot be read back` or `lists no tables` | the file is damaged. It was renamed to `.failed`. Run again |
| `Another backup is already running; this one stops.` (the log says `SKIPPED`, Last Run Result `0x2`) | **Run was pressed twice**, or the nightly run started while you ran one by hand. Nothing is wrong: the second one stopped by itself and touched nothing. Wait for the first to finish and look at its line in the log |
| `already exists; run again in a moment` | two runs in the very same second. Run again |

A `.failed` file is **not** a backup. It may still hold personal data: the script deletes it with the old backups
after 14 days, or delete it yourself (and empty the recycle bin).

If the same message comes back three nights in a row, report it. When you report, copy only the `FAILED ...` line:
the rest of the screen can show the host and the project reference.

## 10. What a backup does NOT cover

- **Media files** (exercise images and videos). They are in object storage (R2), not in the database. The backup
  holds only their records.
- **Anything entered after the backup was made.** A backup from 02:15 does not hold what coaches entered at 10:00.
  With one backup per night, up to a day of work can be lost.
- **Supabase's own parts** (`auth`, `storage`, `vault` and similar), database roles and permissions.
- **The application's settings and secrets** in Render.
- **Nights when the computer was off**, and the time before the first backup.

It is also only as safe as the computer: a stolen or broken laptop takes the backups with it. That is one of the
reasons to move to Supabase Pro.

## 11. Restoring for real, into a new Supabase project

**Never alone, and never at night.** A real restore is done together with help (the developer side of the project),
step by step, with someone reading along. If you think you need it: stop, do not run anything, report, and keep the
backup files exactly as they are.

Two things this procedure never does, on purpose:

- it never restores **over** the existing production database. That would delete everything entered since the
  backup, and is a separate decision with its own plan;
- it has **not been rehearsed against a real Supabase project**. The steps below are the known path and the known
  obstacle, so that nobody meets them for the first time during an emergency.

The known path, into a **new, empty** Supabase project:

1. Create a new Supabase project (PostgreSQL 17, the same region). Take its Session pooler host, port 5432 and
   user, as in step 3. Its password goes into `pgpass.conf` as a new line, as in step 5.
2. **The known obstacle.** The backup carries its own `CREATE SCHEMA public`, and a new Supabase project already has
   an (empty) `public`. A plain `pg_restore --exit-on-error` therefore stops at once with
   `schema "public" already exists` and restores nothing. The preferred way around it drops nothing: restore from a
   list that leaves that one entry out.

   ```
   cd C:\Users\<you>\OptiMove-backups
   & "C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" --list --file=restore-list.txt optimove-YYYY-MM-DD-HHmmss.dump
   Get-Content restore-list.txt | Where-Object { $_ -notmatch '^\d+; \d+ \d+ SCHEMA - public ' } | Set-Content -Encoding ASCII restore-list-no-public.txt
   ```

   Exactly one line must be gone from `restore-list-no-public.txt`: the one that reads `... SCHEMA - public ...`.
3. Restore with that list. Read the host on the command line twice before pressing Enter: it must be the **new**
   project, not production.

   ```
   $env:PGSSLMODE = "require"
   & "C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" --exit-on-error --no-owner --no-privileges --use-list=restore-list-no-public.txt --no-password --host <NEW-pooler-host> --port 5432 --username postgres.<NEW-project-ref> --dbname postgres optimove-YYYY-MM-DD-HHmmss.dump
   ```

   It must end without any `error` line. The other way around the obstacle is to drop the new project's empty
   `public` schema first and restore without a list; it is the second choice, because it deletes something, and
   Supabase sets permissions on `public` that would then have to be put back.
4. Check the new database before anything points at it: the same counts as the restore test prints (users, clubs,
   teams, athletes, exercises, plans, the last migration).
5. Only then point the application at it: in Render, change the service's `DATABASE_URL` to the new project's
   connection string, and deploy. The application's own start-up checks the migrations.

What the backup does **not** bring to the new project, and has to be handled separately:

- the **media files** in R2 (they stay where they are; the new database only has their records);
- the **settings and secrets in Render** (they stay in Render; only `DATABASE_URL` changes);
- database **roles and permissions** (the backup is made with `--no-owner --no-privileges`), and anything set by
  hand in the old Supabase project's dashboard;
- everything entered **after** the backup was made.

What was proven about step 2 and 3: on a throwaway PostgreSQL 16 database that already had an empty `public`, the
plain restore failed with `schema "public" already exists`, and the restore with the edited list ended without an
error, with every table, row, function and the comment on `public` in place. The commands of steps 2 and 3 were run
as written there (with PowerShell 7 on Linux, exactly one line removed from the list). They were **not** run on
Windows and **not** against a Supabase project.

## 12. Relation to the GPEXE backup

`docs/runbooks/gpexe-backup-verify.md` is a stricter backup made before a GPEXE import: it also compares the
restored copy with the source, table by table. It stays the rule there. This nightly backup does not replace it.

---

## For a Mac or Linux computer (bash)

The same backup in two commands. The password comes from `~/.pgpass` (same lines as in step 5; the file must be
private: `chmod 600 ~/.pgpass`). Run them in the backup folder.

```
F="optimove-$(date +%Y-%m-%d-%H%M).dump"; PGSSLMODE=require pg_dump --format=custom --no-owner --no-privileges --strict-names --lock-wait-timeout=60000 --schema=calendar --schema=library --schema=media --schema=plans --schema=public --schema=tests --schema=training --schema=training_load --file="$F" --no-password --host <pooler-host> --port 5432 --username postgres.<project-ref> --dbname postgres

pg_restore --list "$F" | grep -c ' TABLE [^D]' && sha256sum "$F" > "$F.sha256"
```

The first command must end without an error. The second must print a number of tables greater than zero. These two
commands do not check the schema list, do not write the log and do not delete old backups: the Windows script does.

---

## Tests of the scripts

`scripts/backup/tests/optimove-backup.tests.ps1` (plain PowerShell, no test framework).

- Without a database: the config guards, the localhost guard, the version check, the password-file matching, the
  retention rule, the file names, the command lines:
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup\tests\optimove-backup.tests.ps1`
- End to end, against a **disposable** local PostgreSQL (it creates and drops `optimove_tests_backup_<random>` and a
  role of its own): add `-PgHost localhost -PgPort 5432 -PgUser postgres`, with the local password in the environment
  variable `OM_BACKUP_TEST_PGPASSWORD`. Never point it at anything but a throwaway local server.
