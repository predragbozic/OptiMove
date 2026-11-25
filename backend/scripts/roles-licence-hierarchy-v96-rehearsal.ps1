# The v96 rehearsal (the licence hierarchy) on a local PostgreSQL - PowerShell
# (Windows). Runs backend/scripts/roles-licence-hierarchy-v96-rehearsal.mjs unchanged; see that file and
# docs/runbooks/roles-licence-hierarchy-v96.md for what it does. Loopback only; it creates and drops its own
# optimove_tests_v96rehearsal_* databases. Needs only node (20 or later), pg_dump and pg_restore (of the server's major
# version) and the backend's dependencies (npm --prefix backend ci); no admin rights.
#
#   powershell -ExecutionPolicy Bypass -File backend\scripts\roles-licence-hierarchy-v96-rehearsal.ps1 -DbHost 127.0.0.1 -Port 5432 -User postgres [-PgBin "C:\Program Files\PostgreSQL\17\bin"]
#
# The password: from $env:PGPASSWORD if set, otherwise asked once (hidden, never printed).
param(
  [string]$DbHost = "127.0.0.1",
  [string]$Port = "5432",
  [string]$User = "postgres",
  [string]$PgBin = ""
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (@("localhost", "127.0.0.1", "::1") -notcontains $DbHost) { Write-Host "refusing: $DbHost is not a loopback host (localhost, 127.0.0.1, ::1)"; exit 2 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "FAIL  node is not on PATH"; exit 2 }
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Write-Host "FAIL  Node 20 or later is needed (this is $(& node -v))"; exit 2 }
$dump = if ($PgBin) { Join-Path $PgBin "pg_dump.exe" } else { "pg_dump" }
if (-not (Get-Command $dump -ErrorAction SilentlyContinue)) { Write-Host "FAIL  pg_dump not found (add PostgreSQL's bin to PATH or pass -PgBin)"; exit 2 }
if (-not (Test-Path (Join-Path $here "..\node_modules\pg"))) { Write-Host "FAIL  backend dependencies missing: run npm --prefix backend ci"; exit 2 }
if ($env:PGPASSWORD) {
  $plain = $env:PGPASSWORD
} else {
  $secure = Read-Host -AsSecureString -Prompt "Password for $User@${DbHost}:$Port (hidden)"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    # The unmanaged copy of the password is zeroed and freed at once.
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
$nodeArgs = @((Join-Path $here "roles-licence-hierarchy-v96-rehearsal.mjs"), "--host", $DbHost, "--port", $Port, "--user", $User)
if ($PgBin) { $nodeArgs += @("--pg-bin", $PgBin) }
$savedPg = $env:PGPASSWORD
try {
  $env:OPTIMOVE_REHEARSAL_PASSWORD = $plain
  $env:PGPASSWORD = $null
  & node @nodeArgs
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:OPTIMOVE_REHEARSAL_PASSWORD -ErrorAction SilentlyContinue
  $env:PGPASSWORD = $savedPg
  $plain = $null
}
exit $code
