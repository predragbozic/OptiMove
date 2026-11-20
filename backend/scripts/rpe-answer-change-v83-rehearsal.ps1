# The v83 rehearsal (K4b, changing an RPE answer) on a local PostgreSQL - PowerShell (Windows). Runs
# backend/scripts/rpe-answer-change-v83-rehearsal.mjs unchanged; see that file and
# docs/runbooks/rpe-answer-change-v83.md for what it does. Loopback only; it creates and drops its own
# optimove_tests_k4bv83rehearsal_* databases. Needs only node, pg_dump and pg_restore (of the server's major version) and
# the backend's dependencies (npm --prefix backend ci); no admin rights.
#
# One trip: when backend\scripts\permission-roles-v84-rehearsal.mjs is in this checkout too (roles R2), it is run right
# after, against the same server, with the same password - one command, one prompt, both results.
#
#   powershell -ExecutionPolicy Bypass -File backend\scripts\rpe-answer-change-v83-rehearsal.ps1 -DbHost 127.0.0.1 -Port 5432 -User postgres [-PgBin "C:\Program Files\PostgreSQL\17\bin"]
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
$dump = if ($PgBin) { Join-Path $PgBin "pg_dump.exe" } else { "pg_dump" }
if (-not (Get-Command $dump -ErrorAction SilentlyContinue)) { Write-Host "FAIL  pg_dump not found (add PostgreSQL's bin to PATH or pass -PgBin)"; exit 2 }
if (-not (Test-Path (Join-Path $here "..\node_modules\pg"))) { Write-Host "FAIL  backend dependencies missing: run npm --prefix backend ci"; exit 2 }
if ($env:PGPASSWORD) {
  $plain = $env:PGPASSWORD
} else {
  $secure = Read-Host -AsSecureString -Prompt "Password for $User@${DbHost}:$Port (hidden)"
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
$common = @("--host", $DbHost, "--port", $Port, "--user", $User)
if ($PgBin) { $common += @("--pg-bin", $PgBin) }
$v84 = Join-Path $here "permission-roles-v84-rehearsal.mjs"
$savedPg = $env:PGPASSWORD
$code83 = 1
$code84 = 0
try {
  $env:OPTIMOVE_REHEARSAL_PASSWORD = $plain
  $env:PGPASSWORD = $null
  Write-Host "=== v83 (K4b, changing an RPE answer) ==="
  & node (Join-Path $here "rpe-answer-change-v83-rehearsal.mjs") @common
  $code83 = $LASTEXITCODE
  if (Test-Path $v84) {
    Write-Host "=== v84 (roles R2) ==="
    & node $v84 @common
    $code84 = $LASTEXITCODE
  }
} finally {
  Remove-Item Env:OPTIMOVE_REHEARSAL_PASSWORD -ErrorAction SilentlyContinue
  $env:PGPASSWORD = $savedPg
  $plain = $null
}
$summary = "=== v83: " + $(if ($code83 -eq 0) { "PASS" } else { "FAIL" })
if (Test-Path $v84) { $summary += " · v84: " + $(if ($code84 -eq 0) { "PASS" } else { "FAIL" }) }
Write-Host ($summary + " ===")
if ($code83 -eq 0 -and $code84 -eq 0) { exit 0 } else { exit 1 }
