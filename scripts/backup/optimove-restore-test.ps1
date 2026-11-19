<#
.SYNOPSIS
  Trial restore of an OptiMove backup into a NEW throwaway database on this computer, a few row counts,
  then the throwaway database is dropped.

.DESCRIPTION
  Runbook, step by step: docs/runbooks/production-manual-backup.md

  It works on this computer only (localhost). It creates optimove_restore_test_<timestamp>, restores the dump
  into it, prints the row counts of a few key tables and the last migration name, and drops that database.
  It never connects to the OPTIMOVE development database and never to production.

.PARAMETER DumpPath
  The backup file to test.

.PARAMETER HostName
  Must be this computer: localhost, 127.0.0.1 or ::1. Anything else is refused.

.PARAMETER Port
  The local PostgreSQL port (5432, or 5433 when the installer chose another one).

.PARAMETER User
  The local PostgreSQL user (postgres).

.PARAMETER PgBin
  The folder that holds pg_restore.exe, when it is not found by itself.

.PARAMETER NoPrompt
  Never ask for the password: without a pgpass line the run fails instead of waiting.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DumpPath,
  [string]$HostName = 'localhost',
  [int]$Port = 5432,
  [string]$User = 'postgres',
  [string]$PgBin = '',
  [switch]$NoPrompt
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'OptimoveBackup.Common.ps1')

# The maintenance database: the server's own "postgres". It is only connected to, to create and drop the
# throwaway database; nothing in it is read or changed.
$maintenanceDb = 'postgres'
$keyTables = @('public.users', 'public.clubs', 'public.teams', 'public.athletes', 'library.exercises', 'plans.plans', 'training.activity_participants')
$restoreDb = ''
$created = $false
$tools = $null
$connection = $null
$step = 'checking the arguments'
$exitCode = 1

function Invoke-Sql {
  param([string]$Database, [string]$Sql)
  $arguments = @('--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', $Sql) + (Get-OmConnectionArgs -HostName $HostName -Port $Port -User $User -Database $Database)
  return (Invoke-OmPgTool -Exe $tools.Psql -Arguments $arguments @connection)
}

try {
  if (-not (Test-OmLoopbackHost -HostName $HostName)) { throw "refusing: the restore test runs on this computer only (localhost). '$HostName' is not this computer." }
  if ($Port -lt 1 -or $Port -gt 65535) { throw 'refusing: the port is not a number between 1 and 65535' }
  if ($User -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') { throw 'refusing: the user name has characters that are not allowed' }
  if (-not (Test-Path -LiteralPath $DumpPath -PathType Leaf)) { throw "refusing: the backup file was not found: $DumpPath" }
  $DumpPath = (Resolve-Path -LiteralPath $DumpPath).ProviderPath
  if ($DumpPath -match '\.failed$') { throw 'refusing: a .failed file is not a backup' }

  $restoreDb = New-OmRestoreDatabaseName -Now (Get-Date)
  if (-not (Test-OmRestoreDatabaseName -Name $restoreDb)) { throw 'refusing: the throwaway database name is not of the expected form' }

  Write-Host 'OptiMove restore test (this computer only)'
  Write-Host "  host:         $HostName"
  Write-Host "  port:         $Port"
  Write-Host "  new database: $restoreDb (created now, dropped at the end)"
  Write-Host ("  backup file:  " + [System.IO.Path]::GetFileName($DumpPath))

  $step = 'finding the PostgreSQL tools'
  $tools = Resolve-OmPgBin -PgBin $PgBin

  $step = 'checking the sha256'
  $hashFile = "$DumpPath.sha256"
  if (Test-Path -LiteralPath $hashFile -PathType Leaf) {
    $expected = ((Get-Content -LiteralPath $hashFile -TotalCount 1) -split '\s+')[0].ToLowerInvariant()
    $actual = Get-OmSha256 -Path $DumpPath
    if ($expected -ne $actual) { throw 'the file does not match its .sha256: it was changed or damaged after the backup' }
    Write-Host '  sha256:       matches'
  } else {
    Write-Host '  sha256:       no .sha256 file next to the backup, not checked'
  }

  $step = 'reading the backup file'
  $run = Invoke-OmPgTool -Exe $tools.PgRestore -Arguments @('--list', $DumpPath)
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw 'the backup file cannot be read (pg_restore --list failed)' }
  $tablesInDump = Get-OmTableCountFromList -ListText $run.StdOut
  if ($tablesInDump -lt 1) { throw 'the backup file lists no tables' }
  $dumpedFromMajor = Get-OmDumpServerMajorFromList -ListText $run.StdOut
  $dumpCreatesPublic = Test-OmDumpCreatesSchema -ListText $run.StdOut -Schema 'public'

  $step = 'reading the password source'
  $secret = Resolve-OmPassword -HostName $HostName -Port $Port -Database $maintenanceDb -User $User -PgPassPath (Get-OmDefaultPgPassPath) -NoPrompt:$NoPrompt -PromptText 'Local PostgreSQL password (only stars are shown while you type)'
  $connection = @{ Password = $secret.Password; PgPassFile = $secret.PgPassFile }

  $step = 'connecting to the local PostgreSQL'
  $run = Invoke-Sql -Database $maintenanceDb -Sql 'show server_version_num'
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw 'the local PostgreSQL could not be reached (is it running? right port and password?)' }
  $serverMajor = Get-OmServerMajorVersion -VersionNum $run.StdOut
  if ($dumpedFromMajor -gt 0 -and $serverMajor -lt $dumpedFromMajor) {
    throw "refusing: the backup comes from PostgreSQL $dumpedFromMajor and the local server is PostgreSQL $serverMajor. The local server must be the same version or newer."
  }

  $step = 'creating the throwaway database'
  $run = Invoke-Sql -Database $maintenanceDb -Sql "create database `"$restoreDb`" template template0 encoding 'UTF8'"
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw 'the throwaway database could not be created' }
  $created = $true

  # The backup carries its own CREATE SCHEMA public, and every new database already has an empty one:
  # the throwaway database's own (empty) public is dropped first, so the restore creates it again.
  if ($dumpCreatesPublic) {
    $step = 'preparing the throwaway database'
    if (-not (Test-OmRestoreDatabaseName -Name $restoreDb)) { throw 'refusing: the throwaway database name is not of the expected form' }
    $run = Invoke-Sql -Database $restoreDb -Sql "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'"
    if ($run.ExitCode -ne 0 -or $run.StdOut.Trim() -ne '0') { throw 'refusing: the new database is not empty' }
    $run = Invoke-Sql -Database $restoreDb -Sql 'drop schema public'
    if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw 'the throwaway database could not be prepared' }
  }

  $step = 'pg_restore'
  Write-Host 'Restoring ...'
  $run = Invoke-OmPgTool -Exe $tools.PgRestore -Arguments (Get-OmPgRestoreArgs -HostName $HostName -Port $Port -User $User -Database $restoreDb -DumpPath $DumpPath) @connection
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw "pg_restore ended with exit code $($run.ExitCode)" }

  $step = 'counting rows'
  $run = Invoke-Sql -Database $restoreDb -Sql "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')"
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw 'the restored tables could not be counted' }
  $tablesRestored = [int]$run.StdOut.Trim()
  Write-Host "  tables: $tablesRestored restored, $tablesInDump in the backup file"
  if ($tablesRestored -ne $tablesInDump) { throw 'the number of restored tables differs from the number in the backup file' }
  foreach ($table in $keyTables) {
    $run = Invoke-Sql -Database $restoreDb -Sql "select to_regclass('$table') is not null"
    if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw "table $table could not be looked up" }
    if ($run.StdOut.Trim() -ne 't') { throw "table $table is missing from the restored copy" }
    $run = Invoke-Sql -Database $restoreDb -Sql "select count(*) from $table"
    if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw "the rows of $table could not be counted" }
    Write-Host ("  rows in {0}: {1}" -f $table, $run.StdOut.Trim())
  }
  $run = Invoke-Sql -Database $restoreDb -Sql 'select migration_name from public.schema_migrations order by applied_at desc, migration_name desc limit 1'
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw 'the last migration name could not be read' }
  $lastMigration = $run.StdOut.Trim()
  if (-not $lastMigration) { throw 'the restored copy has no migration recorded' }
  Write-Host "  last migration: $lastMigration"

  $exitCode = 0
}
catch {
  Write-Host "RESTORE TEST FAILED while ${step}: $($_.Exception.Message)"
  $exitCode = 1
}
finally {
  # Only a database this run created, and only one with the throwaway name, is ever dropped.
  if ($created -and (Test-OmRestoreDatabaseName -Name $restoreDb)) {
    $drop = Invoke-Sql -Database $maintenanceDb -Sql "drop database if exists `"$restoreDb`""
    if ($drop.ExitCode -eq 0) { Write-Host "  dropped $restoreDb" }
    else {
      Write-Host "The throwaway database $restoreDb could NOT be dropped. Drop it by hand (pgAdmin: Databases, right click, Delete/Drop)."
      $exitCode = 1
    }
  }
}

if ($exitCode -eq 0) { Write-Host 'RESTORE TEST OK: the backup can be restored. Compare the numbers above with what you expect.' }
exit $exitCode
