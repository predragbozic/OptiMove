[CmdletBinding()]
param([ValidateRange(1,65535)][int]$Port = 55470, [string]$User = 'postgres')

$ErrorActionPreference = 'Stop'
$originalUrl = $env:DATABASE_URL
$secret = [IntPtr]::Zero
try {
    & node -e 'if (+process.versions.node.split(".")[0] < 20) process.exit(1)'
    if ($LASTEXITCODE -ne 0) { throw 'Node 20 or newer is required.' }
    if (-not $env:DATABASE_URL) {
        $password = $env:PGPASSWORD
        if ($null -eq $password) {
            $secure = Read-Host -AsSecureString "Password for $User on local port $Port (leave blank for trust)"
            $secret = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secret)
        }
        $login = [uri]::EscapeDataString($User)
        if ($password) { $login += ':' + [uri]::EscapeDataString($password) }
        $env:DATABASE_URL = "postgresql://$login@127.0.0.1:$Port/postgres"
        Remove-Variable password -ErrorAction SilentlyContinue
    }
    $uri = [uri]$env:DATABASE_URL
    if ($uri.Host -notin @('localhost','127.0.0.1','[::1]','::1')) { throw 'Use an isolated loopback PostgreSQL cluster.' }
    Push-Location -LiteralPath (Join-Path $PSScriptRoot '../..')
    try {
        & node scripts/test-runner.mjs --project backend --kind disposable --file variable-rename-archive-v112-rehearsal.test.mjs
        if ($LASTEXITCODE -ne 0) { throw "Rehearsal failed with exit code $LASTEXITCODE." }
        Write-Output "RESULT: PASS"
    } finally { Pop-Location }
} finally {
    if ($secret -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secret) }
    $env:DATABASE_URL = $originalUrl
}
