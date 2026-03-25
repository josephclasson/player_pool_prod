<#
.SYNOPSIS
  Provisions a production Supabase-backed instance: link project, push migrations, scaffold .env.production.local.

.PARAMETER ProjectRef
  Supabase project ref for **player_pool_prod** (Dashboard → Project Settings → General — the id string, not the name). If omitted, you are prompted.

.PARAMETER SkipDbPush
  Only scaffold env file and skip `supabase db push`.

.EXAMPLE
  .\scripts\create-production-instance.ps1 -ProjectRef "<player_pool_prod reference id>"
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
  $ProjectRef = Read-Host "Supabase project ref for player_pool_prod (Settings → General)"
}
$ProjectRef = $ProjectRef.Trim()
if (-not $ProjectRef) {
  Write-Error "Project ref is required."
}

$envProd = Join-Path $Root ".env.production.local"
$example = Join-Path $Root "env.example"
if (-not (Test-Path $example)) {
  Write-Error "Missing env.example in repo root."
}
if (-not (Test-Path $envProd)) {
  Copy-Item $example $envProd
  $content = Get-Content $envProd -Raw
  $content = $content -replace "ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH=true", "ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH=false"
  $content = $content -replace "# NEXT_PUBLIC_SITE_URL=http://localhost:3000", "NEXT_PUBLIC_SITE_URL=https://your-domain.com"
  $content = $content -replace "# COMMISSIONER_API_SECRET=your-strong-shared-secret", "COMMISSIONER_API_SECRET=CHANGE_ME_STRONG_SECRET"
  [System.IO.File]::WriteAllText($envProd, $content.TrimEnd() + "`n", [System.Text.UTF8Encoding]::new($false))
  Write-Host "Created $envProd — set real NEXT_PUBLIC_SITE_URL, COMMISSIONER_API_SECRET, and Supabase keys."
} else {
  Write-Host "Keeping existing $envProd (not overwriting production secrets)."
}

Write-Host "Linking Supabase project $ProjectRef (overwrites prior supabase link in this folder) ..."
Invoke-Supabase -Arguments @("link", "--project-ref", $ProjectRef)

if (-not $SkipDbPush) {
  Write-Host "Pushing migrations to linked project ..."
  Invoke-Supabase -Arguments @("db", "push")
}

Write-Host @"

Next steps (production, project player_pool_prod):
  1. Set the same variables in your host (e.g. Vercel → Environment Variables), using keys from player_pool_prod — never commit .env.production.local
  2. NEXT_PUBLIC_SITE_URL must be your public origin (no trailing slash)
  3. Do NOT set ALLOW_COMMISSIONER_ROUTES_WITHOUT_AUTH=true or NEXT_PUBLIC_ALLOW_* in production
  4. Set COMMISSIONER_API_SECRET (create-league auto-provisions an Auth user if COMMISSIONER_LEAGUE_OWNER_USER_ID is unset)
  5. Add https://your-domain.com/auth/confirm and https://your-domain.com/join to Supabase Redirect URLs
  6. npm run build && npm run start  (or deploy via your platform)

If db push failed on major_version: edit supabase\config.toml [db] major_version to match hosted Postgres, then: npm run supabase -- db push
"@
