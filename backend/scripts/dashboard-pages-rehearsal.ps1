# P1 PG17 disposable rehearsal. Set PGPASSWORD when the local cluster requires it.
param(
 [string]$DbHost='127.0.0.1',
 [string]$Port='5432',
 [string]$User='postgres',
 [string]$PgBin='',
 [string]$OldBuild='aa6e765c86525f23d4ff970c9fa550b4183bae01'
)
$ErrorActionPreference='Stop'
$p1Args=@('--host',$DbHost,'--port',$Port,'--user',$User,'--old-build',$OldBuild)
if($PgBin){$p1Args+=@('--pg-bin',$PgBin)}
& node (Join-Path $PSScriptRoot 'dashboard-pages-rehearsal.mjs') @p1Args
exit $LASTEXITCODE
