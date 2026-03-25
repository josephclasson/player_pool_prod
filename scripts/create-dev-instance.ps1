<#
.SYNOPSIS
  Provisions a development Supabase-backed instance: link project, push migrations, scaffold .env.development.local.

.PARAMETER ProjectRef
  Supabase project ref for **player_pool_dev** (Dashboard → Project Settings → General — the id string, not the name). If omitted, you are prompted.

.PARAMETER SkipDbPush
  Only scaffold env file and skip `supabase db push` (e.g. schema already applied).

.EXAMPLE
  .\scripts\create-dev-instance.ps1 -ProjectRef "<player_pool_dev reference id>"
#>
param(
  [string]$ProjectRef = "",
  [switch]$SkipDbPush
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Get-SupabaseExecutable {
  $winCmd = Join-Path $Root "node_modules\.bin\supabase.cmd"
  if (Test-Path $winCmd) { return $winCmd }
  $unixBin = Join-Path $Root "node_modules\.bin\supabase"
  if (Test-Path $unixBin) { return $unixBin }
  if (Get-Command supabase -ErrorAction SilentlyContinue) { return "supabase" }
  return $null
}

$SbExe = Get-SupabaseExecutable
if (-not $SbExe) {
  Write-Error @"
Supabase CLI not found. From the repo root run:

  npm install

Then re-run this script (the CLI is installed as a dev dependency), or install the CLI globally on Windows:

  scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
  scoop install supabase

https://supabase.com/docs/guides/cli/getting-started
"@
}

function Invoke-Supabase {
  param([string[]]$Arguments)
  if ($SbExe -eq "supabase") {
    & supabase @Arguments
  } else {
    & $SbExe @Arguments
  }
}

if (-not (Test-Path (Join-Path $Root "supabase\config.toml"))) {
  Write-Error "Missing supabase\config.toml. Restore it from the repo or run: npm run supabase -- init"
}

if (-not $ProjectRef) {
  $ProjectRef = Read-Host "Supabase project ref for player_pool_dev (Settings → General)"
}
$ProjectRef = $ProjectRef.Trim()
if (-not $ProjectRef) {
  Write-Error "Project ref is required."
}

$envDev = Join-Path $Root ".env.development.local"
$example = Join-Path $Root "env.example"
if (-not (Test-Path $example)) {
  Write-Error "Missing env.example in repo root."
}
if (-not (Test-Path $envDev)) {
  Copy-Item $example $envDev
  Write-Host "Created $envDev from env.example — add your dev Supabase keys."
} else {
  Write-Host "Keeping existing $envDev"
}

Write-Host "Linking Supabase project $ProjectRef (this is the single CLI link for this repo folder) ..."
Invoke-Supabase -Arguments @("link", "--project-ref", $ProjectRef)

if (-not $SkipDbPush) {
  Write-Host "Pushing migrations to linked project ..."
  Invoke-Supabase -Arguments @("db", "push")
}

Write-Host @"

Next steps (development, project player_pool_dev):
  1. In Supabase Dashboard (player_pool_dev) → Settings → API, copy URL, anon key, and service_role into .env.development.local
  2. Set NEXT_PUBLIC_SITE_URL=http://localhost:3000
  3. Add redirect URLs: http://localhost:3000/auth/confirm and http://localhost:3000/join
  4. npm install && npm run dev

If db push failed on major_version: edit supabase\config.toml [db] major_version to match your hosted Postgres
(Supabase Dashboard → Database → version), then run: npm run supabase -- db push
"@
