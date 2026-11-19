<#
.SYNOPSIS
  Manual backup of the OptiMove database: pg_dump, a check that the file can be read, a sha256, one log line,
  and the deletion of backups older than the retention.

.DESCRIPTION
  Runbook, step by step: docs/runbooks/production-manual-backup.md

  It only READS the database. Host, port, database and user come from a small local config file outside the
  repository. The password is never a parameter: it is read by the PostgreSQL tools from pgpass.conf, or typed
  at a hidden prompt.

.PARAMETER ConfigPath
  The config file. Default: %APPDATA%\OptiMove\optimove-backup.local.conf

.PARAMETER RetentionDays
  Overrides retention_days of the config file (default 14).

.PARAMETER NoPrompt
  Never ask for the password (for Task Scheduler): without a pgpass line the run fails instead of waiting.
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = '',
  [int]$RetentionDays = 0,
  [switch]$NoPrompt
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'OptimoveBackup.Common.ps1')

$startedAt = Get-Date
$logPath = ''
$dumpPath = ''
$dumpName = '-'
$step = 'reading the config file'

function Write-RunLog {
  param([string]$Outcome, [long]$SizeBytes = 0, [int]$TableCount = 0, [string]$Note = '')
  if (-not $logPath) { return }
  $line = Format-OmLogLine -Now (Get-Date) -Outcome $Outcome -FileName $dumpName -SizeBytes $SizeBytes -TableCount $TableCount -Note $Note
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

try {
  if (-not $ConfigPath) { $ConfigPath = Get-OmDefaultConfigPath }
  $config = Read-OmBackupConfig -Path $ConfigPath
  if ($RetentionDays -lt 0) { throw 'refusing: -RetentionDays must be 1 or more' }
  if ($RetentionDays -gt 0) { $config['retention_days'] = $RetentionDays }

  $step = 'checking the backup folder'
  $folder = $config['backup_folder']
  if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw "refusing: the backup folder does not exist: $folder (create it once, by hand)" }
  $folder = (Resolve-Path -LiteralPath $folder).ProviderPath
  if (Test-OmInsideGitRepo -Path $folder) { throw 'refusing: the backup folder is inside a git repository; a backup is never kept in a checkout' }
  $logPath = Join-Path $folder 'optimove-backup.log'

  $hostName = $config['host']
  $port = $config['port']
  $database = $config['database']
  $user = $config['user']

  # Database-safety rule: say where the run goes before anything connects.
  Write-Host 'OptiMove backup (read only)'
  Write-Host "  host:     $hostName"
  Write-Host "  port:     $port"
  Write-Host "  database: $database"
  Write-Host "  folder:   $folder"
  Write-Host ("  keeps:    " + $config['retention_days'] + ' days')

  $step = 'checking the connection settings'
  Assert-OmNotTransactionPooler -HostName $hostName -Port $port
  $sslMode = ''
  $sslRootCert = ''
  if (-not (Test-OmLoopbackHost -HostName $hostName)) {
    if ($config['ssl_root_cert']) { $sslMode = 'verify-full'; $sslRootCert = $config['ssl_root_cert'] }
    else {
      $sslMode = 'require'
      Write-Host "  TLS:      encrypted, but the server's certificate is not checked (set ssl_root_cert to check it)"
    }
  }

  $step = 'finding the PostgreSQL tools'
  $tools = Resolve-OmPgBin -PgBin $config['pg_bin']
  $versionRun = Invoke-OmPgTool -Exe $tools.PgDump -Arguments @('--version')
  $dumpMajor = Get-OmToolMajorVersion -VersionText $versionRun.StdOut
  $versionRun = Invoke-OmPgTool -Exe $tools.PgRestore -Arguments @('--version')
  $restoreMajor = Get-OmToolMajorVersion -VersionText $versionRun.StdOut
  if ($restoreMajor -lt $dumpMajor) { throw "refusing: pg_restore ($restoreMajor) is older than pg_dump ($dumpMajor); use the tools of one PostgreSQL installation" }

  $step = 'reading the password source'
  $pgPassPath = Get-OmDefaultPgPassPath
  $secret = Resolve-OmPassword -HostName $hostName -Port $port -Database $database -User $user -PgPassPath $pgPassPath -NoPrompt:$NoPrompt -PromptText 'Database password (only stars are shown while you type)'
  $connection = @{ Password = $secret.Password; PgPassFile = $secret.PgPassFile; SslMode = $sslMode; SslRootCert = $sslRootCert }
  $connectionArgs = Get-OmConnectionArgs -HostName $hostName -Port $port -User $user -Database $database

  $step = 'connecting to the database'
  $run = Invoke-OmPgTool -Exe $tools.Psql -Arguments (@('--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'show server_version_num') + $connectionArgs) @connection
  if ($run.ExitCode -ne 0) {
    Write-Host $run.StdErr
    throw 'the database could not be reached (wrong password, host, port or user, or no network)'
  }
  $serverMajor = Get-OmServerMajorVersion -VersionNum $run.StdOut
  Write-Host "  server:   PostgreSQL $serverMajor, pg_dump $dumpMajor"
  Assert-OmToolNotOlderThanServer -ToolMajor $dumpMajor -ServerMajor $serverMajor

  $step = 'checking the schemas'
  $schemaQuery = "select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1"
  $run = Invoke-OmPgTool -Exe $tools.Psql -Arguments (@('--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', $schemaQuery) + $connectionArgs) @connection
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw 'the list of schemas could not be read' }
  $serverSchemas = @($run.StdOut -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  Test-OmSchemaList -ServerSchemas $serverSchemas -SkipSchemas $config['skip_schemas']

  $step = 'pg_dump'
  $dumpName = New-OmDumpFileName -Now $startedAt
  $dumpPath = Join-Path $folder $dumpName
  if (Test-Path -LiteralPath $dumpPath) { throw "refusing: $dumpName already exists; wait a minute and run again" }
  if (Test-Path -LiteralPath "$dumpPath.failed") { throw "refusing: $dumpName.failed already exists; wait a minute and run again" }
  Write-Host "Dumping to $dumpName ..."
  $run = Invoke-OmPgTool -Exe $tools.PgDump -Arguments (Get-OmPgDumpArgs -HostName $hostName -Port $port -User $user -Database $database -DumpPath $dumpPath) @connection
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw "pg_dump ended with exit code $($run.ExitCode)" }
  if (-not (Test-Path -LiteralPath $dumpPath -PathType Leaf)) { throw 'pg_dump wrote no file' }

  $step = 'pg_restore --list'
  $run = Invoke-OmPgTool -Exe $tools.PgRestore -Arguments @('--list', $dumpPath)
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; throw "the new file cannot be read back (pg_restore --list ended with exit code $($run.ExitCode))" }
  $tableCount = Get-OmTableCountFromList -ListText $run.StdOut
  if ($tableCount -lt 1) { throw 'the new file lists no tables' }

  $step = 'sha256'
  $size = (Get-Item -LiteralPath $dumpPath).Length
  $hash = Get-OmSha256 -Path $dumpPath
  Set-Content -LiteralPath "$dumpPath.sha256" -Value "$hash  $dumpName" -Encoding ASCII

  Write-RunLog -Outcome 'OK' -SizeBytes $size -TableCount $tableCount -Note "sha256 $hash"

  # Old backups go only now, after a new one has been written and read back.
  $step = 'deleting old backups'
  $expired = Get-OmExpiredBackupFiles -Folder $folder -RetentionDays $config['retention_days'] -Now $startedAt -KeepName $dumpName
  foreach ($file in $expired) {
    Remove-Item -LiteralPath $file.FullName -Force
    Write-Host "  deleted old backup file $($file.Name)"
  }

  Write-Host "OK: $dumpName, $size bytes, $tableCount tables"
  Write-Host "    sha256 $hash"
  exit 0
}
catch {
  $reason = $_.Exception.Message
  if ($dumpPath -and (Test-Path -LiteralPath $dumpPath -PathType Leaf)) {
    try {
      Move-Item -LiteralPath $dumpPath -Destination "$dumpPath.failed" -Force
      if (Test-Path -LiteralPath "$dumpPath.sha256") { Remove-Item -LiteralPath "$dumpPath.sha256" -Force }
      Write-Host "The file was renamed to $dumpName.failed. It is NOT a backup."
    } catch { Write-Host "The unfinished file $dumpName could not be renamed. It is NOT a backup: delete it." }
  }
  try { Write-RunLog -Outcome 'FAILED' -Note "while $step" } catch { }
  Write-Host "FAILED while ${step}: $reason"
  Write-Host 'No old backup was deleted. See "When a run says FAILED" in docs/runbooks/production-manual-backup.md'
  exit 1
}
