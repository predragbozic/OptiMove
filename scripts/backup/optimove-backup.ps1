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
$lock = $null
$toolError = ''
$hide = @()
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

  # One backup at a time. A second run stops here, before it could touch any file of the first one.
  $lock = Enter-OmBackupLock -Folder $folder
  if ($null -eq $lock) {
    $busy = 'Another backup is already running; this one stops.'
    Write-Host $busy
    # The running backup may be writing the log at this very moment: a failed write must not turn
    # this stop into a FAILED run.
    try { Write-RunLog -Outcome 'SKIPPED' -Note $busy } catch { Write-Host '(the log could not be written)' }
    exit 2
  }
  $hide = @($config['host'], $config['user'], $config['database'], $folder, $ConfigPath, $env:USERNAME, $env:USERPROFILE)

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
    if ($config['ssl_root_cert']) { $sslMode = 'verify-full'; $sslRootCert = $config['ssl_root_cert']; Write-Host '  TLS:      encrypted, and the server is verified with ssl_root_cert' }
    else {
      $sslMode = 'require'
      Write-Host "  TLS:      encrypted, but the server is NOT verified. Add ssl_root_cert to the config file (runbook, step 4)."
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
  # ReadOnly: psql and pg_dump open read-only sessions on the source (a second fence; the run only reads anyway).
  $connection = @{ Password = $secret.Password; PgPassFile = $secret.PgPassFile; SslMode = $sslMode; SslRootCert = $sslRootCert; ReadOnly = $true }
  $connectionArgs = Get-OmConnectionArgs -HostName $hostName -Port $port -User $user -Database $database

  $step = 'connecting to the database'
  $versionArgs = @('--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'show server_version_num') + $connectionArgs
  $run = Invoke-OmPgTool -Exe $tools.Psql -Arguments $versionArgs @connection
  if ($run.ExitCode -ne 0) {
    # Some poolers refuse the read-only start-up setting. Only here, on the first connection, the same
    # connection is tried once more without it. If that works, the whole run goes on without the setting,
    # and says so on the screen and in the log. If it fails too, it is a real connection failure.
    $connection['ReadOnly'] = $false
    $retry = Invoke-OmPgTool -Exe $tools.Psql -Arguments $versionArgs @connection
    if ($retry.ExitCode -ne 0) {
      Write-Host $retry.StdErr
      $toolError = $retry.StdErr
      throw 'the database could not be reached (wrong password, host, port or user, or no network)'
    }
    $run = $retry
    $fenceNote = 'Read-only setting not accepted by the server; continuing without it. The backup only reads.'
    Write-Host "  NOTE:     $fenceNote"
    Add-Content -LiteralPath $logPath -Value (Format-OmLogLine -Now (Get-Date) -Outcome 'NOTE' -Note $fenceNote) -Encoding UTF8
  }
  $serverMajor = Get-OmServerMajorVersion -VersionNum $run.StdOut
  Write-Host "  server:   PostgreSQL $serverMajor, pg_dump $dumpMajor"
  Assert-OmToolNotOlderThanServer -ToolMajor $dumpMajor -ServerMajor $serverMajor

  $step = 'checking the schemas'
  $schemaQuery = "select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1"
  $run = Invoke-OmPgTool -Exe $tools.Psql -Arguments (@('--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', $schemaQuery) + $connectionArgs) @connection
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; $toolError = $run.StdErr; throw 'the list of schemas could not be read' }
  $serverSchemas = @($run.StdOut -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  Test-OmSchemaList -ServerSchemas $serverSchemas -SkipSchemas $config['skip_schemas']

  $step = 'pg_dump'
  # The name is reserved first, and only a file this run created is ever renamed or removed by it.
  $reserved = New-OmDumpFile -Folder $folder -Now $startedAt
  $dumpPath = $reserved
  $dumpName = [System.IO.Path]::GetFileName($dumpPath)
  Write-Host "Dumping to $dumpName ..."
  $run = Invoke-OmPgTool -Exe $tools.PgDump -Arguments (Get-OmPgDumpArgs -HostName $hostName -Port $port -User $user -Database $database -DumpPath $dumpPath) @connection
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; $toolError = $run.StdErr; throw "pg_dump ended with exit code $($run.ExitCode)" }
  if (-not (Test-Path -LiteralPath $dumpPath -PathType Leaf)) { throw 'pg_dump wrote no file' }

  $step = 'pg_restore --list'
  $run = Invoke-OmPgTool -Exe $tools.PgRestore -Arguments @('--list', $dumpPath)
  if ($run.ExitCode -ne 0) { Write-Host $run.StdErr; $toolError = $run.StdErr; throw "the new file cannot be read back (pg_restore --list ended with exit code $($run.ExitCode))" }
  $tableCount = Get-OmTableCountFromList -ListText $run.StdOut
  if ($tableCount -lt 1) { throw 'the new file lists no tables' }

  $step = 'sha256'
  $size = (Get-Item -LiteralPath $dumpPath).Length
  $hash = Get-OmSha256 -Path $dumpPath
  Set-Content -LiteralPath "$dumpPath.sha256" -Value "$hash  $dumpName" -Encoding ASCII

  Write-RunLog -Outcome 'OK' -SizeBytes $size -TableCount $tableCount -Note "sha256 $hash"
  # From here on the new file is a verified backup: nothing below may rename or remove it.
  $dumpPath = ''

  # Old backups go only now, after a new one has been written and read back. A file that cannot be
  # deleted (antivirus, an open window, permissions) is a warning, not a failure of the backup.
  $step = 'deleting old backups'
  $expired = Get-OmExpiredBackupFiles -Folder $folder -RetentionDays $config['retention_days'] -Now $startedAt -KeepName $dumpName
  foreach ($file in $expired) {
    try {
      Remove-Item -LiteralPath $file.FullName -Force
      Write-Host "  deleted old backup file $($file.Name)"
    } catch {
      $warning = "old backup file $($file.Name) could not be deleted: " + (Get-OmSafeReason -Text $_.Exception.Message -Hide $hide)
      Write-Host "  WARNING: $warning"
      try { Write-RunLog -Outcome 'WARNING' -Note $warning } catch { }
    }
  }

  Write-Host "OK: $dumpName, $size bytes, $tableCount tables"
  Write-Host "    sha256 $hash"
  Exit-OmBackupLock -Lock $lock
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
  # Under Task Scheduler the window is gone, so the log line carries the reason: the tool's own first error
  # line when a tool failed, else this script's message, with host, user, folder and the like removed.
  $detail = ''
  try {
    $source = $reason
    if ($toolError -and $toolError.Trim() -ne '') { $source = $toolError }
    $detail = Get-OmSafeReason -Text $source -Hide $hide
  } catch { $detail = '' }
  $note = "while $step"
  if ($detail) { $note = "while ${step}: $detail" }
  try { Write-RunLog -Outcome 'FAILED' -Note $note } catch { }
  Write-Host "FAILED while ${step}: $reason"
  Write-Host 'No old backup was deleted. See "When a run says FAILED" in docs/runbooks/production-manual-backup.md'
  Exit-OmBackupLock -Lock $lock
  exit 1
}
