# Shared functions of optimove-backup.ps1 and optimove-restore-test.ps1.
# Written for Windows PowerShell 5.1 (no PowerShell 7 syntax); it also runs on PowerShell 7.
# Runbook: docs/runbooks/production-manual-backup.md

Set-StrictMode -Version 2.0

# The application's schemas: the same list as APP_SCHEMAS in backend/scripts/gpexe-backup-verify.mjs
# (the test of this folder compares the two). Only these are dumped.
$script:OmAppSchemas = @('calendar', 'library', 'media', 'plans', 'public', 'tests', 'training', 'training_load')

# Schemas the hosting provider (Supabase) keeps for itself: the same list as HOSTING_SCHEMAS there.
# They are not the application's, and a plain PostgreSQL could not restore them.
$script:OmHostingSchemas = @(
  '_analytics', '_realtime', 'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'net', 'pgbouncer',
  'pgsodium', 'pgsodium_masks', 'pgtle', 'realtime', 'storage', 'supabase_functions', 'supabase_migrations', 'vault'
)

$script:OmConfigFileName = 'optimove-backup.local.conf'
$script:OmConfigKeys = @('host', 'port', 'database', 'user', 'backup_folder', 'retention_days', 'ssl_root_cert', 'skip_schemas', 'pg_bin')
# Seconds are part of the name; a name without them (the first version of the script) is still recognised.
$script:OmDumpNamePattern = '^optimove-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})?\.dump(\.sha256|\.failed)?$'
$script:OmLockFileName = 'optimove-backup.lock'
$script:OmRestoreDbPattern = '^optimove_restore_test_\d{8}_\d{6}$'

function Get-OmAppSchemas { return $script:OmAppSchemas }
function Get-OmHostingSchemas { return $script:OmHostingSchemas }

function Get-OmDefaultConfigPath {
  $base = $env:APPDATA
  if (-not $base) { $base = Join-Path $HOME '.config' }
  return (Join-Path (Join-Path $base 'OptiMove') $script:OmConfigFileName)
}

function Get-OmDefaultPgPassPath {
  $base = $env:APPDATA
  if ($base) { return (Join-Path (Join-Path $base 'postgresql') 'pgpass.conf') }
  return (Join-Path $HOME '.pgpass')
}

# True when the path lies inside a git checkout (a .git entry in the folder or in any parent).
function Test-OmInsideGitRepo {
  param([Parameter(Mandatory = $true)][string]$Path)
  $current = [System.IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath (Join-Path $current '.git')) { return $true }
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
  return $false
}

# Reads the local "key = value" file. It never holds a password: a password key is refused.
function Read-OmBackupConfig {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "refusing: the config file was not found: $Path (see docs/runbooks/production-manual-backup.md, 'The config file')"
  }
  if (Test-OmInsideGitRepo -Path ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Path)))) {
    throw 'refusing: the config file is inside a git repository; keep it outside every checkout'
  }
  $config = @{}
  $lineNumber = 0
  foreach ($raw in (Get-Content -LiteralPath $Path)) {
    $lineNumber++
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    $at = $line.IndexOf('=')
    if ($at -lt 1) { throw "refusing: config line $lineNumber is not 'key = value'" }
    $key = $line.Substring(0, $at).Trim().ToLowerInvariant()
    $value = $line.Substring($at + 1).Trim()
    if ($key -match 'pass|pwd|secret') {
      throw "refusing: config line $lineNumber holds a password. Remove it from the file now. The password is read only from pgpass.conf or typed when asked."
    }
    if ($script:OmConfigKeys -notcontains $key) { throw "refusing: config line $lineNumber has an unknown key '$key'" }
    if ($config.ContainsKey($key)) { throw "refusing: config key '$key' is given twice" }
    $config[$key] = $value
  }
  foreach ($required in @('host', 'port', 'database', 'user', 'backup_folder')) {
    if (-not $config.ContainsKey($required) -or $config[$required] -eq '') { throw "refusing: the config file has no '$required'" }
  }
  if ($config['host'] -notmatch '^[A-Za-z0-9][A-Za-z0-9.:-]*$') { throw 'refusing: the host in the config file is not a plain host name or address' }
  $port = 0
  if (-not [int]::TryParse($config['port'], [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'refusing: the port in the config file is not a number between 1 and 65535' }
  $config['port'] = $port
  # A name libpq would read as a connection string ("=" or a URI) never passes these two checks.
  if ($config['database'] -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') { throw 'refusing: the database name in the config file has characters that are not allowed' }
  if ($config['user'] -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') { throw 'refusing: the user name in the config file has characters that are not allowed' }
  $days = 14
  if ($config.ContainsKey('retention_days') -and $config['retention_days'] -ne '') {
    if (-not [int]::TryParse($config['retention_days'], [ref]$days) -or $days -lt 1) { throw 'refusing: retention_days must be a whole number of days, 1 or more' }
  }
  $config['retention_days'] = $days
  $skip = @()
  if ($config.ContainsKey('skip_schemas') -and $config['skip_schemas'] -ne '') {
    $skip = @($config['skip_schemas'].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    foreach ($name in $skip) {
      if ($name -notmatch '^[a-z_][a-z0-9_]{0,62}$') { throw "refusing: skip_schemas has a name that is not a plain schema name: $name" }
      if ($script:OmAppSchemas -contains $name) { throw "refusing: skip_schemas names an application schema ($name); the backup would miss it" }
    }
  }
  $config['skip_schemas'] = $skip
  foreach ($optional in @('ssl_root_cert', 'pg_bin')) { if (-not $config.ContainsKey($optional)) { $config[$optional] = '' } }
  if ($config['ssl_root_cert'] -ne '' -and -not (Test-Path -LiteralPath $config['ssl_root_cert'] -PathType Leaf)) {
    throw 'refusing: ssl_root_cert names a file that does not exist'
  }
  return $config
}

# This machine only: localhost, 127.x.x.x or ::1. Anything else is not loopback.
function Test-OmLoopbackHost {
  param([AllowNull()][AllowEmptyString()][string]$HostName)
  if (-not $HostName) { return $false }
  $name = $HostName.Trim().ToLowerInvariant()
  if ($name -eq 'localhost' -or $name -eq '::1' -or $name -eq '[::1]') { return $true }
  if ($name -match '^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') {
    foreach ($part in @($Matches[1], $Matches[2], $Matches[3])) { if ([int]$part -gt 255) { return $false } }
    return $true
  }
  return $false
}

# "pg_dump (PostgreSQL) 17.6" -> 17. Returns 0 when the text is not a version line.
function Get-OmToolMajorVersion {
  param([AllowNull()][AllowEmptyString()][string]$VersionText)
  if ($VersionText -and $VersionText -match '\(PostgreSQL\)\s+(\d+)') { return [int]$Matches[1] }
  return 0
}

# server_version_num "170006" -> 17. Returns 0 when the text is not such a number.
function Get-OmServerMajorVersion {
  param([AllowNull()][AllowEmptyString()][string]$VersionNum)
  $number = 0
  if ($VersionNum -and [int]::TryParse($VersionNum.Trim(), [ref]$number) -and $number -ge 90000) { return [int][math]::Floor($number / 10000) }
  return 0
}

function Assert-OmToolNotOlderThanServer {
  param([int]$ToolMajor, [int]$ServerMajor, [string]$ToolName = 'pg_dump')
  if ($ToolMajor -lt 1) { throw "refusing: the version of $ToolName could not be read" }
  if ($ServerMajor -lt 1) { throw 'refusing: the version of the server could not be read' }
  if ($ToolMajor -lt $ServerMajor) {
    throw "refusing: $ToolName is version $ToolMajor and the server is PostgreSQL $ServerMajor. Install the PostgreSQL $ServerMajor client tools (or newer) and try again."
  }
}

# Supabase's transaction pooler (port 6543) gives each statement to any server connection;
# pg_dump needs one session. Only the session pooler (port 5432) is accepted there.
function Assert-OmNotTransactionPooler {
  param([string]$HostName, [int]$Port)
  if ($HostName -and $HostName.ToLowerInvariant().EndsWith('.pooler.supabase.com') -and $Port -eq 6543) {
    throw 'refusing: port 6543 is the transaction pooler. Use the Session pooler (port 5432) from the Supabase Connect window.'
  }
}

# Stops the run when the server has a schema nobody has looked at: neither the application's,
# nor the hosting provider's, nor named in skip_schemas. Returns the application schemas the server lacks.
function Test-OmSchemaList {
  param([string[]]$ServerSchemas, [string[]]$SkipSchemas = @())
  $unknown = @($ServerSchemas | Where-Object {
      $_ -and ($script:OmAppSchemas -notcontains $_) -and ($script:OmHostingSchemas -notcontains $_) -and ($SkipSchemas -notcontains $_)
    })
  if ($unknown.Count -gt 0) {
    throw ("refusing: the database has schema " + ($unknown -join ', ') + ", which this backup does not know. Nothing was dumped. Report the schema's name; a backup never silently leaves out a schema nobody has looked at.")
  }
  $missing = @($script:OmAppSchemas | Where-Object { $ServerSchemas -notcontains $_ })
  if ($missing.Count -gt 0) {
    throw ("refusing: the database has no schema " + ($missing -join ', ') + ". Nothing was dumped. Is this the right database?")
  }
}

# One field of a pgpass line: "\:" and "\\" are escapes.
function Split-OmPgPassLine {
  param([string]$Line)
  $fields = New-Object System.Collections.Generic.List[string]
  $current = New-Object System.Text.StringBuilder
  $i = 0
  while ($i -lt $Line.Length) {
    $c = $Line[$i]
    if ($c -eq '\' -and ($i + 1) -lt $Line.Length) { [void]$current.Append($Line[$i + 1]); $i += 2; continue }
    if ($c -eq ':') { $fields.Add($current.ToString()); [void]$current.Clear(); $i++; continue }
    [void]$current.Append($c)
    $i++
  }
  $fields.Add($current.ToString())
  return , $fields.ToArray()
}

# Whether the pgpass file has a line for this connection. It reads the file but never returns or prints the password.
function Test-OmPgPassEntry {
  param([string]$PgPassPath, [string]$HostName, [int]$Port, [string]$Database, [string]$User)
  if (-not $PgPassPath -or -not (Test-Path -LiteralPath $PgPassPath -PathType Leaf)) { return $false }
  foreach ($raw in (Get-Content -LiteralPath $PgPassPath)) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    $fields = Split-OmPgPassLine -Line $line
    # libpq takes the rest of the line as the password, so a password with a plain ':' gives more than 5 fields.
    if ($fields.Length -lt 5) { continue }
    $wanted = @($HostName, [string]$Port, $Database, $User)
    $ok = $true
    for ($i = 0; $i -lt 4; $i++) { if ($fields[$i] -ne '*' -and $fields[$i] -cne $wanted[$i]) { $ok = $false } }
    if ($ok -and $fields[4] -ne '') { return $true }
  }
  return $false
}

function New-OmDumpFileName {
  param([datetime]$Now = (Get-Date))
  return ('optimove-' + $Now.ToString('yyyy-MM-dd-HHmmss', [System.Globalization.CultureInfo]::InvariantCulture) + '.dump')
}

# Reserves the name of a new backup: the file is created only if no file of that name exists (one atomic step,
# so two runs can never share a name), and neither may a .failed file of that name. Returns the full path;
# throws without touching anything when the name is taken.
function New-OmDumpFile {
  param([Parameter(Mandatory = $true)][string]$Folder, [datetime]$Now = (Get-Date))
  $name = New-OmDumpFileName -Now $Now
  $path = Join-Path $Folder $name
  if (Test-Path -LiteralPath "$path.failed") { throw "refusing: $name.failed already exists; run again in a moment" }
  try {
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $stream.Dispose()
  } catch [System.IO.IOException] {
    throw "refusing: $name already exists; run again in a moment"
  }
  return $path
}

# One backup at a time per folder. The lock is an open handle on a small file in the backup folder: while a run
# holds it, a second run gets $null. Only the handle counts: a lock file left behind by a crash or a power cut
# blocks nobody, because nothing holds it open. The file itself is never deleted (deleting it could hand the
# "same" lock to two runs).
function Enter-OmBackupLock {
  param([Parameter(Mandatory = $true)][string]$Folder)
  $path = Join-Path $Folder $script:OmLockFileName
  try {
    return [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    return $null
  }
}

function Exit-OmBackupLock {
  param($Lock)
  if ($null -ne $Lock) { $Lock.Dispose() }
}

# A short reason for the log, from a tool's error output or from one of this script's own messages: the first
# line that says something, with everything that could identify the server or the person removed (the given
# values such as host, user and folder, any quoted text, addresses, paths, key=value pairs that look like a
# password or a connection setting), no log separator, and a length cap.
function Get-OmSafeReason {
  param([AllowNull()][AllowEmptyString()][string]$Text, [string[]]$Hide = @(), [int]$MaxLength = 160)
  if (-not $Text) { return '' }
  $line = ''
  foreach ($candidate in ($Text -split "`r?`n")) { if ($candidate.Trim() -ne '') { $line = $candidate.Trim(); break } }
  if ($line -eq '') { return '' }
  # The pooler's user name (postgres.<project reference>) goes first, before the shorter values could split it.
  $line = [regex]::Replace($line, '(?i)\bpostgres\.[a-z0-9]{6,}\b', '<hidden>')
  foreach ($value in (@($Hide) | Where-Object { $_ -and $_.Length -ge 3 } | Sort-Object { $_.Length } -Descending)) {
    $line = [regex]::Replace($line, ('(?<![A-Za-z0-9_])' + [regex]::Escape($value) + '(?![A-Za-z0-9_])'), '<hidden>', 'IgnoreCase')
  }
  $line = [regex]::Replace($line, '"[^"]*"', '<hidden>')
  $line = [regex]::Replace($line, "'[^']*'", '<hidden>')
  $line = [regex]::Replace($line, '(?i)\b[a-z][a-z0-9+.-]*://\S+', '<hidden>')
  $line = [regex]::Replace($line, '(?i)\b(pg)?(password|passwd|pwd|passfile|user|username|host|hostaddr|dbname|options|service)\s*=\s*\S+', '<hidden>')
  $line = [regex]::Replace($line, '(?i)\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|co|net|org|io|dev|app|cloud|internal|local|test|invalid)\b', '<hidden>')
  $line = [regex]::Replace($line, '\b\d{1,3}(\.\d{1,3}){3}\b', '<hidden>')
  $line = [regex]::Replace($line, '(?i)\b[0-9a-f]{0,4}(:[0-9a-f]{0,4}){3,7}\b', '<hidden>')
  $line = [regex]::Replace($line, '(?i)\b[a-z]:\\[^\s,;]*', '<hidden>')
  $line = [regex]::Replace($line, '(?<![\w<])/[^\s,;:]+/[^\s,;:]*', '<hidden>')
  $line = [regex]::Replace($line, '(<hidden>\s*)+', '<hidden> ')
  $line = [regex]::Replace($line, '[|\x00-\x1F\x7F]', ' ')
  $line = [regex]::Replace($line, '\s+', ' ').Trim()
  $line = [regex]::Replace($line, '\(\s+', '(')
  $line = [regex]::Replace($line, '\s+([),:])', '$1')
  if ($line.Length -gt $MaxLength) { $line = $line.Substring(0, $MaxLength - 3).TrimEnd() + '...' }
  return $line
}

# The time written in a backup file's own name, or $null for any other file.
function Get-OmDumpTimeFromName {
  param([string]$Name)
  if ($Name -notmatch $script:OmDumpNamePattern) { return $null }
  try {
    $seconds = 0
    if ($Matches[6]) { $seconds = [int]$Matches[6] }
    return (New-Object datetime ([int]$Matches[1]), ([int]$Matches[2]), ([int]$Matches[3]), ([int]$Matches[4]), ([int]$Matches[5]), $seconds)
  } catch { return $null }
}

# The files retention may delete: this script's own dumps (and their .sha256 / .failed files) whose name is
# older than the limit. Never the file just written, never a file with any other name, never a subfolder.
function Get-OmExpiredBackupFiles {
  param([Parameter(Mandatory = $true)][string]$Folder, [Parameter(Mandatory = $true)][int]$RetentionDays, [datetime]$Now = (Get-Date), [string]$KeepName = '')
  if ($RetentionDays -lt 1) { throw 'refusing: retention must be 1 day or more' }
  $limit = $Now.AddDays(-$RetentionDays)
  $expired = @()
  foreach ($file in (Get-ChildItem -LiteralPath $Folder -File)) {
    $stamp = Get-OmDumpTimeFromName -Name $file.Name
    if ($null -eq $stamp) { continue }
    if ($KeepName -and ($file.Name -eq $KeepName -or $file.Name -eq "$KeepName.sha256")) { continue }
    if ($stamp -lt $limit) { $expired += $file }
  }
  return , $expired
}

# The number of tables in a "pg_restore --list" table of contents (TABLE entries, not TABLE DATA).
function Get-OmTableCountFromList {
  param([AllowNull()][AllowEmptyString()][string]$ListText)
  if (-not $ListText) { return 0 }
  $count = 0
  foreach ($line in ($ListText -split "`r?`n")) { if ($line -match '^\d+;\s+\d+\s+\d+\s+TABLE\s+(?!DATA\s)') { $count++ } }
  return $count
}

# "; Dumped from database version: 17.6" -> 17 (0 when the line is missing).
function Get-OmDumpServerMajorFromList {
  param([AllowNull()][AllowEmptyString()][string]$ListText)
  if ($ListText -and $ListText -match ';\s+Dumped from database version:\s+(\d+)') { return [int]$Matches[1] }
  return 0
}

# Whether a "pg_restore --list" table of contents creates the schema itself: a line such as
# "7; 2615 2200 SCHEMA - public postgres". A dump limited to schemas carries its own CREATE SCHEMA public.
function Test-OmDumpCreatesSchema {
  param([AllowNull()][AllowEmptyString()][string]$ListText, [string]$Schema)
  if (-not $ListText) { return $false }
  foreach ($line in ($ListText -split "`r?`n")) {
    if ($line -match '^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+(\S+)' -and $Matches[1] -ceq $Schema) { return $true }
  }
  return $false
}

function New-OmRestoreDatabaseName {
  param([datetime]$Now = (Get-Date))
  return ('optimove_restore_test_' + $Now.ToString('yyyyMMdd_HHmmss', [System.Globalization.CultureInfo]::InvariantCulture))
}

# The only database names the restore test may create or drop.
function Test-OmRestoreDatabaseName {
  param([AllowNull()][AllowEmptyString()][string]$Name)
  return [bool]($Name -and ($Name -cmatch $script:OmRestoreDbPattern))
}

# Finds pg_dump, pg_restore and psql: in the given folder, else on the PATH, else in the newest
# "C:\Program Files\PostgreSQL\<version>\bin".
function Resolve-OmPgBin {
  param([string]$PgBin = '')
  $suffix = ''
  if ($env:OS -eq 'Windows_NT') { $suffix = '.exe' }
  $candidates = @()
  if ($PgBin) { $candidates += $PgBin }
  else {
    $found = Get-Command ('pg_dump' + $suffix) -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $candidates += [System.IO.Path]::GetDirectoryName($found.Source) }
    if ($env:ProgramFiles) {
      $root = Join-Path $env:ProgramFiles 'PostgreSQL'
      if (Test-Path -LiteralPath $root) {
        $candidates += @(Get-ChildItem -LiteralPath $root -Directory | Sort-Object { $n = 0; [void][int]::TryParse($_.Name, [ref]$n); $n } -Descending | ForEach-Object { Join-Path $_.FullName 'bin' })
      }
    }
  }
  foreach ($folder in $candidates) {
    $all = $true
    foreach ($tool in @('pg_dump', 'pg_restore', 'psql')) { if (-not (Test-Path -LiteralPath (Join-Path $folder ($tool + $suffix)) -PathType Leaf)) { $all = $false } }
    if ($all) {
      return @{ Folder = $folder; PgDump = (Join-Path $folder ('pg_dump' + $suffix)); PgRestore = (Join-Path $folder ('pg_restore' + $suffix)); Psql = (Join-Path $folder ('psql' + $suffix)) }
    }
  }
  throw 'refusing: pg_dump, pg_restore and psql were not found. Install the PostgreSQL 17 command line tools, or set pg_bin in the config file (the folder that holds pg_dump.exe).'
}

# One command-line argument, quoted by the Windows rules.
function ConvertTo-OmArgument {
  param([AllowEmptyString()][string]$Value)
  if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

# Runs one PostgreSQL tool. The child process inherits NO libpq variable from this shell (a leftover PGHOST,
# PGHOSTADDR or PGSERVICE would send it to another server than the one printed); host, port, user and database
# are always explicit arguments. The password reaches the tool only through its own environment (PGPASSWORD)
# or through pgpass (PGPASSFILE): never on a command line, never on the screen, never in a file written here.
function Invoke-OmPgTool {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [System.Security.SecureString]$Password = $null,
    [string]$PgPassFile = '',
    [string]$SslMode = '',
    [string]$SslRootCert = '',
    [switch]$ReadOnly
  )
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Exe
  $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-OmArgument -Value $_ }) -join ' ')
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.CreateNoWindow = $true
  foreach ($key in @($info.EnvironmentVariables.Keys)) { if ($key -match '^PG') { $info.EnvironmentVariables.Remove($key) } }
  $info.EnvironmentVariables['PGCONNECT_TIMEOUT'] = '30'
  $info.EnvironmentVariables['PGCLIENTENCODING'] = 'UTF8'
  if ($SslMode) { $info.EnvironmentVariables['PGSSLMODE'] = $SslMode }
  if ($SslRootCert) { $info.EnvironmentVariables['PGSSLROOTCERT'] = $SslRootCert }
  # A second fence for the connections to the source: every transaction of the session starts read only,
  # so even a mistaken statement could not change anything there.
  if ($ReadOnly) { $info.EnvironmentVariables['PGOPTIONS'] = '-c default_transaction_read_only=on' }
  if ($null -ne $Password) {
    $info.EnvironmentVariables['PGPASSWORD'] = (New-Object System.Net.NetworkCredential('', $Password)).Password
  } elseif ($PgPassFile) {
    $info.EnvironmentVariables['PGPASSFILE'] = $PgPassFile
  }
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $result = @{ ExitCode = $process.ExitCode; StdOut = $stdout.Result; StdErr = $stderr.Result }
  $process.Dispose()
  return $result
}

# Where the password comes from: a matching pgpass line, else a hidden prompt. It is never a parameter.
# Returns @{ PgPassFile = <path or ''>; Password = <SecureString or $null> }.
function Resolve-OmPassword {
  param([string]$HostName, [int]$Port, [string]$Database, [string]$User, [string]$PgPassPath, [switch]$NoPrompt, [string]$PromptText)
  if (Test-OmPgPassEntry -PgPassPath $PgPassPath -HostName $HostName -Port $Port -Database $Database -User $User) {
    return @{ PgPassFile = $PgPassPath; Password = $null }
  }
  if ($NoPrompt) {
    throw "refusing: no line for this connection in the password file ($PgPassPath), and -NoPrompt forbids asking. See 'The password file' in the runbook."
  }
  $secure = Read-Host -AsSecureString -Prompt $PromptText
  return @{ PgPassFile = ''; Password = $secure }
}

function Get-OmConnectionArgs {
  param([string]$HostName, [int]$Port, [string]$User, [string]$Database)
  return @('--no-password', '--host', $HostName, '--port', ([string]$Port), '--username', $User, '--dbname', $Database)
}

# The pg_dump command line of a backup.
function Get-OmPgDumpArgs {
  param([string]$HostName, [int]$Port, [string]$User, [string]$Database, [string]$DumpPath)
  $arguments = @('--format=custom', '--no-owner', '--no-privileges', '--strict-names', '--lock-wait-timeout=60000')
  foreach ($schema in $script:OmAppSchemas) { $arguments += "--schema=$schema" }
  $arguments += "--file=$DumpPath"
  $arguments += (Get-OmConnectionArgs -HostName $HostName -Port $Port -User $User -Database $Database)
  return $arguments
}

# The pg_restore command line of a trial restore.
function Get-OmPgRestoreArgs {
  param([string]$HostName, [int]$Port, [string]$User, [string]$Database, [string]$DumpPath)
  return (@('--exit-on-error', '--no-owner', '--no-privileges') + (Get-OmConnectionArgs -HostName $HostName -Port $Port -User $User -Database $Database) + @($DumpPath))
}

function Get-OmSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# One line per run, appended to optimove-backup.log in the backup folder. No host, no user, no password.
function Format-OmLogLine {
  param([datetime]$Now, [string]$Outcome, [string]$FileName = '-', [long]$SizeBytes = 0, [int]$TableCount = 0, [string]$Note = '')
  $line = $Now.ToString('yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture) + " | $Outcome | $FileName | $SizeBytes bytes | $TableCount tables"
  if ($Note) { $line += " | $Note" }
  return $line
}
