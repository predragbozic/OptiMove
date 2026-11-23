# P2 owner rehearsal: no persistent database name accepted; Node >=20.
param([string]$DbHost='127.0.0.1',[string]$Port='5432',[string]$User='postgres',[string]$PgBin='',[string]$OldBuild='3cf0f7f92ec82ee75ed470149c9ab688c1fd384b')
$ErrorActionPreference='Stop'
$galleryArgs=@('--host',$DbHost,'--port',$Port,'--user',$User,'--old-build',$OldBuild)
if($PgBin){$galleryArgs+=@('--pg-bin',$PgBin)}
& node (Join-Path $PSScriptRoot 'dashboard-chart-shapes-v94-rehearsal.mjs') @galleryArgs
exit $LASTEXITCODE
