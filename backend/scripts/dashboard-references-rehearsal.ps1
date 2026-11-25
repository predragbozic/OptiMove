param([string]$HostName='127.0.0.1',[int]$Port=55470,[string]$UserName='postgres')
$ErrorActionPreference='Stop'
if($HostName -notin @('127.0.0.1','localhost','::1')){throw 'Only a dedicated loopback test cluster is allowed.'}
$previousUrl=$env:DATABASE_URL
$secure=Read-Host 'Password for the dedicated PostgreSQL test cluster (Enter for trust)' -AsSecureString
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
 $password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
 $encoded=[Uri]::EscapeDataString($password)
 $hostPart=if($HostName -eq '::1'){'[::1]'}else{$HostName}
 $env:DATABASE_URL='postgresql://'+[Uri]::EscapeDataString($UserName)+':'+$encoded+'@'+$hostPart+':'+$Port+'/postgres'
 & node (Join-Path $PSScriptRoot 'dashboard-references-rehearsal.mjs')
 if($LASTEXITCODE -ne 0){throw 'P3 rehearsal failed.'}
} finally {
 [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
 Remove-Variable password,encoded,secure -ErrorAction SilentlyContinue
 if($null -eq $previousUrl){Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue}else{$env:DATABASE_URL=$previousUrl}
}
