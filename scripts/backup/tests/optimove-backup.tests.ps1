<#
.SYNOPSIS
  Tests of scripts/backup. No test framework is needed.

.DESCRIPTION
  Part 1 (always): the guards and the retention logic, without any database.
  Part 2 (only with -PgHost): the two scripts end to end against a DISPOSABLE local PostgreSQL. It creates
  optimove_tests_backup_<random> databases and drops them; the password is read from the environment variable
  OM_BACKUP_TEST_PGPASSWORD (never a parameter).

    pwsh -NoProfile -File scripts/backup/tests/optimove-backup.tests.ps1
    pwsh -NoProfile -File scripts/backup/tests/optimove-backup.tests.ps1 -PgHost localhost -PgPort 5432 -PgUser postgres

  Exit code 0 only when every test passed.
#>
[CmdletBinding()]
param(
  [string]$PgHost = '',
  [int]$PgPort = 5432,
  [string]$PgUser = 'postgres',
  [string]$PgBin = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$backupDir = Split-Path -Parent $PSScriptRoot
. (Join-Path $backupDir 'OptimoveBackup.Common.ps1')

$script:passed = 0
$script:failed = 0

function Test-Case {
  param([string]$Name, [scriptblock]$Body)
  try { & $Body; $script:passed++; Write-Host "ok   - $Name" }
  catch { $script:failed++; Write-Host "FAIL - $Name"; Write-Host "       $($_.Exception.Message)" }
}
function Assert-True { param($Condition, [string]$Message = 'expected true') if (-not $Condition) { throw $Message } }
function Assert-Equal { param($Actual, $Expected, [string]$Message = '') if ($Actual -ne $Expected) { throw "$Message expected <$Expected>, got <$Actual>" } }
function Assert-Throws {
  param([scriptblock]$Body, [string]$Pattern)
  $thrown = $null
  try { & $Body } catch { $thrown = $_.Exception.Message }
  if ($null -eq $thrown) { throw "expected a refusal matching /$Pattern/, nothing was thrown" }
  if ($thrown -notmatch $Pattern) { throw "expected a refusal matching /$Pattern/, got: $thrown" }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('om-backup-tests-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
[void](New-Item -ItemType Directory -Path $tempRoot)
function New-TempFolder { param([string]$Name) $p = Join-Path $tempRoot $Name; [void](New-Item -ItemType Directory -Path $p -Force); return $p }
function New-ConfigFile {
  param([string]$Name, [string[]]$Lines)
  $path = Join-Path (New-TempFolder 'conf') $Name
  Set-Content -LiteralPath $path -Value $Lines -Encoding ASCII
  return $path
}
$validLines = @('# comment', 'host = db.example.test', 'port = 5432', 'database = postgres', 'user = postgres.abcdefgh', "backup_folder = $tempRoot")

try {
  # ---------------------------------------------------------------- Part 1: no database

  Test-Case 'config: a valid file is read, retention defaults to 14 days' {
    $c = Read-OmBackupConfig -Path (New-ConfigFile 'ok.conf' $validLines)
    Assert-Equal $c['host'] 'db.example.test'
    Assert-Equal $c['port'] 5432
    Assert-Equal $c['user'] 'postgres.abcdefgh'
    Assert-Equal $c['retention_days'] 14
    Assert-Equal $c['skip_schemas'].Count 0
  }
  Test-Case 'config: a password line is refused, whatever the key is called' {
    foreach ($key in @('password', 'PASSWORD', 'pgpassword', 'db_pass', 'pwd', 'secret')) {
      Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile "p-$key.conf" ($validLines + "$key = hunter2")) } 'holds a password'
    }
  }
  Test-Case 'config: the refusal of a password line does not repeat the password' {
    $message = ''
    try { Read-OmBackupConfig -Path (New-ConfigFile 'leak.conf' ($validLines + 'password = hunter2')) } catch { $message = $_.Exception.Message }
    Assert-True ($message -ne '' -and $message -notmatch 'hunter2') 'the message repeats the password'
  }
  Test-Case 'config: an unknown key, a doubled key and a missing key are refused' {
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 'unk.conf' ($validLines + 'sslmode = disable')) } 'unknown key'
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 'dup.conf' ($validLines + 'port = 5433')) } 'given twice'
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 'mis.conf' ($validLines | Where-Object { $_ -notmatch '^user' })) } "no 'user'"
    Assert-Throws { Read-OmBackupConfig -Path (Join-Path $tempRoot 'nope.conf') } 'not found'
  }
  Test-Case 'config: a host, database or user that libpq could read as something else is refused' {
    $swap = { param($key, $value) @($validLines | ForEach-Object { if ($_ -match "^$key\b") { "$key = $value" } else { $_ } }) }
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 'h1.conf' (& $swap 'host' 'db.example.test/postgres?host=evil')) } 'host'
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 'h2.conf' (& $swap 'host' '-h')) } 'host'
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 'd1.conf' (& $swap 'database' 'postgresql://x@evil/postgres')) } 'database name'
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 'd2.conf' (& $swap 'database' 'dbname=postgres host=evil')) } 'database name'
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 'u1.conf' (& $swap 'user' 'postgres:secret')) } 'user name'
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 'p1.conf' (& $swap 'port' '0')) } 'port'
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 'p2.conf' (& $swap 'port' '5432; drop')) } 'port'
  }
  Test-Case 'config: retention must be a whole number of days, 1 or more' {
    foreach ($bad in @('0', '-3', '1.5', 'two')) {
      Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile "r-$bad.conf" ($validLines + "retention_days = $bad")) } 'retention_days'
    }
    Assert-Equal (Read-OmBackupConfig -Path (New-ConfigFile 'r30.conf' ($validLines + 'retention_days = 30')))['retention_days'] 30
  }
  Test-Case 'config: skip_schemas may not name an application schema' {
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 's1.conf' ($validLines + 'skip_schemas = scratch, training')) } 'application schema'
    Assert-Throws { Read-OmBackupConfig -Path (New-ConfigFile 's2.conf' ($validLines + 'skip_schemas = Bad-Name')) } 'plain schema name'
    Assert-Equal ((Read-OmBackupConfig -Path (New-ConfigFile 's3.conf' ($validLines + 'skip_schemas = scratch, old_stuff')))['skip_schemas'] -join '|') 'scratch|old_stuff'
  }
  Test-Case 'config: a config file inside a git repository is refused' {
    $repo = New-TempFolder 'fake-repo'
    [void](New-Item -ItemType Directory -Path (Join-Path $repo '.git') -Force)
    $inside = New-TempFolder 'fake-repo/sub'
    $path = Join-Path $inside 'optimove-backup.local.conf'
    Set-Content -LiteralPath $path -Value $validLines -Encoding ASCII
    Assert-Throws { Read-OmBackupConfig -Path $path } 'inside a git repository'
    Assert-True (Test-OmInsideGitRepo -Path $inside)
    Assert-True (-not (Test-OmInsideGitRepo -Path (New-TempFolder 'plain')))
    Assert-True (Test-OmInsideGitRepo -Path $backupDir) 'the scripts folder itself is in a repository'
  }

  Test-Case 'loopback: only this machine passes' {
    foreach ($ok in @('localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]')) { Assert-True (Test-OmLoopbackHost -HostName $ok) "$ok should be loopback" }
    foreach ($no in @('', $null, 'db.example.test', 'localhost.example.test', '127.0.0.1.example.test', '128.0.0.1', '10.0.0.5', '192.168.1.10', '0.0.0.0',
        '127.0.0.256', '127.0.0', 'aws-0-eu-central-1.pooler.supabase.com', '::2', 'localhost,db.example.test', '/var/run/postgresql')) {
      Assert-True (-not (Test-OmLoopbackHost -HostName $no)) "<$no> must not be loopback"
    }
  }

  Test-Case 'versions: the tool and server versions are read from their own text' {
    Assert-Equal (Get-OmToolMajorVersion -VersionText "pg_dump (PostgreSQL) 17.6`n") 17
    Assert-Equal (Get-OmToolMajorVersion -VersionText 'pg_dump (PostgreSQL) 16.9 (Ubuntu 16.9-0ubuntu0.24.04.1)') 16
    Assert-Equal (Get-OmToolMajorVersion -VersionText 'pg_restore (PostgreSQL) 18beta1') 18
    Assert-Equal (Get-OmToolMajorVersion -VersionText 'not a version') 0
    Assert-Equal (Get-OmToolMajorVersion -VersionText '') 0
    Assert-Equal (Get-OmServerMajorVersion -VersionNum "170006`n") 17
    Assert-Equal (Get-OmServerMajorVersion -VersionNum '160009') 16
    Assert-Equal (Get-OmServerMajorVersion -VersionNum '17.6') 0
    Assert-Equal (Get-OmServerMajorVersion -VersionNum '') 0
  }
  Test-Case 'versions: a pg_dump older than the server is refused; equal or newer passes; unreadable is refused' {
    Assert-Throws { Assert-OmToolNotOlderThanServer -ToolMajor 16 -ServerMajor 17 } 'pg_dump is version 16 and the server is PostgreSQL 17'
    Assert-Throws { Assert-OmToolNotOlderThanServer -ToolMajor 0 -ServerMajor 17 } 'could not be read'
    Assert-Throws { Assert-OmToolNotOlderThanServer -ToolMajor 17 -ServerMajor 0 } 'could not be read'
    Assert-OmToolNotOlderThanServer -ToolMajor 17 -ServerMajor 17
    Assert-OmToolNotOlderThanServer -ToolMajor 18 -ServerMajor 17
  }
  Test-Case 'pooler: the transaction pooler (6543) is refused, the session pooler passes' {
    Assert-Throws { Assert-OmNotTransactionPooler -HostName 'aws-0-eu-central-1.pooler.supabase.com' -Port 6543 } 'transaction pooler'
    Assert-OmNotTransactionPooler -HostName 'aws-0-eu-central-1.pooler.supabase.com' -Port 5432
    Assert-OmNotTransactionPooler -HostName 'localhost' -Port 6543
  }

  Test-Case 'schemas: the two lists are the lists of backend/scripts/gpexe-backup-verify.mjs' {
    $source = Get-Content -LiteralPath (Join-Path (Split-Path -Parent (Split-Path -Parent $backupDir)) 'backend/scripts/gpexe-backup-verify.mjs') -Raw
    $read = {
      param($constant)
      if ($source -notmatch "(?s)export const $constant = Object\.freeze\(\[(.*?)\]\)") { throw "$constant was not found in gpexe-backup-verify.mjs" }
      return (@([regex]::Matches($Matches[1], '"([a-z_]+)"') | ForEach-Object { $_.Groups[1].Value }) -join ',')
    }
    Assert-Equal ((Get-OmAppSchemas) -join ',') (& $read 'APP_SCHEMAS') 'APP_SCHEMAS:'
    Assert-Equal ((Get-OmHostingSchemas) -join ',') (& $read 'HOSTING_SCHEMAS') 'HOSTING_SCHEMAS:'
  }
  Test-Case 'schemas: an unknown schema stops the run; a hosting or skipped one does not; a missing application schema stops it' {
    $app = Get-OmAppSchemas
    Test-OmSchemaList -ServerSchemas ($app + @('auth', 'storage', 'vault'))
    Assert-Throws { Test-OmSchemaList -ServerSchemas ($app + @('auth', 'new_module')) } 'has schema new_module'
    Test-OmSchemaList -ServerSchemas ($app + @('new_module')) -SkipSchemas @('new_module')
    Assert-Throws { Test-OmSchemaList -ServerSchemas @($app | Where-Object { $_ -ne 'training' }) } 'has no schema training'
  }

  Test-Case 'pgpass: a matching line is found, with wildcards and escapes; the password is never returned' {
    $pg = Join-Path (New-TempFolder 'pgpass') 'pgpass.conf'
    Set-Content -LiteralPath $pg -Encoding ASCII -Value @(
      '# comment',
      'other.example.test:5432:postgres:postgres:pw-one',
      'db.example.test:5432:postgres:postgres.abcdefgh:pw:with\:colon',
      'localhost:*:*:postgres:pw-local',
      'v6\:\:1:5432:postgres:postgres:pw-v6',
      'empty.example.test:5432:postgres:postgres:',
      'short:line'
    )
    Assert-True (Test-OmPgPassEntry -PgPassPath $pg -HostName 'db.example.test' -Port 5432 -Database 'postgres' -User 'postgres.abcdefgh')
    Assert-True (Test-OmPgPassEntry -PgPassPath $pg -HostName 'localhost' -Port 5433 -Database 'anything' -User 'postgres')
    Assert-True (Test-OmPgPassEntry -PgPassPath $pg -HostName 'v6::1' -Port 5432 -Database 'postgres' -User 'postgres')
    Assert-True (-not (Test-OmPgPassEntry -PgPassPath $pg -HostName 'db.example.test' -Port 6543 -Database 'postgres' -User 'postgres.abcdefgh'))
    Assert-True (-not (Test-OmPgPassEntry -PgPassPath $pg -HostName 'db.example.test' -Port 5432 -Database 'postgres' -User 'postgres'))
    Assert-True (-not (Test-OmPgPassEntry -PgPassPath $pg -HostName 'empty.example.test' -Port 5432 -Database 'postgres' -User 'postgres')) 'a line with an empty password is not a password'
    Assert-True (-not (Test-OmPgPassEntry -PgPassPath (Join-Path $tempRoot 'missing.conf') -HostName 'localhost' -Port 5432 -Database 'postgres' -User 'postgres'))
    Assert-Equal ((Split-OmPgPassLine -Line 'a\:b:5432:d\\b:u:p:w') -join '|') 'a:b|5432|d\b|u|p|w'
    $result = Test-OmPgPassEntry -PgPassPath $pg -HostName 'localhost' -Port 5432 -Database 'postgres' -User 'postgres'
    Assert-True ($result -is [bool]) 'only true or false comes back'
  }
  Test-Case 'password: without a pgpass line and with -NoPrompt the run refuses instead of asking' {
    Assert-Throws { Resolve-OmPassword -HostName 'db.example.test' -Port 5432 -Database 'postgres' -User 'postgres' -PgPassPath (Join-Path $tempRoot 'missing.conf') -NoPrompt -PromptText 'x' } 'forbids asking'
  }

  Test-Case 'names: the backup file name and the time read back from it' {
    $when = New-Object datetime 2026, 11, 19, 2, 5, 59
    Assert-Equal (New-OmDumpFileName -Now $when) 'optimove-2026-11-19-020559.dump'
    Assert-Equal (Get-OmDumpTimeFromName -Name 'optimove-2026-11-19-020559.dump') $when
    Assert-Equal (Get-OmDumpTimeFromName -Name 'optimove-2026-11-19-020559.dump.failed') $when
    Assert-True ($null -eq (Get-OmDumpTimeFromName -Name 'optimove-2026-11-19-02055.dump')) 'five digits is not a time'
    Assert-True ($null -eq (Get-OmDumpTimeFromName -Name 'optimove-2026-11-19-0205599.dump')) 'seven digits is not a time'
    Assert-Equal (Get-OmDumpTimeFromName -Name 'optimove-2026-11-19-0205.dump') (New-Object datetime 2026, 11, 19, 2, 5, 0)
    Assert-Equal (Get-OmDumpTimeFromName -Name 'optimove-2026-11-19-0205.dump.sha256') (New-Object datetime 2026, 11, 19, 2, 5, 0)
    Assert-Equal (Get-OmDumpTimeFromName -Name 'optimove-2026-11-19-0205.dump.failed') (New-Object datetime 2026, 11, 19, 2, 5, 0)
    foreach ($other in @('optimove-production-2026-11-01.dump', 'optimove-2026-11-19-0205.dump.verify.json', 'optimove-2026-13-45-9999.dump', 'my-optimove-2026-11-19-0205.dump',
        'optimove-2026-11-19-0205.dump.bak', 'optimove-backup.log', 'optimove-2026-11-19.dump', 'notes.txt')) {
      Assert-True ($null -eq (Get-OmDumpTimeFromName -Name $other)) "$other must not be read as one of this script's backups"
    }
  }
  Test-Case 'retention: only this script''s own files older than the limit expire; never the new one, never anything else' {
    $folder = New-TempFolder 'retention'
    $names = @(
      'optimove-2026-11-01-0200.dump', 'optimove-2026-11-01-0200.dump.sha256',   # 18 days old: expire
      'optimove-2026-10-20-0200.dump.failed',                                    # old failed file: expires
      'optimove-2026-11-05-0200.dump', 'optimove-2026-11-05-0200.dump.sha256',   # exactly 14 days: stays
      'optimove-2026-11-05-0159.dump',                                           # one minute past 14 days: expires
      'optimove-2026-11-18-0200.dump', 'optimove-2026-11-18-0200.dump.sha256',   # yesterday: stays
      'optimove-2026-11-19-0200.dump', 'optimove-2026-11-19-0200.dump.sha256',   # the new one: stays
      'optimove-production-2026-09-01.dump', 'optimove-production-2026-09-01.dump.verify.json',  # another procedure's files: stay
      'optimove-backup.log', 'prod-ca.crt', 'holiday-2019.dump'                  # anything else: stays
    )
    foreach ($name in $names) { Set-Content -LiteralPath (Join-Path $folder $name) -Value 'x' }
    $sub = Join-Path $folder 'optimove-2020-01-01-0000.dump'
    [void](New-Item -ItemType Directory -Path $sub)                              # a folder with a matching name: stays
    $now = New-Object datetime 2026, 11, 19, 2, 0, 0
    $expired = Get-OmExpiredBackupFiles -Folder $folder -RetentionDays 14 -Now $now -KeepName 'optimove-2026-11-19-0200.dump'
    $got = (@($expired | ForEach-Object { $_.Name } | Sort-Object) -join '|')
    Assert-Equal $got 'optimove-2026-10-20-0200.dump.failed|optimove-2026-11-01-0200.dump|optimove-2026-11-01-0200.dump.sha256|optimove-2026-11-05-0159.dump'
  }
  Test-Case 'retention: the new file is kept even when the clock says it is old; 0 days is refused' {
    $folder = New-TempFolder 'retention2'
    foreach ($name in @('optimove-2026-11-19-0200.dump', 'optimove-2026-11-19-0200.dump.sha256', 'optimove-2026-11-18-0200.dump')) { Set-Content -LiteralPath (Join-Path $folder $name) -Value 'x' }
    $farFuture = New-Object datetime 2030, 1, 1, 0, 0, 0
    $expired = Get-OmExpiredBackupFiles -Folder $folder -RetentionDays 1 -Now $farFuture -KeepName 'optimove-2026-11-19-0200.dump'
    Assert-Equal (@($expired | ForEach-Object { $_.Name }) -join '|') 'optimove-2026-11-18-0200.dump'
    Assert-Throws { Get-OmExpiredBackupFiles -Folder $folder -RetentionDays 0 -Now $farFuture } '1 day or more'
  }

  Test-Case 'list: tables are counted from the table of contents, table data is not' {
    $list = @(
      ';', '; Archive created at 2026-11-19 02:00:03 CET', ';     Dumped from database version: 17.6', ';     Dumped by pg_dump version: 17.6', ';',
      '7; 2615 16390 SCHEMA - training postgres',
      '215; 1259 16391 TABLE public users postgres',
      '216; 1259 16400 TABLE training activity_participants postgres',
      '3400; 0 16391 TABLE DATA public users postgres',
      '3401; 0 16400 TABLE DATA training activity_participants postgres',
      '217; 1259 16410 SEQUENCE public users_id_seq postgres',
      '3300; 2606 16420 CONSTRAINT public users users_pkey postgres'
    ) -join "`r`n"
    Assert-Equal (Get-OmTableCountFromList -ListText $list) 2
    Assert-Equal (Get-OmDumpServerMajorFromList -ListText $list) 17
    Assert-Equal (Get-OmTableCountFromList -ListText '') 0
    Assert-Equal (Get-OmTableCountFromList -ListText "; nothing here`n") 0
    Assert-Equal (Get-OmDumpServerMajorFromList -ListText '; nothing') 0
  }

  Test-Case 'list: a backup that creates the public schema itself is recognised' {
    Assert-True (Test-OmDumpCreatesSchema -ListText "6; 2615 16385 SCHEMA - plans postgres`r`n7; 2615 2200 SCHEMA - public postgres" -Schema 'public')
    Assert-True (-not (Test-OmDumpCreatesSchema -ListText "6; 2615 16385 SCHEMA - plans postgres`n3300; 0 0 COMMENT - SCHEMA public postgres" -Schema 'public'))
    Assert-True (-not (Test-OmDumpCreatesSchema -ListText '' -Schema 'public'))
  }
  Test-Case 'restore: only a throwaway name may be created or dropped' {
    $name = New-OmRestoreDatabaseName -Now (New-Object datetime 2026, 11, 19, 2, 5, 9)
    Assert-Equal $name 'optimove_restore_test_20261119_020509'
    Assert-True (Test-OmRestoreDatabaseName -Name $name)
    foreach ($bad in @('OPTIMOVE', 'optimove', 'postgres', '', $null, 'optimove_restore_test_', 'optimove_restore_test_20261119_020509"; drop database "OPTIMOVE',
        'OPTIMOVE_restore_test_20261119_020509', 'x_optimove_restore_test_20261119_020509', 'optimove_tests_1')) {
      Assert-True (-not (Test-OmRestoreDatabaseName -Name $bad)) "<$bad> must not pass"
    }
  }

  Test-Case 'command lines: pg_dump and pg_restore carry the agreed switches, the eight schemas, and no password' {
    $dump = Get-OmPgDumpArgs -HostName 'db.example.test' -Port 5432 -User 'postgres.abcdefgh' -Database 'postgres' -DumpPath 'C:\Backups\optimove-2026-11-19-0200.dump'
    foreach ($switch in @('--format=custom', '--no-owner', '--no-privileges', '--strict-names', '--no-password', '--lock-wait-timeout=60000')) { Assert-True ($dump -contains $switch) "pg_dump lacks $switch" }
    foreach ($schema in (Get-OmAppSchemas)) { Assert-True ($dump -contains "--schema=$schema") "pg_dump lacks --schema=$schema" }
    Assert-Equal (@($dump | Where-Object { $_ -like '--schema=*' }).Count) 8
    Assert-Equal ($dump[-9..-1] -join ' ') '--no-password --host db.example.test --port 5432 --username postgres.abcdefgh --dbname postgres'
    $restore = Get-OmPgRestoreArgs -HostName 'localhost' -Port 5433 -User 'postgres' -Database 'optimove_restore_test_20261119_020509' -DumpPath 'C:\Backups\a b.dump'
    Assert-Equal ($restore -join ' ') '--exit-on-error --no-owner --no-privileges --no-password --host localhost --port 5433 --username postgres --dbname optimove_restore_test_20261119_020509 C:\Backups\a b.dump'
    Assert-True (@(($dump + $restore) | Where-Object { $_ -match 'pass' -and $_ -ne '--no-password' }).Count -eq 0)
  }
  Test-Case 'command lines: an argument with spaces or quotes is quoted by the Windows rules' {
    Assert-Equal (ConvertTo-OmArgument -Value 'plain') 'plain'
    Assert-Equal (ConvertTo-OmArgument -Value 'C:\Program Files\x') '"C:\Program Files\x"'
    Assert-Equal (ConvertTo-OmArgument -Value 'C:\My Backups\') '"C:\My Backups\\"'
    Assert-Equal (ConvertTo-OmArgument -Value 'say "hi"') '"say \"hi\""'
    Assert-Equal (ConvertTo-OmArgument -Value '') '""'
  }
  Test-Case 'lock: one holder at a time; a lock file nobody holds open blocks nobody' {
    $folder = New-TempFolder 'lock'
    Set-Content -LiteralPath (Join-Path $folder 'optimove-backup.lock') -Value 'left behind by a crash'
    $first = Enter-OmBackupLock -Folder $folder
    Assert-True ($null -ne $first) 'a stale lock file blocked the run'
    try {
      Assert-True ($null -eq (Enter-OmBackupLock -Folder $folder)) 'a second holder got the lock'
      Assert-True ($null -eq (Enter-OmBackupLock -Folder $folder)) 'a third holder got the lock'
    } finally { Exit-OmBackupLock -Lock $first }
    $again = Enter-OmBackupLock -Folder $folder
    Assert-True ($null -ne $again) 'the lock was not free after its holder let go'
    Exit-OmBackupLock -Lock $again
    Exit-OmBackupLock -Lock $null
    $other = Enter-OmBackupLock -Folder (New-TempFolder 'lock-other')
    Assert-True ($null -ne $other) 'the lock is per folder'
    Exit-OmBackupLock -Lock $other
  }
  Test-Case 'lock: a second PROCESS cannot take a lock the first one holds' {
    $folder = New-TempFolder 'lock-process'
    $first = Enter-OmBackupLock -Folder $folder
    try {
      $probe = "Set-StrictMode -Version 2.0; . '$(Join-Path $backupDir 'OptimoveBackup.Common.ps1')'; `$l = Enter-OmBackupLock -Folder '$folder'; if (`$null -eq `$l) { 'held' } else { 'free'; `$l.Dispose() }"
      $shellPath = (Get-Process -Id $PID).Path
      Assert-Equal ((& $shellPath -NoProfile -NonInteractive -Command $probe | Out-String).Trim()) 'held'
      Exit-OmBackupLock -Lock $first; $first = $null
      Assert-Equal ((& $shellPath -NoProfile -NonInteractive -Command $probe | Out-String).Trim()) 'free'
    } finally { Exit-OmBackupLock -Lock $first }
  }
  Test-Case 'names: a new backup file is reserved only when the name is free, and a taken name is left untouched' {
    $folder = New-TempFolder 'reserve'
    $when = New-Object datetime 2026, 11, 19, 12, 20, 51
    $path = New-OmDumpFile -Folder $folder -Now $when
    Assert-Equal ([System.IO.Path]::GetFileName($path)) 'optimove-2026-11-19-122051.dump'
    Assert-True (Test-Path -LiteralPath $path -PathType Leaf)
    Set-Content -LiteralPath $path -Value 'the first run is writing this' -NoNewline
    Assert-Throws { New-OmDumpFile -Folder $folder -Now $when } 'optimove-2026-11-19-122051\.dump already exists'
    Assert-Equal (Get-Content -LiteralPath $path -Raw) 'the first run is writing this' 'the file of the first run was changed:'
    $next = New-OmDumpFile -Folder $folder -Now $when.AddSeconds(1)
    Assert-Equal ([System.IO.Path]::GetFileName($next)) 'optimove-2026-11-19-122052.dump'
    Set-Content -LiteralPath (Join-Path $folder 'optimove-2026-11-19-122053.dump.failed') -Value 'x'
    Assert-Throws { New-OmDumpFile -Folder $folder -Now $when.AddSeconds(2) } '\.failed already exists'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $folder 'optimove-2026-11-19-122053.dump'))) 'a file was created next to a .failed one'
  }
  Test-Case 'retention: file names with and without seconds are both this script''s backups' {
    $folder = New-TempFolder 'retention3'
    foreach ($name in @('optimove-2026-11-01-0200.dump', 'optimove-2026-11-01-020030.dump', 'optimove-2026-11-01-020030.dump.sha256', 'optimove-2026-11-18-020030.dump', 'optimove-2026-11-19-020030.dump')) { Set-Content -LiteralPath (Join-Path $folder $name) -Value 'x' }
    $expired = Get-OmExpiredBackupFiles -Folder $folder -RetentionDays 14 -Now (New-Object datetime 2026, 11, 19, 2, 0, 30) -KeepName 'optimove-2026-11-19-020030.dump'
    Assert-Equal (@($expired | ForEach-Object { $_.Name } | Sort-Object) -join '|') 'optimove-2026-11-01-0200.dump|optimove-2026-11-01-020030.dump|optimove-2026-11-01-020030.dump.sha256'
  }
  Test-Case 'log reason: the first line of the error, without the host, the user, the folder, quoted text, addresses or a password' {
    $hide = @('aws-0-eu-west-1.pooler.supabase.com', 'postgres.abcdefghijklmnop', 'postgres', 'C:\Users\Jane Doe\OptiMove backups', 'Jane Doe')
    $cases = @(
      @('pg_dump: error: connection to server at "aws-0-eu-west-1.pooler.supabase.com" (52.209.1.17), port 5432 failed: FATAL:  password authentication failed for user "postgres.abcdefghijklmnop"',
        'pg_dump: error: connection to server at <hidden> (<hidden>), port 5432 failed: FATAL: password authentication failed for user <hidden>'),
      @("`r`n`r`npg_dump: error: could not open output file `"C:\Users\Jane Doe\OptiMove backups\optimove-2026-11-19-122051.dump`": Permission denied`r`nsecond line with secret hunter2",
        'pg_dump: error: could not open output file <hidden>: Permission denied'),
      @('pg_dump: error: could not open output file C:\Users\Jane Doe\OptiMove backups\x.dump: Permission denied', 'pg_dump: error: could not open output file <hidden> \x.dump: Permission denied'),
      @('psql: error: connection to server at aws-0-eu-west-1.pooler.supabase.com (2a05:d018:135e:16::1), port 5432 failed: timeout expired', 'psql: error: connection to server at <hidden> (<hidden>), port 5432 failed: timeout expired'),
      @('psql: error: could not translate host name db.other-project.supabase.co to address: Name or service not known', 'psql: error: could not translate host name <hidden> to address: Name or service not known'),
      @('error: invalid connection option host=evil.example.test password=hunter2 user=someone PGPASSWORD=hunter3', 'error: invalid connection option <hidden>'),
      @('error: postgresql://postgres.abcdefghijklmnop:hunter2@aws-0-eu-west-1.pooler.supabase.com:5432/postgres refused', 'error: <hidden> refused'),
      @('FATAL: Tenant or user not found (postgres.zyxwvutsrqponm)', 'FATAL: Tenant or user not found (<hidden>)'),
      @('pg_restore: error: could not read /home/jane/backups/optimove.dump | injected | OK | line', 'pg_restore: error: could not read <hidden> injected OK line'),
      @('PostgreSQL 17 says: database postgres is not accepting connections', 'PostgreSQL 17 says: database <hidden> is not accepting connections')
    )
    foreach ($case in $cases) { Assert-Equal (Get-OmSafeReason -Text $case[0] -Hide $hide) $case[1] }
    foreach ($case in $cases) {
      $got = Get-OmSafeReason -Text $case[0] -Hide $hide
      Assert-True ($got -notmatch 'hunter|supabase|abcdefgh|Jane|52\.209|2a05|\|') "leak in: $got"
    }
    $long = Get-OmSafeReason -Text ('pg_dump: error: ' + ('x' * 500))
    Assert-Equal $long.Length 160
    Assert-True ($long.EndsWith('...'))
    Assert-Equal (Get-OmSafeReason -Text '') ''
    Assert-Equal (Get-OmSafeReason -Text $null) ''
    Assert-Equal (Get-OmSafeReason -Text "`r`n  `r`n") ''
  }
  Test-Case 'log: one line, with no host, user or password in it' {
    $line = Format-OmLogLine -Now (New-Object datetime 2026, 11, 19, 2, 0, 9) -Outcome 'OK' -FileName 'optimove-2026-11-19-0200.dump' -SizeBytes 123456 -TableCount 143 -Note 'sha256 abc'
    Assert-Equal $line '2026-11-19 02:00:09 | OK | optimove-2026-11-19-0200.dump | 123456 bytes | 143 tables | sha256 abc'
    Assert-Equal (Format-OmLogLine -Now (New-Object datetime 2026, 11, 19, 2, 0, 9) -Outcome 'FAILED' -Note 'while pg_dump') '2026-11-19 02:00:09 | FAILED | - | 0 bytes | 0 tables | while pg_dump'
  }
  Test-Case 'syntax: the three scripts parse, and use nothing newer than Windows PowerShell 5.1 syntax' {
    foreach ($name in @('OptimoveBackup.Common.ps1', 'optimove-backup.ps1', 'optimove-restore-test.ps1')) {
      $path = Join-Path $backupDir $name
      $tokens = $null; $errors = $null
      [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
      Assert-Equal @($errors).Count 0 "$name has parse errors:"
      $newer = @($tokens | Where-Object { @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr', 'QuestionMark') -contains [string]$_.Kind })
      Assert-Equal $newer.Count 0 "$name uses PowerShell 7 syntax:"
      $text = Get-Content -LiteralPath $path -Raw
      Assert-True ($text -notmatch '[^\x00-\x7F]') "$name has a non-ASCII character (Windows PowerShell 5.1 would misread a file without a BOM)"
    }
  }
  Test-Case 'the password is never a parameter of either script' {
    foreach ($name in @('optimove-backup.ps1', 'optimove-restore-test.ps1')) {
      $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $backupDir $name), [ref]$null, [ref]$null)
      $params = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
      Assert-True (@($params | Where-Object { $_ -match 'pass|pwd|secret|url|connection' }).Count -eq 0) "$name has a parameter that could carry a password: $($params -join ', ')"
    }
  }

  # ---------------------------------------------------------------- Part 2: a disposable local PostgreSQL

  if (-not $PgHost) {
    Write-Host 'skip - part 2 (the two scripts end to end): run with -PgHost to use a disposable local PostgreSQL'
  } else {
    if (-not (Test-OmLoopbackHost -HostName $PgHost)) { throw 'the tests use a local PostgreSQL only' }
    $testPassword = $env:OM_BACKUP_TEST_PGPASSWORD
    if (-not $testPassword) { throw 'set OM_BACKUP_TEST_PGPASSWORD to the password of the disposable local PostgreSQL' }
    $tools = Resolve-OmPgBin -PgBin $PgBin
    $shell = (Get-Process -Id $PID).Path
    $suffix = [guid]::NewGuid().ToString('N').Substring(0, 10)
    $sourceDb = "optimove_tests_backup_$suffix"
    # The scripts run as a role of their own with a password found nowhere else, so "the password is never
    # printed" is a real check. The role and the database are dropped at the end.
    $adminUser = $PgUser
    $adminPassword = ConvertTo-SecureString $testPassword -AsPlainText -Force
    $PgUser = "om_backup_test_$suffix"
    $testPassword = 'Pw-' + [guid]::NewGuid().ToString('N')
    function Invoke-AdminSql {
      param([string]$Sql)
      $r = Invoke-OmPgTool -Exe $tools.Psql -Password $adminPassword -Arguments (@('--no-psqlrc', '--quiet', '--set', 'ON_ERROR_STOP=1', '--command', $Sql) + (Get-OmConnectionArgs -HostName $PgHost -Port $PgPort -User $adminUser -Database 'postgres'))
      if ($r.ExitCode -ne 0) { throw "admin SQL failed: $($r.StdErr)" }
    }
    Invoke-AdminSql -Sql "create role `"$PgUser`" login superuser password '$testPassword'"

    # The scripts read %APPDATA%\postgresql\pgpass.conf and %APPDATA%\OptiMove\<config>: a private APPDATA for the tests.
    $appData = New-TempFolder 'appdata'
    $savedAppData = $env:APPDATA
    $env:APPDATA = $appData
    $pgPass = Join-Path (New-TempFolder 'appdata/postgresql') 'pgpass.conf'
    function Set-TestPgPass {
      param([string]$Password)
      Set-Content -LiteralPath $pgPass -Value "${PgHost}:${PgPort}:*:${PgUser}:$Password" -Encoding ASCII
      if ($env:OS -ne 'Windows_NT') { & chmod 600 $pgPass }
    }
    Set-TestPgPass -Password $testPassword
    $backups = New-TempFolder 'backups'
    $configPath = Join-Path (New-TempFolder 'appdata/OptiMove') 'optimove-backup.local.conf'
    function Set-TestConfig {
      param([string]$Database = $sourceDb, [string[]]$Extra = @())
      Set-Content -LiteralPath $configPath -Encoding ASCII -Value (@("host = $PgHost", "port = $PgPort", "database = $Database", "user = $PgUser", "backup_folder = $backups", "pg_bin = $($tools.Folder)") + $Extra)
    }
    function Invoke-TestSql {
      param([string]$Database, [string]$Sql)
      $r = Invoke-OmPgTool -Exe $tools.Psql -PgPassFile $pgPass -Arguments (@('--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', $Sql) + (Get-OmConnectionArgs -HostName $PgHost -Port $PgPort -User $PgUser -Database $Database))
      if ($r.ExitCode -ne 0) { throw "test SQL failed: $($r.StdErr)" }
      return $r.StdOut.Trim()
    }
    function Invoke-Script {
      param([string]$Name, [string[]]$Arguments)
      $output = & $shell -NoProfile -NonInteractive -File (Join-Path $backupDir $Name) @Arguments 2>&1 | Out-String
      return @{ ExitCode = $LASTEXITCODE; Output = $output }
    }
    # The lock file stays in the folder between runs (only an open handle on it is a lock); it is checked by its own tests.
    function Get-BackupFiles { return @(Get-ChildItem -LiteralPath $backups -File | ForEach-Object { $_.Name } | Where-Object { $_ -ne 'optimove-backup.lock' } | Sort-Object) }
    function Get-RestoreDatabases { return (Invoke-TestSql -Database 'postgres' -Sql "select count(*) from pg_database where datname like 'optimove\_restore\_test\_%'") }
    function Clear-Backups { Get-ChildItem -LiteralPath $backups -File | Remove-Item -Force }
    # A folder of tools where one of them is replaced by a stand-in.
    function New-ToolFolder {
      param([string]$Name, [hashtable]$StandIns)
      $folder = New-TempFolder "tools-$Name"
      foreach ($tool in @('pg_dump', 'pg_restore', 'psql')) {
        $target = Join-Path $folder $tool
        if ($StandIns.ContainsKey($tool)) { Set-Content -LiteralPath $target -Value @('#!/bin/sh', $StandIns[$tool]) -Encoding ASCII }
        else { Set-Content -LiteralPath $target -Value @('#!/bin/sh', ('exec "' + (Join-Path $tools.Folder $tool) + '" "$@"')) -Encoding ASCII }
        & chmod 755 $target
      }
      return $folder
    }

    try {
      Invoke-TestSql -Database 'postgres' -Sql "create database `"$sourceDb`" template template0 encoding 'UTF8'" | Out-Null
      $setup = @(
        'create schema calendar; create schema library; create schema media; create schema plans; create schema tests; create schema training; create schema training_load;',
        'create table public.schema_migrations (migration_name text primary key, applied_at timestamptz not null default now());',
        "insert into public.schema_migrations values ('0001_first.sql', now() - interval '2 days'), ('0074_latest.sql', now() - interval '1 day');",
        'create table public.clubs (id int primary key, name text); insert into public.clubs values (1, $$Test Club$$);',
        'create table public.teams (id int primary key, club_id int references public.clubs(id)); insert into public.teams values (1, 1), (2, 1);',
        'create table public.users (id int primary key, email text); insert into public.users select g, $$user$$ || g || $$@example.test$$ from generate_series(1, 7) g;',
        'create table public.athletes (id int primary key, team_id int references public.teams(id)); insert into public.athletes select g, 1 from generate_series(1, 5) g;',
        'create table library.exercises (id int primary key, name text); insert into library.exercises select g, $$Exercise $$ || g from generate_series(1, 11) g;',
        'create table plans.plans (id int primary key); insert into plans.plans values (1), (2), (3);',
        'create table training.activity_participants (id int primary key, athlete_id int references public.athletes(id)); insert into training.activity_participants select g, 1 from generate_series(1, 4) g;',
        'create table calendar.events (id int primary key); create table media.assets (id int primary key); create table tests.results (id int primary key); create table training_load.measurements (id int primary key);',
        'create view plans.v_plan_summary as select count(*) as n from plans.plans;'
      ) -join ' '
      Invoke-TestSql -Database $sourceDb -Sql $setup | Out-Null
      Set-TestConfig

      $script:goodDump = ''
      Test-Case 'backup: a run writes the dump, its sha256 and an OK log line, says where it goes, and deletes only expired backups' {
        Clear-Backups
        foreach ($name in @('optimove-2020-01-01-0200.dump', 'optimove-2020-01-01-0200.dump.sha256', 'optimove-2020-01-02-0200.dump.failed', 'optimove-production-2020-01-01.dump', 'keep.txt')) { Set-Content -LiteralPath (Join-Path $backups $name) -Value 'x' }
        $recent = New-OmDumpFileName -Now (Get-Date).AddDays(-3)
        Set-Content -LiteralPath (Join-Path $backups $recent) -Value 'x'
        $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt')
        Assert-Equal $run.ExitCode 0 "output: $($run.Output)"
        Assert-True ($run.Output -match "host:\s+$([regex]::Escape($PgHost))") 'the host is printed'
        Assert-True ($run.Output -match "port:\s+$PgPort") 'the port is printed'
        Assert-True ($run.Output -match "database:\s+$sourceDb") 'the database is printed'
        Assert-True ($run.Output -notmatch [regex]::Escape($testPassword)) 'the password is printed'
        $files = Get-BackupFiles
        $dump = @($files | Where-Object { $_ -match '^optimove-\d{4}-\d{2}-\d{2}-\d{6}\.dump$' -and $_ -ne $recent })
        Assert-Equal $dump.Count 1 "files: $($files -join ', ')"
        $script:goodDump = Join-Path $backups $dump[0]
        Assert-Equal ($files -join '|') ((@($dump[0], "$($dump[0]).sha256", $recent, 'keep.txt', 'optimove-backup.log', 'optimove-production-2020-01-01.dump') | Sort-Object) -join '|')
        $sha = (Get-Content -LiteralPath "$($script:goodDump).sha256" -TotalCount 1)
        Assert-Equal $sha ("{0}  {1}" -f (Get-OmSha256 -Path $script:goodDump), $dump[0])
        $log = @(Get-Content -LiteralPath (Join-Path $backups 'optimove-backup.log'))
        Assert-Equal $log.Count 1
        Assert-True ($log[0] -match "^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| OK \| $([regex]::Escape($dump[0])) \| $((Get-Item -LiteralPath $script:goodDump).Length) bytes \| 12 tables \| sha256 [0-9a-f]{64}$") "log line: $($log[0])"
        $list = Invoke-OmPgTool -Exe $tools.PgRestore -Arguments @('--list', $script:goodDump)
        Assert-Equal $list.ExitCode 0
        Assert-Equal (Get-OmTableCountFromList -ListText $list.StdOut) 12
      }
      Test-Case 'read-only fence: a session opened with -ReadOnly cannot write; without it the same statement works' {
        $arguments = { param($sql) @('--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', $sql) + (Get-OmConnectionArgs -HostName $PgHost -Port $PgPort -User $PgUser -Database $sourceDb) }
        $r = Invoke-OmPgTool -Exe $tools.Psql -PgPassFile $pgPass -ReadOnly -Arguments (& $arguments 'show default_transaction_read_only')
        Assert-Equal $r.StdOut.Trim() 'on'
        $r = Invoke-OmPgTool -Exe $tools.Psql -PgPassFile $pgPass -ReadOnly -Arguments (& $arguments 'create table public.fence_probe (id int)')
        Assert-True ($r.ExitCode -ne 0 -and $r.StdErr -match 'read-only transaction') "a write went through: $($r.StdErr)"
        $r = Invoke-OmPgTool -Exe $tools.Psql -PgPassFile $pgPass -ReadOnly -Arguments (& $arguments 'delete from public.users')
        Assert-True ($r.ExitCode -ne 0 -and $r.StdErr -match 'read-only transaction') "a delete went through: $($r.StdErr)"
        Assert-Equal (Invoke-TestSql -Database $sourceDb -Sql 'select count(*) from public.users') '7'
        $r = Invoke-OmPgTool -Exe $tools.Psql -PgPassFile $pgPass -Arguments (& $arguments 'create table public.fence_probe (id int); drop table public.fence_probe')
        Assert-Equal $r.ExitCode 0 'the probe itself is wrong:'
      }
      Test-Case 'backup: a wrong password fails the run, writes no dump, logs FAILED and deletes nothing' {
        Clear-Backups
        Set-Content -LiteralPath (Join-Path $backups 'optimove-2020-01-01-0200.dump') -Value 'x'
        Set-TestPgPass -Password 'certainly-not-the-password-4711'
        try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestPgPass -Password $testPassword }
        Assert-Equal $run.ExitCode 1 "output: $($run.Output)"
        Assert-True ($run.Output -match 'FAILED while connecting to the database')
        Assert-True ($run.Output -notmatch 'certainly-not-the-password-4711') 'the password is printed'
        Assert-Equal ((Get-BackupFiles) -join '|') 'optimove-2020-01-01-0200.dump|optimove-backup.log'
        $log = @(Get-Content -LiteralPath (Join-Path $backups 'optimove-backup.log'))
        Assert-True ($log[-1] -match '\| FAILED \| - \| 0 bytes \| 0 tables \| while connecting to the database: psql: error: connection to server at <hidden> \(<hidden>\), port \d+ failed: FATAL: password authentication failed for user <hidden>$') "log line: $($log[-1])"
        Assert-True ($log[-1] -notmatch [regex]::Escape($PgUser) -and $log[-1] -notmatch 'localhost|127\.0\.0\.1|certainly-not') "the log line names the server or the user: $($log[-1])"
      }
      Test-Case 'backup: without a pgpass line -NoPrompt fails instead of waiting for a password' {
        Clear-Backups
        Set-Content -LiteralPath $pgPass -Value '# empty' -Encoding ASCII
        try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestPgPass -Password $testPassword }
        Assert-Equal $run.ExitCode 1
        Assert-True ($run.Output -match 'forbids asking')
        Assert-Equal (@(Get-BackupFiles | Where-Object { $_ -match '\.dump' }).Count) 0
      }
      Test-Case 'backup: a schema nobody has looked at stops the run before anything is dumped; skip_schemas lets it through' {
        Clear-Backups
        Invoke-TestSql -Database $sourceDb -Sql 'create schema new_module; create table new_module.things (id int)' | Out-Null
        try {
          $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt')
          Assert-Equal $run.ExitCode 1
          Assert-True ($run.Output -match 'has schema new_module')
          Assert-Equal (@(Get-BackupFiles | Where-Object { $_ -match '\.dump' }).Count) 0
          Set-TestConfig -Extra @('skip_schemas = new_module')
          Clear-Backups
          $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt')
          Assert-Equal $run.ExitCode 0 "output: $($run.Output)"
        } finally {
          Invoke-TestSql -Database $sourceDb -Sql 'drop schema new_module cascade' | Out-Null
          Set-TestConfig
        }
      }
      Test-Case 'backup: a database without the application schemas is refused (the wrong database)' {
        Clear-Backups
        Set-TestConfig -Database 'postgres'
        try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
        Assert-Equal $run.ExitCode 1
        Assert-True ($run.Output -match 'has no schema calendar')
        Assert-Equal (@(Get-BackupFiles | Where-Object { $_ -match '\.dump' }).Count) 0
      }
      Test-Case 'backup: a password in the config file stops the run before any connection' {
        Clear-Backups
        Set-TestConfig -Extra @('password = hunter2-in-the-file')
        try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
        Assert-Equal $run.ExitCode 1
        Assert-True ($run.Output -match 'holds a password')
        Assert-True ($run.Output -notmatch 'hunter2-in-the-file') 'the password is printed'
        Assert-Equal @(Get-BackupFiles).Count 0 'nothing is written, not even a log line that could be taken for a run'
      }
      if ($env:OS -eq 'Windows_NT') {
        Write-Host 'skip - the stand-in tool tests (they use sh scripts)'
      } else {
        Test-Case 'backup: a pg_dump older than the server is refused before anything is dumped' {
          Clear-Backups
          $folder = New-ToolFolder 'old' @{ pg_dump = 'echo "pg_dump (PostgreSQL) 9.6.24"'; pg_restore = 'echo "pg_restore (PostgreSQL) 9.6.24"' }
          Set-TestConfig -Extra @()
          (Get-Content -LiteralPath $configPath) -replace '^pg_bin = .*$', "pg_bin = $folder" | Set-Content -LiteralPath $configPath -Encoding ASCII
          try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
          Assert-Equal $run.ExitCode 1 "output: $($run.Output)"
          Assert-True ($run.Output -match 'pg_dump is version 9 and the server is PostgreSQL \d+')
          Assert-Equal (@(Get-BackupFiles | Where-Object { $_ -match '\.dump' }).Count) 0
        }
        Test-Case 'backup: a dump that cannot be read back is renamed .failed, the run fails, and no old backup is deleted' {
          Clear-Backups
          Set-Content -LiteralPath (Join-Path $backups 'optimove-2020-01-01-0200.dump') -Value 'x'
          $real = Join-Path $tools.Folder 'pg_restore'
          $folder = New-ToolFolder 'badlist' @{ pg_restore = "case `"`$1`" in --list) echo 'pg_restore: error: input file does not appear to be a valid archive' >&2; exit 1;; esac; exec `"$real`" `"`$@`"" }
          (Get-Content -LiteralPath $configPath) -replace '^pg_bin = .*$', "pg_bin = $folder" | Set-Content -LiteralPath $configPath -Encoding ASCII
          try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
          Assert-Equal $run.ExitCode 1 "output: $($run.Output)"
          $files = Get-BackupFiles
          Assert-True ($files -contains 'optimove-2020-01-01-0200.dump') 'the old backup was deleted after a failed run'
          Assert-Equal (@($files | Where-Object { $_ -match '^optimove-\d{4}-\d{2}-\d{2}-\d{6}\.dump\.failed$' }).Count) 1 "files: $($files -join ', ')"
          Assert-Equal (@($files | Where-Object { $_ -match '\.dump$' -and $_ -ne 'optimove-2020-01-01-0200.dump' }).Count) 0 'a file that failed its check still carries the .dump name'
          Assert-Equal (@($files | Where-Object { $_ -match '\.sha256$' }).Count) 0
          Assert-True (@(Get-Content -LiteralPath (Join-Path $backups 'optimove-backup.log'))[-1] -match '\| FAILED \| optimove-.*\.dump \| 0 bytes \| 0 tables \| while pg_restore --list: pg_restore: error: input file does not appear to be a valid archive$')
        }
        Test-Case 'backup: a dump with an empty table of contents is FAILED' {
          Clear-Backups
          $real = Join-Path $tools.Folder 'pg_restore'
          $folder = New-ToolFolder 'emptylist' @{ pg_restore = "case `"`$1`" in --list) echo '; Archive created'; exit 0;; esac; exec `"$real`" `"`$@`"" }
          (Get-Content -LiteralPath $configPath) -replace '^pg_bin = .*$', "pg_bin = $folder" | Set-Content -LiteralPath $configPath -Encoding ASCII
          try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
          Assert-Equal $run.ExitCode 1
          Assert-True ($run.Output -match 'lists no tables')
          Assert-Equal (@(Get-BackupFiles | Where-Object { $_ -match '\.dump\.failed$' }).Count) 1
        }
        Test-Case 'backup: a pg_dump that fails half way leaves a .failed file, never a .dump' {
          Clear-Backups
          $folder = New-ToolFolder 'halfdump' @{ pg_dump = "case `"`$1`" in --version) exec `"$(Join-Path $tools.Folder 'pg_dump')`" --version;; esac; for a in `"`$@`"; do case `"`$a`" in --file=*) printf 'PGDMP-half' > `"`${a#--file=}`";; esac; done; echo 'pg_dump: error: connection lost' >&2; exit 1" }
          (Get-Content -LiteralPath $configPath) -replace '^pg_bin = .*$', "pg_bin = $folder" | Set-Content -LiteralPath $configPath -Encoding ASCII
          try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
          Assert-Equal $run.ExitCode 1
          Assert-True ($run.Output -match 'pg_dump ended with exit code 1')
          $files = Get-BackupFiles
          Assert-Equal (@($files | Where-Object { $_ -match '\.dump\.failed$' }).Count) 1 "files: $($files -join ', ')"
          Assert-Equal (@($files | Where-Object { $_ -match '\.dump$' }).Count) 0
        }
        Test-Case 'backup: psql and pg_dump reach the source through read-only sessions (PGOPTIONS), and the dump still works' {
          Clear-Backups
          $record = Join-Path (New-TempFolder 'record') 'options.txt'
          $folder = New-ToolFolder 'record' @{
            psql    = "echo `"psql `$PGOPTIONS`" >> `"$record`"; exec `"$(Join-Path $tools.Folder 'psql')`" `"`$@`""
            pg_dump = "case `"`$1`" in --version) ;; *) echo `"pg_dump `$PGOPTIONS`" >> `"$record`";; esac; exec `"$(Join-Path $tools.Folder 'pg_dump')`" `"`$@`""
            pg_restore = "echo `"pg_restore [`$PGOPTIONS]`" >> `"$record`"; exec `"$(Join-Path $tools.Folder 'pg_restore')`" `"`$@`""
          }
          (Get-Content -LiteralPath $configPath) -replace '^pg_bin = .*$', "pg_bin = $folder" | Set-Content -LiteralPath $configPath -Encoding ASCII
          try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
          Assert-Equal $run.ExitCode 0 "output: $($run.Output)"
          $lines = @(Get-Content -LiteralPath $record)
          Assert-Equal (@($lines | Where-Object { $_ -eq 'psql -c default_transaction_read_only=on' }).Count) 2 "recorded: $($lines -join ' / ')"
          Assert-Equal (@($lines | Where-Object { $_ -eq 'pg_dump -c default_transaction_read_only=on' }).Count) 1 "recorded: $($lines -join ' / ')"
          Assert-Equal (@($lines | Where-Object { $_ -like 'psql*' -or $_ -like 'pg_dump*' }).Count) 3 'a connection to the source without the fence'
        }
        Test-Case 'backup: a server that refuses the read-only setting gets one retry without it; the run says so on the screen and in the log, and ends OK' {
          Clear-Backups
          $record = Join-Path (New-TempFolder 'record-fallback') 'options.txt'
          $folder = New-ToolFolder 'refuse-options' @{
            psql    = "echo `"psql [`$PGOPTIONS]`" >> `"$record`"; if [ -n `"`$PGOPTIONS`" ]; then echo 'psql: error: FATAL:  unsupported startup parameter: options' >&2; exit 2; fi; exec `"$(Join-Path $tools.Folder 'psql')`" `"`$@`""
            pg_dump = "case `"`$1`" in --version) ;; *) echo `"pg_dump [`$PGOPTIONS]`" >> `"$record`"; if [ -n `"`$PGOPTIONS`" ]; then echo 'pg_dump: error: FATAL:  unsupported startup parameter: options' >&2; exit 1; fi;; esac; exec `"$(Join-Path $tools.Folder 'pg_dump')`" `"`$@`""
          }
          (Get-Content -LiteralPath $configPath) -replace '^pg_bin = .*$', "pg_bin = $folder" | Set-Content -LiteralPath $configPath -Encoding ASCII
          try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
          Assert-Equal $run.ExitCode 0 "output: $($run.Output)"
          Assert-True ($run.Output -match 'NOTE:\s+Read-only setting not accepted by the server; continuing without it\. The backup only reads\.') "output: $($run.Output)"
          Assert-True ($run.Output -match 'OK: optimove-')
          $lines = @(Get-Content -LiteralPath $record)
          Assert-Equal ($lines -join ' / ') 'psql [-c default_transaction_read_only=on] / psql [] / psql [] / pg_dump []' 'the order of the connections:'
          $log = @(Get-Content -LiteralPath (Join-Path $backups 'optimove-backup.log'))
          Assert-Equal $log.Count 2 "log: $($log -join ' / ')"
          Assert-True ($log[0] -match '\| NOTE \| - \| 0 bytes \| 0 tables \| Read-only setting not accepted by the server; continuing without it\. The backup only reads\.$') "log: $($log[0])"
          Assert-True ($log[1] -match '\| OK \| optimove-') "log: $($log[1])"
          Assert-Equal (@(Get-BackupFiles | Where-Object { $_ -match '\.dump$' }).Count) 1
        }
        Test-Case 'backup: no fallback for any other reason: a later connection that fails with the setting on fails the run' {
          Clear-Backups
          $record = Join-Path (New-TempFolder 'record-later') 'options.txt'
          $folder = New-ToolFolder 'dump-refuses' @{
            pg_dump = "case `"`$1`" in --version) exec `"$(Join-Path $tools.Folder 'pg_dump')`" --version;; esac; echo `"pg_dump [`$PGOPTIONS]`" >> `"$record`"; echo 'pg_dump: error: connection failed' >&2; exit 1"
          }
          (Get-Content -LiteralPath $configPath) -replace '^pg_bin = .*$', "pg_bin = $folder" | Set-Content -LiteralPath $configPath -Encoding ASCII
          try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
          Assert-Equal $run.ExitCode 1
          Assert-True ($run.Output -notmatch 'Read-only setting not accepted') 'it fell back'
          Assert-Equal (@(Get-Content -LiteralPath $record) -join ' / ') 'pg_dump [-c default_transaction_read_only=on]' 'pg_dump was tried again, or without the fence:'
          Assert-True ((@(Get-Content -LiteralPath (Join-Path $backups 'optimove-backup.log')) -join ' / ') -notmatch 'NOTE')
        }
        Test-Case 'backup: a wrong password is still a connection failure after the retry, with no note about the read-only setting' {
          Clear-Backups
          $record = Join-Path (New-TempFolder 'record-wrongpw') 'options.txt'
          $folder = New-ToolFolder 'count-psql' @{ psql = "echo `"psql [`$PGOPTIONS]`" >> `"$record`"; exec `"$(Join-Path $tools.Folder 'psql')`" `"`$@`"" }
          (Get-Content -LiteralPath $configPath) -replace '^pg_bin = .*$', "pg_bin = $folder" | Set-Content -LiteralPath $configPath -Encoding ASCII
          Set-TestPgPass -Password 'certainly-not-the-password-4711'
          try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestPgPass -Password $testPassword; Set-TestConfig }
          Assert-Equal $run.ExitCode 1
          Assert-True ($run.Output -match 'FAILED while connecting to the database')
          Assert-True ($run.Output -notmatch 'Read-only setting not accepted') 'a wrong password was reported as a refused setting'
          Assert-Equal (@(Get-Content -LiteralPath $record) -join ' / ') 'psql [-c default_transaction_read_only=on] / psql []'
          $log = @(Get-Content -LiteralPath (Join-Path $backups 'optimove-backup.log'))
          Assert-Equal $log.Count 1
          Assert-True ($log[0] -match '\| FAILED \|')
        }
        Test-Case 'backup: a libpq variable left in the shell does not redirect the tools' {
          Clear-Backups
          $env:PGHOST = 'pghost.invalid'; $env:PGHOSTADDR = '203.0.113.9'; $env:PGDATABASE = 'elsewhere'; $env:PGSERVICE = 'nope'; $env:PGPASSWORD = 'wrong-from-the-shell'
          try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') }
          finally { foreach ($v in @('PGHOST', 'PGHOSTADDR', 'PGDATABASE', 'PGSERVICE', 'PGPASSWORD')) { Remove-Item -Path "Env:$v" -ErrorAction SilentlyContinue } }
          Assert-Equal $run.ExitCode 0 "output: $($run.Output)"
        }
      }
      Test-Case 'backup: a second run started while the first is running stops with exit code 2, says so, logs it, and the first ends OK untouched' {
        if ($env:OS -eq 'Windows_NT') { Write-Host '       (not run on Windows: it uses an sh stand-in)'; return }
        Clear-Backups
        $marker = Join-Path (New-TempFolder 'slow') 'dump-started'
        $folder = New-ToolFolder 'slow' @{ pg_dump = "case `"`$1`" in --version) ;; *) touch `"$marker`"; sleep 6;; esac; exec `"$(Join-Path $tools.Folder 'pg_dump')`" `"`$@`"" }
        (Get-Content -LiteralPath $configPath) -replace '^pg_bin = .*$', "pg_bin = $folder" | Set-Content -LiteralPath $configPath -Encoding ASCII
        $firstOut = Join-Path $tempRoot 'first-run.txt'
        try {
          $first = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-NonInteractive', '-File', (Join-Path $backupDir 'optimove-backup.ps1'), '-NoPrompt') -RedirectStandardOutput $firstOut -PassThru
          $waited = 0
          while (-not (Test-Path -LiteralPath $marker) -and $waited -lt 300) { Start-Sleep -Milliseconds 100; $waited++ }
          Assert-True (Test-Path -LiteralPath $marker) 'the first run never reached pg_dump'
          $during = Get-BackupFiles
          $second = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt')
          $third = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt')
          Assert-True (-not $first.HasExited) 'the first run had already ended; the test proved nothing'
          Assert-Equal $second.ExitCode 2 "output: $($second.Output)"
          Assert-Equal $third.ExitCode 2
          Assert-True ($second.Output -match 'Another backup is already running; this one stops\.')
          Assert-True ($second.Output -notmatch 'FAILED|renamed|Dumping') "the second run went on: $($second.Output)"
          Assert-Equal ((Get-BackupFiles) -join '|') ((@($during) + 'optimove-backup.log' | Sort-Object -Unique) -join '|') 'the second run created, renamed or removed a file:'
          $first.WaitForExit()
          Assert-Equal $first.ExitCode 0 "first run: $(Get-Content -LiteralPath $firstOut -Raw)"
        } finally { Set-TestConfig; if ($first -and -not $first.HasExited) { $first.Kill() } }
        $files = Get-BackupFiles
        Assert-Equal (@($files | Where-Object { $_ -match '\.dump$' }).Count) 1 "files: $($files -join ', ')"
        Assert-Equal (@($files | Where-Object { $_ -match '\.failed$' }).Count) 0 "files: $($files -join ', ')"
        $dump = Join-Path $backups (@($files | Where-Object { $_ -match '\.dump$' })[0])
        Assert-Equal ((Get-Content -LiteralPath "$dump.sha256" -TotalCount 1) -split '\s+')[0] (Get-OmSha256 -Path $dump)
        $log = @(Get-Content -LiteralPath (Join-Path $backups 'optimove-backup.log'))
        Assert-Equal $log.Count 3 "log: $($log -join ' / ')"
        Assert-True ($log[0] -match '\| SKIPPED \| - \| 0 bytes \| 0 tables \| Another backup is already running; this one stops\.$') "log: $($log[0])"
        Assert-True ($log[1] -match '\| SKIPPED \|')
        Assert-True ($log[2] -match '\| OK \| optimove-') "log: $($log[2])"
        $after = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt')
        Assert-Equal $after.ExitCode 0 "the lock was not released: $($after.Output)"
      }
      Test-Case 'backup: a lock file left behind by a crash does not block the next run' {
        Clear-Backups
        Set-Content -LiteralPath (Join-Path $backups 'optimove-backup.lock') -Value 'stale'
        $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt')
        Assert-Equal $run.ExitCode 0 "output: $($run.Output)"
      }
      Test-Case 'backup: a pg_dump failure is logged with its own first error line, sanitized' {
        if ($env:OS -eq 'Windows_NT') { Write-Host '       (not run on Windows: it uses an sh stand-in)'; return }
        Clear-Backups
        $folder = New-ToolFolder 'dump-says-why' @{ pg_dump = "case `"`$1`" in --version) exec `"$(Join-Path $tools.Folder 'pg_dump')`" --version;; esac; echo 'pg_dump: error: connection to server at `"$PgHost`" (127.0.0.1), port $PgPort failed: FATAL:  remaining connection slots are reserved for user `"$PgUser`"' >&2; echo 'pg_dump: detail: second line password=hunter2' >&2; exit 1" }
        (Get-Content -LiteralPath $configPath) -replace '^pg_bin = .*$', "pg_bin = $folder" | Set-Content -LiteralPath $configPath -Encoding ASCII
        try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
        Assert-Equal $run.ExitCode 1
        $log = @(Get-Content -LiteralPath (Join-Path $backups 'optimove-backup.log'))
        Assert-True ($log[-1] -match '\| FAILED \| optimove-\d{4}-\d{2}-\d{2}-\d{6}\.dump \| 0 bytes \| 0 tables \| while pg_dump: pg_dump: error: connection to server at <hidden> \(<hidden>\), port \d+ failed: FATAL: remaining connection slots are reserved for user <hidden>$') "log: $($log[-1])"
        Assert-True ($log[-1] -notmatch [regex]::Escape($PgUser) -and $log[-1] -notmatch 'hunter2|127\.0\.0\.1|localhost') "log: $($log[-1])"
      }
      Test-Case 'backup: a refusal of the script itself is logged with its reason, without the folder path' {
        Clear-Backups
        Invoke-TestSql -Database $sourceDb -Sql 'create schema new_module' | Out-Null
        try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Invoke-TestSql -Database $sourceDb -Sql 'drop schema new_module' | Out-Null }
        Assert-Equal $run.ExitCode 1
        $log = @(Get-Content -LiteralPath (Join-Path $backups 'optimove-backup.log'))
        Assert-True ($log[-1] -match '\| FAILED \| - \| 0 bytes \| 0 tables \| while checking the schemas: refusing: the database has schema new_module, which this backup does not know\.') "log: $($log[-1])"
        Assert-True ($log[-1] -notmatch [regex]::Escape($backups)) 'the folder is in the log'
      }
      Test-Case 'backup: a backup folder inside a git repository is refused' {
        $repo = New-TempFolder 'repo-with-backups'
        [void](New-Item -ItemType Directory -Path (Join-Path $repo '.git') -Force)
        (Get-Content -LiteralPath $configPath) -replace '^backup_folder = .*$', "backup_folder = $repo" | Set-Content -LiteralPath $configPath -Encoding ASCII
        try { $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt') } finally { Set-TestConfig }
        Assert-Equal $run.ExitCode 1
        Assert-True ($run.Output -match 'inside a git repository')
        Assert-Equal @(Get-ChildItem -LiteralPath $repo -File).Count 0
      }

      # A fresh good dump for the restore tests.
      Clear-Backups
      $run = Invoke-Script 'optimove-backup.ps1' @('-NoPrompt')
      if ($run.ExitCode -ne 0) { throw "the backup for the restore tests failed: $($run.Output)" }
      $script:goodDump = Join-Path $backups (@(Get-BackupFiles | Where-Object { $_ -match '\.dump$' })[0])
      $restoreArgs = @('-HostName', $PgHost, '-Port', [string]$PgPort, '-User', $PgUser, '-PgBin', $tools.Folder, '-NoPrompt')

      Test-Case 'restore test: restores into a new throwaway database, prints the counts and the last migration, and drops it' {
        $run = Invoke-Script 'optimove-restore-test.ps1' (@('-DumpPath', $script:goodDump) + $restoreArgs)
        Assert-Equal $run.ExitCode 0 "output: $($run.Output)"
        Assert-True ($run.Output -match 'new database: optimove_restore_test_\d{8}_\d{6}')
        Assert-True ($run.Output -match "host:\s+$([regex]::Escape($PgHost))")
        Assert-True ($run.Output -match 'sha256:\s+matches')
        Assert-True ($run.Output -match 'tables: 12 restored, 12 in the backup file')
        foreach ($expected in @('public.users: 7', 'public.clubs: 1', 'public.teams: 2', 'public.athletes: 5', 'library.exercises: 11', 'plans.plans: 3', 'training.activity_participants: 4')) {
          Assert-True ($run.Output -match [regex]::Escape("rows in $expected")) "missing '$expected' in: $($run.Output)"
        }
        Assert-True ($run.Output -match 'last migration: 0074_latest\.sql')
        Assert-True ($run.Output -match 'dropped optimove_restore_test_\d{8}_\d{6}')
        Assert-True ($run.Output -match 'RESTORE TEST OK')
        Assert-True ($run.Output -notmatch [regex]::Escape($testPassword)) 'the password is printed'
        Assert-Equal (Get-RestoreDatabases) '0' 'a throwaway database was left behind:'
      }
      Test-Case 'restore test: any host that is not this computer is refused, before any connection' {
        foreach ($remote in @('db.example.test', '10.0.0.5', 'aws-0-eu-central-1.pooler.supabase.com', '127.0.0.1.example.test')) {
          $run = Invoke-Script 'optimove-restore-test.ps1' @('-DumpPath', $script:goodDump, '-HostName', $remote, '-Port', [string]$PgPort, '-User', $PgUser, '-PgBin', $tools.Folder, '-NoPrompt')
          Assert-Equal $run.ExitCode 1 "$remote was accepted"
          Assert-True ($run.Output -match 'runs on this computer only') "output for ${remote}: $($run.Output)"
          Assert-True ($run.Output -notmatch 'new database:') 'it went past the guard'
        }
        Assert-Equal (Get-RestoreDatabases) '0'
      }
      Test-Case 'restore test: a file that no longer matches its sha256 fails, and no database is created' {
        $copy = Join-Path (New-TempFolder 'tampered') 'optimove-2026-01-01-0200.dump'
        Copy-Item -LiteralPath $script:goodDump -Destination $copy
        Copy-Item -LiteralPath "$($script:goodDump).sha256" -Destination "$copy.sha256"
        Add-Content -LiteralPath $copy -Value 'tampered'
        $run = Invoke-Script 'optimove-restore-test.ps1' (@('-DumpPath', $copy) + $restoreArgs)
        Assert-Equal $run.ExitCode 1
        Assert-True ($run.Output -match 'does not match its \.sha256')
        Assert-True ($run.Output -notmatch 'dropped optimove_restore_test') 'nothing should have been created'
        Assert-Equal (Get-RestoreDatabases) '0'
      }
      Test-Case 'restore test: a cut-off backup file fails, and leaves no database behind' {
        $cut = Join-Path (New-TempFolder 'cut') 'optimove-2026-01-02-0200.dump'
        $bytes = [System.IO.File]::ReadAllBytes($script:goodDump)
        [System.IO.File]::WriteAllBytes($cut, $bytes[0..([int]($bytes.Length * 0.7))])
        $run = Invoke-Script 'optimove-restore-test.ps1' (@('-DumpPath', $cut) + $restoreArgs)
        Assert-Equal $run.ExitCode 1 "output: $($run.Output)"
        Assert-True ($run.Output -match 'RESTORE TEST FAILED')
        Assert-Equal (Get-RestoreDatabases) '0' 'a throwaway database was left behind:'
      }
      Test-Case 'restore test: a .failed file and a missing file are refused' {
        $failedFile = Join-Path (New-TempFolder 'failedfile') 'optimove-2026-01-03-0200.dump.failed'
        Copy-Item -LiteralPath $script:goodDump -Destination $failedFile
        $run = Invoke-Script 'optimove-restore-test.ps1' (@('-DumpPath', $failedFile) + $restoreArgs)
        Assert-Equal $run.ExitCode 1
        Assert-True ($run.Output -match 'is not a backup')
        $run = Invoke-Script 'optimove-restore-test.ps1' (@('-DumpPath', (Join-Path $tempRoot 'no-such.dump')) + $restoreArgs)
        Assert-Equal $run.ExitCode 1
        Assert-True ($run.Output -match 'was not found')
      }
      Test-Case 'restore test: a wrong local password fails without creating anything' {
        Set-TestPgPass -Password 'certainly-not-the-password-4711'
        try { $run = Invoke-Script 'optimove-restore-test.ps1' (@('-DumpPath', $script:goodDump) + $restoreArgs) } finally { Set-TestPgPass -Password $testPassword }
        Assert-Equal $run.ExitCode 1
        Assert-True ($run.Output -match 'could not be reached')
        Assert-True ($run.Output -notmatch 'certainly-not-the-password-4711')
        Assert-Equal (Get-RestoreDatabases) '0'
      }
      Test-Case 'restore test: the source database was only read (its rows are as before)' {
        Assert-Equal (Invoke-TestSql -Database $sourceDb -Sql 'select (select count(*) from public.users) || $$/$$ || (select count(*) from library.exercises)') '7/11'
      }
    }
    finally {
      $env:APPDATA = $savedAppData
      try {
        Invoke-AdminSql -Sql "drop database if exists `"$sourceDb`""
        Invoke-AdminSql -Sql "drop role if exists `"$PgUser`""
      } catch { Write-Host "WARNING: the test database $sourceDb or the test role $PgUser could not be dropped: $($_.Exception.Message)" }
    }
  }
}
finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "passed $($script:passed), failed $($script:failed)"
if ($script:failed -gt 0) { exit 1 }
exit 0
